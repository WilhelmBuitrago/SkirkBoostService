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
    role: user.rol
  };
}

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { usuario, password } = req.body;
    if (!usuario || !password) {
      return res.status(400).json({ error: 'usuario y password son requeridos' });
    }

    const { hash, salt } = await hashPassword(password);
    const created = await pool.query(
      'INSERT INTO usuarios (usuario, password_hash, password_salt, rol) VALUES ($1, $2, $3, $4) RETURNING id, usuario, rol',
      [usuario, hash, salt, 'usuario']
    );

    req.session.user = sanitizeUser(created.rows[0]);
    return res.status(201).json({ user: req.session.user });
  } catch (error) {
    if (String(error.message || '').includes('duplicate key')) {
      return res.status(409).json({ error: 'Usuario ya existe' });
    }
    return next(error);
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { usuario, password } = req.body;
    if (!usuario || !password) {
      return res.status(400).json({ error: 'usuario y password son requeridos' });
    }

    const result = await pool.query(
      'SELECT id, usuario, rol, password_hash, password_salt FROM usuarios WHERE usuario = $1 LIMIT 1',
      [usuario]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }

    const user = result.rows[0];
    const isValid = await verifyPassword(password, user.password_salt, user.password_hash);

    if (!isValid) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }

    req.session.user = sanitizeUser(user);
    return res.json({ user: req.session.user });
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

router.get('/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ authenticated: false });
  }

  return res.json({ authenticated: true, user: req.session.user });
});

module.exports = router;
