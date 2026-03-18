const express = require('express');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');
const { getRuntimeConfig, saveRuntimeConfig } = require('../services/runtimeConfigService');
const {
  getCatalog,
  getAllServiceIds,
  updatePriceByServiceId,
  convertCopToFinalUsd,
  getUsdExchangeRate
} = require('../services/catalogService');

const router = express.Router();

const STATUS_VALUES = new Set(['ACTIVA', 'PARCIAL', 'NO_ACTIVA']);
const ROLE_VALUES = new Set(['usuario', 'administrador']);
const ORDER_STATUS_VALUES = new Set(['Cotizacion', 'En espera', 'Realizando', 'Finalizado']);
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

function mapOrderRow(row) {
  const services = Array.isArray(row.servicios) ? row.servicios : [];
  let totalUsd = 0;

  services.forEach((service) => {
    const priceCop = Number(service.priceCop);
    if (!service.isVariablePrice && Number.isFinite(priceCop) && priceCop > 0) {
      totalUsd += convertCopToFinalUsd(priceCop);
    }
  });

  return {
    id: row.id,
    usuarioId: row.usuario_id,
    usuario: row.nombre_usuario,
    email: row.correo,
    contacto: {
      plataforma: row.contacto_plataforma,
      contacto: row.contacto_valor
    },
    metodoPago: row.metodo_pago,
    services,
    totalCop: Number(row.total_cop || 0),
    totalUsd,
    exchangeRate: getUsdExchangeRate(),
    estado: row.estado,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
  let client;
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'ID de usuario invalido' });
    }

    if (req.session.user && Number(req.session.user.id) === userId) {
      return res.status(400).json({ error: 'No puedes eliminar tu propio usuario en sesion' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const targetResult = await client.query('SELECT id, rol FROM usuarios WHERE id = $1 LIMIT 1', [userId]);
    if (targetResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (targetResult.rows[0].rol === 'administrador') {
      const adminCountResult = await client.query("SELECT COUNT(*)::int AS total FROM usuarios WHERE rol = 'administrador'");
      if (adminCountResult.rows[0].total <= 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'No puedes eliminar el ultimo administrador' });
      }
    }

    const refsResult = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM orders WHERE user_id = $1) AS orders_count,
         (SELECT COUNT(*)::int FROM order_notifications WHERE user_id = $1) AS notifications_count,
         (SELECT COUNT(*)::int FROM ordenes WHERE usuario_id = $1) AS legacy_orders_count`,
      [userId]
    );

    const refs = refsResult.rows[0] || {
      orders_count: 0,
      notifications_count: 0,
      legacy_orders_count: 0
    };

    const totalRefs =
      Number(refs.orders_count || 0) +
      Number(refs.notifications_count || 0) +
      Number(refs.legacy_orders_count || 0);

    if (totalRefs > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'No puedes eliminar este usuario porque tiene pedidos o notificaciones asociadas',
        references: {
          orders: Number(refs.orders_count || 0),
          orderNotifications: Number(refs.notifications_count || 0),
          legacyOrders: Number(refs.legacy_orders_count || 0)
        }
      });
    }

    await client.query('DELETE FROM usuarios WHERE id = $1', [userId]);
    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackError) {
        // Ignore rollback errors and preserve original error handling.
      }
    }

    if (error && error.code === '23503') {
      return res.status(409).json({
        error: 'No puedes eliminar este usuario porque tiene pedidos o notificaciones asociadas'
      });
    }

    return next(error);
  } finally {
    if (client) {
      client.release();
    }
  }
});

router.get('/orders', async (req, res, next) => {
  try {
    const q = normalizeText(req.query.q).toLowerCase();
    const estado = normalizeText(req.query.estado);
    const values = [];
    const where = [];

    if (q) {
      values.push(`%${q}%`);
      const index = values.length;
      where.push(`(
        LOWER(nombre_usuario) LIKE $${index}
        OR LOWER(correo) LIKE $${index}
        OR LOWER(contacto_valor) LIKE $${index}
      )`);
    }

    if (estado) {
      if (!ORDER_STATUS_VALUES.has(estado)) {
        return res.status(400).json({ error: 'Estado de pedido invalido' });
      }
      values.push(estado);
      where.push(`estado = $${values.length}`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT id, usuario_id, correo, nombre_usuario, contacto_plataforma, contacto_valor, metodo_pago, servicios, total_cop, estado, created_at, updated_at
       FROM ordenes
       ${whereClause}
       ORDER BY created_at DESC, id DESC`,
      values
    );

    return res.json({ orders: result.rows.map(mapOrderRow) });
  } catch (error) {
    return next(error);
  }
});

router.put('/orders/:id', async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ error: 'ID de pedido invalido' });
    }

    const estado = normalizeText(req.body.estado);
    if (!ORDER_STATUS_VALUES.has(estado)) {
      return res.status(400).json({ error: 'Estado de pedido invalido' });
    }

    const result = await pool.query(
      `UPDATE ordenes
       SET estado = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING id, usuario_id, correo, nombre_usuario, contacto_plataforma, contacto_valor, metodo_pago, servicios, total_cop, estado, created_at, updated_at`,
      [estado, orderId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    return res.json({ order: mapOrderRow(result.rows[0]) });
  } catch (error) {
    return next(error);
  }
});

router.delete('/orders/:id', async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ error: 'ID de pedido invalido' });
    }

    const deleted = await pool.query(
      `DELETE FROM ordenes
       WHERE id = $1
       RETURNING id`,
      [orderId]
    );

    if (deleted.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
