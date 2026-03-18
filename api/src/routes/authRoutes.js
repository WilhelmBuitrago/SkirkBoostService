const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { hashPassword, verifyPassword } = require('../services/passwordService');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Intenta nuevamente mas tarde.' }
});

function sanitizeUser(user) {
  return {
    id: user.id,
    usuario: user.usuario,
    email: user.email || null,
    role: user.role || user.rol
  };
}

const allowedPlatforms = new Set(['whatsapp', 'tiktok', 'discord', 'instagram']);
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeIdentifier(value) {
  return String(value || '').trim();
}

function validateContacts(contacts) {
  if (!Array.isArray(contacts) || contacts.length < 1) {
    return { ok: false, error: 'Debes registrar minimo un contacto.' };
  }

  const normalized = [];
  const seen = new Set();

  for (const entry of contacts) {
    const plataforma = String(entry && entry.plataforma ? entry.plataforma : '').trim().toLowerCase();
    const contacto = String(entry && entry.contacto ? entry.contacto : '').trim();

    if (!allowedPlatforms.has(plataforma)) {
      return { ok: false, error: 'Plataforma de contacto invalida.' };
    }

    if (!contacto) {
      return { ok: false, error: 'Cada contacto debe tener valor.' };
    }

    const dedupeKey = `${plataforma}:${contacto.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    normalized.push({ plataforma, contacto });
  }

  if (normalized.length < 1) {
    return { ok: false, error: 'Debes registrar minimo un contacto.' };
  }

  return { ok: true, contacts: normalized };
}

async function getContactsByUserId(userId) {
  const contactsResult = await pool.query(
    `SELECT id, plataforma, contacto, es_principal
     FROM usuario_contactos
     WHERE usuario_id = $1
     ORDER BY es_principal DESC, id ASC`,
    [userId]
  );

  return contactsResult.rows;
}

function computeProfileState(user, contacts) {
  const missingFields = [];

  if (user.role !== 'administrador' && !user.email) {
    missingFields.push('email');
  }

  if (!Array.isArray(contacts) || contacts.length < 1) {
    missingFields.push('contactos');
  }

  return {
    profileComplete: missingFields.length === 0,
    missingFields
  };
}

async function buildAuthPayload(dbUser) {
  const safeUser = sanitizeUser(dbUser);
  const contacts = await getContactsByUserId(dbUser.id);
  const profile = computeProfileState(safeUser, contacts);

  return {
    authenticated: true,
    user: safeUser,
    contacts,
    profileComplete: profile.profileComplete,
    missingFields: profile.missingFields
  };
}

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const usuario = normalizeIdentifier(req.body.usuario);
    const validated = validateContacts(req.body.contactos);

    if (!email || !password || !usuario) {
      return res.status(400).json({ error: 'email, password y usuario son requeridos' });
    }

    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Correo invalido' });
    }

    if (!validated.ok) {
      return res.status(400).json({ error: validated.error });
    }

    const { hash, salt } = await hashPassword(password);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const created = await client.query(
        `INSERT INTO usuarios (usuario, email, password_hash, password_salt, rol)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, usuario, email, rol`,
        [usuario, email, hash, salt, 'usuario']
      );

      for (const [index, contact] of validated.contacts.entries()) {
        await client.query(
          `INSERT INTO usuario_contactos (usuario_id, plataforma, contacto, es_principal)
           VALUES ($1, $2, $3, $4)`,
          [created.rows[0].id, contact.plataforma, contact.contacto, index === 0]
        );
      }

      await client.query('COMMIT');
      req.session.user = sanitizeUser(created.rows[0]);
      const payload = await buildAuthPayload(created.rows[0]);
      return res.status(201).json(payload);
    } catch (dbError) {
      await client.query('ROLLBACK');
      throw dbError;
    } finally {
      client.release();
    }
  } catch (error) {
    const errorText = String(error.message || '');
    if (errorText.includes('idx_usuarios_email_unique')) {
      return res.status(409).json({ error: 'Correo ya registrado' });
    }
    if (errorText.includes('usuarios_usuario_key')) {
      return res.status(409).json({ error: 'Nombre de usuario ya existe' });
    }
    if (errorText.includes('duplicate key')) {
      return res.status(409).json({ error: 'Datos ya existentes' });
    }
    return next(error);
  }
});

router.post('/register/start', authLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'email y password son requeridos' });
    }

    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Correo invalido' });
    }

    const existing = await pool.query('SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'Correo ya registrado' });
    }

    req.session.registerPending = {
      email,
      password,
      createdAt: Date.now()
    };

    return res.status(200).json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/register/complete', authLimiter, async (req, res, next) => {
  try {
    const pending = req.session && req.session.registerPending;
    if (!pending || !pending.email || !pending.password) {
      return res.status(400).json({ error: 'No hay registro pendiente. Inicia desde el paso 1.' });
    }

    const ageMs = Date.now() - Number(pending.createdAt || 0);
    if (!Number.isFinite(ageMs) || ageMs > 1000 * 60 * 20) {
      req.session.registerPending = null;
      return res.status(400).json({ error: 'El registro pendiente expiro. Repite el paso 1.' });
    }

    const usuario = normalizeIdentifier(req.body.usuario);
    const validated = validateContacts(req.body.contactos);

    if (!usuario) {
      return res.status(400).json({ error: 'usuario es requerido' });
    }

    if (!validated.ok) {
      return res.status(400).json({ error: validated.error });
    }

    const { hash, salt } = await hashPassword(pending.password);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const created = await client.query(
        `INSERT INTO usuarios (usuario, email, password_hash, password_salt, rol)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, usuario, email, rol`,
        [usuario, pending.email, hash, salt, 'usuario']
      );

      for (const [index, contact] of validated.contacts.entries()) {
        await client.query(
          `INSERT INTO usuario_contactos (usuario_id, plataforma, contacto, es_principal)
           VALUES ($1, $2, $3, $4)`,
          [created.rows[0].id, contact.plataforma, contact.contacto, index === 0]
        );
      }

      await client.query('COMMIT');
      req.session.registerPending = null;
      req.session.user = sanitizeUser(created.rows[0]);
      const payload = await buildAuthPayload(created.rows[0]);
      return res.status(201).json(payload);
    } catch (dbError) {
      await client.query('ROLLBACK');
      throw dbError;
    } finally {
      client.release();
    }
  } catch (error) {
    const errorText = String(error.message || '');
    if (errorText.includes('idx_usuarios_email_unique')) {
      return res.status(409).json({ error: 'Correo ya registrado' });
    }
    if (errorText.includes('usuarios_usuario_key')) {
      return res.status(409).json({ error: 'Nombre de usuario ya existe' });
    }
    if (errorText.includes('duplicate key')) {
      return res.status(409).json({ error: 'Datos ya existentes' });
    }
    return next(error);
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const identifier = normalizeIdentifier(req.body.identifier || req.body.usuario || req.body.email);
    const password = String(req.body.password || '');
    if (!identifier || !password) {
      return res.status(400).json({ error: 'identifier y password son requeridos' });
    }

    const seemsEmail = identifier.includes('@');
    let result;
    let usedField;

    if (seemsEmail) {
      result = await pool.query(
        'SELECT id, usuario, email, rol, password_hash, password_salt FROM usuarios WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [identifier]
      );
      usedField = 'email';

      if (result.rowCount === 0) {
        result = await pool.query(
          'SELECT id, usuario, email, rol, password_hash, password_salt FROM usuarios WHERE usuario = $1 LIMIT 1',
          [identifier]
        );
        usedField = 'usuario';
      }
    } else {
      result = await pool.query(
        'SELECT id, usuario, email, rol, password_hash, password_salt FROM usuarios WHERE usuario = $1 LIMIT 1',
        [identifier]
      );
      usedField = 'usuario';

      if (result.rowCount === 0) {
        result = await pool.query(
          'SELECT id, usuario, email, rol, password_hash, password_salt FROM usuarios WHERE LOWER(email) = LOWER($1) LIMIT 1',
          [identifier]
        );
        usedField = 'email';
      }
    }

    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }

    const user = result.rows[0];

    if (user.rol === 'administrador' && usedField !== 'usuario') {
      return res.status(401).json({ error: 'El administrador debe ingresar con usuario.' });
    }

    if (user.rol !== 'administrador' && usedField !== 'email') {
      return res.status(401).json({ error: 'Para cuentas cliente debes ingresar con correo.' });
    }

    const isValid = await verifyPassword(password, user.password_salt, user.password_hash);

    if (!isValid) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }

    req.session.user = sanitizeUser(user);
    const payload = await buildAuthPayload(user);
    return res.json(payload);
  } catch (error) {
    return next(error);
  }
});

router.post('/logout', (req, res) => {
  const isProduction = process.env.NODE_ENV === 'production';
  req.session.destroy(() => {
    res.clearCookie('sid', {
      httpOnly: true,
      sameSite: isProduction ? 'none' : 'lax',
      secure: isProduction
    });
    res.json({ ok: true });
  });
});

router.get('/me', (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ authenticated: false });
  }

  return buildAuthPayload(req.session.user)
    .then((payload) => res.json(payload))
    .catch((error) => {
      return next(error);
    });
});

router.get('/contacts', async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const contacts = await getContactsByUserId(req.session.user.id);
  return res.json({ contacts });
});

module.exports = router;
