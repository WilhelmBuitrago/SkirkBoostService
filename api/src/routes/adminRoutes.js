const express = require('express');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');
const { getRuntimeConfig, saveRuntimeConfig } = require('../services/runtimeConfigService');
const { getCatalog, getAllServiceIds, updatePriceByServiceId } = require('../services/catalogService');

const router = express.Router();

const STATUS_VALUES = new Set(['ACTIVA', 'PARCIAL', 'NO_ACTIVA']);
const ROLE_VALUES = new Set(['usuario', 'administrador']);
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function mapUserRow(row) {
  return {
    id: row.id,
    usuario: row.usuario,
    email: row.email,
    role: row.rol,
    createdAt: row.created_at
  };
}

router.use(requireAdmin);

router.get('/config', async (req, res, next) => {
  try {
    const runtimeConfig = getRuntimeConfig();
    const catalog = getCatalog(runtimeConfig);
    const usersResult = await pool.query(
      `SELECT id, usuario, email, rol, created_at
       FROM usuarios
       ORDER BY created_at DESC, id DESC`
    );

    res.json({
      runtimeConfig,
      allServiceIds: getAllServiceIds(),
      catalog,
      users: usersResult.rows.map(mapUserRow),
      canEdit: true,
      user: req.session.user
    });
  } catch (error) {
    next(error);
  }
});

router.put('/status', (req, res, next) => {
  try {
    const { status } = req.body;
    if (!STATUS_VALUES.has(status)) {
      return res.status(400).json({ error: 'Estado invalido' });
    }

    const current = getRuntimeConfig();
    const saved = saveRuntimeConfig(
      {
        platformStatus: status,
        disabledServiceIds: current.disabledServiceIds
      },
      req.session.user.usuario
    );

    return res.json({ runtimeConfig: saved });
  } catch (error) {
    return next(error);
  }
});

router.put('/availability', (req, res, next) => {
  try {
    const { disabledServiceIds } = req.body;
    if (!Array.isArray(disabledServiceIds)) {
      return res.status(400).json({ error: 'disabledServiceIds debe ser un array' });
    }

    const allowed = new Set(getAllServiceIds());
    const invalid = disabledServiceIds.filter((id) => !allowed.has(id));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Service IDs invalidos: ${invalid.join(', ')}` });
    }

    const current = getRuntimeConfig();
    const saved = saveRuntimeConfig(
      {
        platformStatus: current.platformStatus,
        disabledServiceIds
      },
      req.session.user.usuario
    );

    return res.json({ runtimeConfig: saved });
  } catch (error) {
    return next(error);
  }
});

router.put('/price', (req, res, next) => {
  try {
    const { serviceId, priceCop } = req.body;
    if (!serviceId || typeof priceCop === 'undefined') {
      return res.status(400).json({ error: 'serviceId y priceCop son requeridos' });
    }

    updatePriceByServiceId(serviceId, priceCop);

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

router.get('/users', async (req, res, next) => {
  try {
    const q = normalizeText(req.query.q).toLowerCase();
    const usersResult = await pool.query(
      `SELECT id, usuario, email, rol, created_at
       FROM usuarios
       ORDER BY created_at DESC, id DESC`
    );

    const users = usersResult.rows
      .map(mapUserRow)
      .filter((entry) => {
        if (!q) {
          return true;
        }

        return (
          String(entry.usuario || '').toLowerCase().includes(q) ||
          String(entry.email || '').toLowerCase().includes(q) ||
          String(entry.role || '').toLowerCase().includes(q)
        );
      });

    return res.json({ users });
  } catch (error) {
    return next(error);
  }
});

router.put('/users/:id', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'ID de usuario invalido' });
    }

    const usuario = normalizeText(req.body.usuario);
    const role = normalizeText(req.body.role).toLowerCase();
    const emailInput = normalizeEmail(req.body.email);
    const email = emailInput || null;

    if (!usuario || !ROLE_VALUES.has(role)) {
      return res.status(400).json({ error: 'usuario y role validos son requeridos' });
    }

    if (role !== 'administrador') {
      if (!email || !emailRegex.test(email)) {
        return res.status(400).json({ error: 'El usuario cliente debe tener correo valido' });
      }
    }

    const currentResult = await pool.query('SELECT id, rol FROM usuarios WHERE id = $1 LIMIT 1', [userId]);
    if (currentResult.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const current = currentResult.rows[0];
    if (current.rol === 'administrador' && role !== 'administrador') {
      const adminCountResult = await pool.query("SELECT COUNT(*)::int AS total FROM usuarios WHERE rol = 'administrador'");
      if (adminCountResult.rows[0].total <= 1) {
        return res.status(400).json({ error: 'No puedes quitar el ultimo administrador' });
      }
    }

    const updated = await pool.query(
      `UPDATE usuarios
       SET usuario = $1,
           email = $2,
           rol = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, usuario, email, rol, created_at`,
      [usuario, email, role, userId]
    );

    return res.json({ user: mapUserRow(updated.rows[0]) });
  } catch (error) {
    if (String(error.message || '').includes('duplicate key')) {
      return res.status(409).json({ error: 'Usuario o correo ya existe' });
    }
    return next(error);
  }
});

router.delete('/users/:id', async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'ID de usuario invalido' });
    }

    if (req.session.user && Number(req.session.user.id) === userId) {
      return res.status(400).json({ error: 'No puedes eliminar tu propio usuario en sesion' });
    }

    const targetResult = await pool.query('SELECT id, rol FROM usuarios WHERE id = $1 LIMIT 1', [userId]);
    if (targetResult.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (targetResult.rows[0].rol === 'administrador') {
      const adminCountResult = await pool.query("SELECT COUNT(*)::int AS total FROM usuarios WHERE rol = 'administrador'");
      if (adminCountResult.rows[0].total <= 1) {
        return res.status(400).json({ error: 'No puedes eliminar el ultimo administrador' });
      }
    }

    await pool.query('DELETE FROM usuarios WHERE id = $1', [userId]);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
