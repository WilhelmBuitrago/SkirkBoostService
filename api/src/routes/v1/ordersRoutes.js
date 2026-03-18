const express = require('express');
const pool = require('../../db/pool');
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const { convertCopToFinalUsd, getUsdExchangeRate } = require('../../services/catalogService');
const {
  ORDER_STATUS,
  createOrder,
  listOrdersByUser,
  listOrdersForAdmin,
  getOrderForAdmin,
  getOrderForUser,
  deleteOrderById,
  listActiveRetries,
  listFinalFailures,
  updateOrderStatus
} = require('../../services/v1/ordersDomainService');

const router = express.Router();

const UPDATE_ALLOWED_STATUS = new Set([
  ORDER_STATUS.IN_PROGRESS,
  ORDER_STATUS.COMPLETED,
  ORDER_STATUS.CANCELLED
]);

const ALLOWED_PAYMENT = new Set(['Nequi', 'PayPal']);

const LEGACY_STATUS_BY_V1 = {
  PENDING: 'En espera',
  NOTIFIED: 'En espera',
  IN_PROGRESS: 'Realizando',
  COMPLETED: 'Finalizado',
  FAILED_NOTIFY: 'Cotizacion',
  CANCELLED: 'Cancelado'
};

function toLegacyStatus(status) {
  return LEGACY_STATUS_BY_V1[status] || status;
}

function calculateOrderTotalUsd(services) {
  let totalUsd = 0;

  services.forEach((service) => {
    const priceCop = Number(service.priceCop);
    if (!service.isVariablePrice && Number.isFinite(priceCop) && priceCop > 0) {
      totalUsd += convertCopToFinalUsd(priceCop);
    }
  });

  return totalUsd;
}

async function getProfileState(userId, role) {
  const userResult = await pool.query('SELECT id, usuario, email, rol FROM usuarios WHERE id = $1 LIMIT 1', [userId]);
  if (userResult.rowCount === 0) {
    return null;
  }

  const user = userResult.rows[0];
  const contactsResult = await pool.query(
    `SELECT id, plataforma, contacto, es_principal
     FROM usuario_contactos
     WHERE usuario_id = $1
     ORDER BY es_principal DESC, id ASC`,
    [userId]
  );

  const contacts = contactsResult.rows;
  const missingFields = [];

  if (role !== 'administrador' && !user.email) {
    missingFields.push('email');
  }
  if (contacts.length < 1) {
    missingFields.push('contactos');
  }

  return {
    user,
    contacts,
    profileComplete: missingFields.length === 0,
    missingFields
  };
}

function sanitizeServices(servicios) {
  const list = Array.isArray(servicios) ? servicios : [];
  return list
    .map((entry) => ({
      id: String(entry.id || ''),
      serviceId: String(entry.serviceId || ''),
      label: String(entry.label || ''),
      isVariablePrice: Boolean(entry.isVariablePrice),
      priceRangeCop: String(entry.priceRangeCop || ''),
      priceCop: entry.priceCop === null ? null : Number(entry.priceCop || 0)
    }))
    .filter((entry) => {
      if (!entry.serviceId || !entry.label) {
        return false;
      }

      if (entry.isVariablePrice) {
        entry.priceCop = null;
        return true;
      }

      return Number.isFinite(entry.priceCop) && entry.priceCop > 0;
    });
}

function validateNoDuplicatesByServiceId(services) {
  const seenServiceIds = new Set();
  for (const service of services) {
    if (seenServiceIds.has(service.serviceId)) {
      return service.label;
    }
    seenServiceIds.add(service.serviceId);
  }

  return null;
}

function mapJoinedToLegacyOrder(item) {
  const contact = item.order.contacto || null;

  return {
    id: item.order.orderId,
    email: item.email || null,
    usuario: item.usuario || null,
    contacto: contact
      ? {
        plataforma: contact.plataforma,
        contacto: contact.contacto
      }
      : null,
    metodoPago: item.order.metodoPago || null,
    services: Array.isArray(item.order.services) ? item.order.services : [],
    estado: toLegacyStatus(item.order.status),
    totalCop: item.order.totalCop,
    totalUsd: item.order.totalUsd,
    exchangeRate: getUsdExchangeRate(),
    createdAt: item.order.createdAt,
    updatedAt: item.order.updatedAt,
    notification: item.notification
  };
}

function parseCreatePayload(body) {
  const legacyServices = Array.isArray(body.servicios) ? body.servicios : null;
  if (legacyServices && legacyServices.length > 0) {
    return {
      mode: 'legacy',
      value: {
        servicios: legacyServices,
        contactoId: Number(body.contactoId),
        metodoPago: String(body.metodoPago || '').trim(),
        idempotencyKey: body.idempotencyKey == null ? null : String(body.idempotencyKey).trim()
      }
    };
  }

  const totalCop = Number(body.totalCop);
  const totalUsdRaw = body.totalUsd;
  const totalUsd = Number(totalUsdRaw);

  if (!Number.isFinite(totalCop) || totalCop < 0) {
    return { error: 'totalCop must be a non-negative number.' };
  }

  if (!Number.isFinite(totalUsd) || totalUsd < 0) {
    return { error: 'totalUsd must be a non-negative number.' };
  }

  const idempotencyKey = body.idempotencyKey == null ? null : String(body.idempotencyKey).trim();
  if (idempotencyKey && idempotencyKey.length > 128) {
    return { error: 'idempotencyKey max length is 128.' };
  }

  return {
    mode: 'v1',
    value: {
      totalCop: Math.round(totalCop),
      totalUsd,
      idempotencyKey: idempotencyKey || null
    }
  };
}

router.post('/orders', requireAuth, async (req, res, next) => {
  try {
    const parsed = parseCreatePayload(req.body || {});
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    const userId = Number(req.session.user.id);

    if (parsed.mode === 'legacy') {
      const sessionRole = req.session.user.role;
      const state = await getProfileState(userId, sessionRole);
      if (!state) {
        return res.status(401).json({ error: 'Sesion invalida' });
      }

      if (!state.profileComplete) {
        return res.status(403).json({
          error: 'Perfil incompleto. Debes completar correo y al menos un contacto.',
          missingFields: state.missingFields
        });
      }

      if (!Number.isInteger(parsed.value.contactoId) || parsed.value.contactoId <= 0) {
        return res.status(400).json({ error: 'Contacto invalido.' });
      }

      if (!ALLOWED_PAYMENT.has(parsed.value.metodoPago)) {
        return res.status(400).json({ error: 'Metodo de pago invalido.' });
      }

      const selectedContact = state.contacts.find((entry) => entry.id === parsed.value.contactoId);
      if (!selectedContact) {
        return res.status(400).json({ error: 'El contacto seleccionado no existe.' });
      }

      const sanitizedServices = sanitizeServices(parsed.value.servicios);
      if (sanitizedServices.length < 1) {
        return res.status(400).json({ error: 'No hay servicios validos para confirmar.' });
      }

      const duplicateLabel = validateNoDuplicatesByServiceId(sanitizedServices);
      if (duplicateLabel) {
        return res.status(400).json({
          error: `No puedes pedir dos veces el mismo servicio en una sola orden (${duplicateLabel}).`
        });
      }

      let totalCop = 0;
      for (const service of sanitizedServices) {
        if (Number.isFinite(service.priceCop)) {
          totalCop += Math.round(service.priceCop);
        }
      }
      const totalUsd = calculateOrderTotalUsd(sanitizedServices);

      const result = await createOrder({
        userId,
        totalCop,
        totalUsd,
        contactoId: selectedContact.id,
        metodoPago: parsed.value.metodoPago,
        services: sanitizedServices,
        idempotencyKey: parsed.value.idempotencyKey || req.headers['x-idempotency-key'] || null
      });

      const statusCode = result.created ? 201 : 200;
      const storedContact = result.order.contacto || {
        id: selectedContact.id,
        plataforma: selectedContact.plataforma,
        contacto: selectedContact.contacto
      };
      const storedServices = Array.isArray(result.order.services) && result.order.services.length > 0
        ? result.order.services
        : sanitizedServices;

      return res.status(statusCode).json({
        order: {
          id: result.order.orderId,
          createdAt: result.order.createdAt,
          services: storedServices,
          email: state.user.email,
          usuario: state.user.usuario,
          contacto: {
            id: storedContact.id,
            plataforma: storedContact.plataforma,
            contacto: storedContact.contacto
          },
          metodoPago: result.order.metodoPago || parsed.value.metodoPago,
          totalCop: result.order.totalCop,
          totalUsd: result.order.totalUsd,
          exchangeRate: getUsdExchangeRate(),
          estado: toLegacyStatus(result.order.status),
          updatedAt: result.order.updatedAt
        },
        orderV1: result.order,
        notification: result.notification,
        dispatch: result.dispatch || { attempted: false }
      });
    }

    const result = await createOrder({
      userId,
      totalCop: parsed.value.totalCop,
      totalUsd: parsed.value.totalUsd,
      idempotencyKey: parsed.value.idempotencyKey || req.headers['x-idempotency-key'] || null
    });

    const statusCode = result.created ? 201 : 200;
    return res.status(statusCode).json(result);
  } catch (error) {
    return next(error);
  }
});

router.get('/orders', requireAuth, async (req, res, next) => {
  try {
    const userId = Number(req.session.user.id);
    const items = await listOrdersByUser(userId);
    return res.json({
      orders: items.map(mapJoinedToLegacyOrder),
      ordersV1: items
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/orders/notifications/retries/active', requireAdmin, async (req, res, next) => {
  try {
    const items = await listActiveRetries(req.query.limit);
    return res.json({ retries: items });
  } catch (error) {
    return next(error);
  }
});

router.get('/orders/admin', requireAdmin, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim().toUpperCase();
    const items = await listOrdersForAdmin({ q, status, limit: req.query.limit });
    return res.json({ orders: items });
  } catch (error) {
    return next(error);
  }
});

router.get('/orders/notifications/failures/final', requireAdmin, async (req, res, next) => {
  try {
    const items = await listFinalFailures(req.query.limit);
    return res.json({ failures: items });
  } catch (error) {
    return next(error);
  }
});

router.get('/orders/:orderId', requireAuth, async (req, res, next) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required.' });
    }

    const isAdmin = req.session.user.role === 'administrador';
    const userId = Number(req.session.user.id);
    const item = await getOrderForUser(orderId, userId, isAdmin);
    if (!item) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    return res.json({
      order: mapJoinedToLegacyOrder(item),
      orderV1: item.order,
      notification: item.notification
    });
  } catch (error) {
    return next(error);
  }
});

router.patch('/orders/:orderId/status', requireAdmin, async (req, res, next) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    const status = String(req.body.status || '').trim().toUpperCase();

    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required.' });
    }

    if (!UPDATE_ALLOWED_STATUS.has(status)) {
      return res.status(400).json({
        error: 'Invalid status transition target.',
        allowed: Array.from(UPDATE_ALLOWED_STATUS)
      });
    }

    const updated = await updateOrderStatus(orderId, status);
    if (!updated) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    return res.json({ order: updated });
  } catch (error) {
    return next(error);
  }
});

router.patch('/orders/admin/:orderId/status', requireAdmin, async (req, res, next) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    const status = String(req.body.status || '').trim().toUpperCase();

    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required.' });
    }

    if (!UPDATE_ALLOWED_STATUS.has(status)) {
      return res.status(400).json({
        error: 'Invalid status transition target.',
        allowed: Array.from(UPDATE_ALLOWED_STATUS)
      });
    }

    const updated = await updateOrderStatus(orderId, status);
    if (!updated) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const item = await getOrderForAdmin(orderId);
    return res.json({ order: item });
  } catch (error) {
    return next(error);
  }
});

router.delete('/orders/admin/:orderId', requireAdmin, async (req, res, next) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required.' });
    }

    const deleted = await deleteOrderById(orderId);
    if (!deleted) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
