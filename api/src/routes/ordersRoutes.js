const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { convertCopToFinalUsd, getUsdExchangeRate } = require('../services/catalogService');

const router = express.Router();
const allowedPayment = new Set(['Nequi', 'PayPal']);
const ORDER_STATUS_VALUES = new Set(['Cotizacion', 'En espera', 'Realizando', 'Finalizado']);
const INITIAL_ORDER_STATUS = 'Cotizacion';

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

function mapOrderRow(row) {
  const services = Array.isArray(row.servicios) ? row.servicios : [];
  const totalCop = Number(row.total_cop || 0);
  const totalUsd = calculateOrderTotalUsd(services);

  return {
    id: row.id,
    email: row.correo,
    usuario: row.nombre_usuario,
    contacto: {
      plataforma: row.contacto_plataforma,
      contacto: row.contacto_valor
    },
    metodoPago: row.metodo_pago,
    services,
    totalCop,
    totalUsd,
    exchangeRate: getUsdExchangeRate(),
    estado: ORDER_STATUS_VALUES.has(row.estado) ? row.estado : INITIAL_ORDER_STATUS,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
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

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.user.id;
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

    const servicios = Array.isArray(req.body.servicios) ? req.body.servicios : [];
    const contactoIdRaw = Number(req.body.contactoId);
    const metodoPago = String(req.body.metodoPago || '').trim();

    if (servicios.length < 1) {
      return res.status(400).json({ error: 'Debes agregar al menos un servicio.' });
    }

    if (!Number.isInteger(contactoIdRaw) || contactoIdRaw <= 0) {
      return res.status(400).json({ error: 'Contacto invalido.' });
    }

    if (!allowedPayment.has(metodoPago)) {
      return res.status(400).json({ error: 'Metodo de pago invalido.' });
    }

    const selectedContact = state.contacts.find((entry) => entry.id === contactoIdRaw);
    if (!selectedContact) {
      return res.status(400).json({ error: 'El contacto seleccionado no existe.' });
    }

    const sanitizedServices = servicios
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

    if (sanitizedServices.length < 1) {
      return res.status(400).json({ error: 'No hay servicios validos para confirmar.' });
    }

    const seenServiceIds = new Set();
    for (const service of sanitizedServices) {
      if (seenServiceIds.has(service.serviceId)) {
        return res.status(400).json({
          error: `No puedes pedir dos veces el mismo servicio en una sola orden (${service.label}).`
        });
      }
      seenServiceIds.add(service.serviceId);
    }

    let totalCop = 0;
    for (const service of sanitizedServices) {
      if (Number.isFinite(service.priceCop)) {
        totalCop += Math.round(service.priceCop);
      }
    }
    const totalUsd = calculateOrderTotalUsd(sanitizedServices);

    const insertResult = await pool.query(
      `INSERT INTO ordenes
       (usuario_id, correo, nombre_usuario, contacto_plataforma, contacto_valor, metodo_pago, servicios, total_cop, estado, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, NOW())
       RETURNING id, created_at, updated_at, estado`,
      [
        state.user.id,
        state.user.email,
        state.user.usuario,
        selectedContact.plataforma,
        selectedContact.contacto,
        metodoPago,
        JSON.stringify(sanitizedServices),
        totalCop,
        INITIAL_ORDER_STATUS
      ]
    );

    return res.status(201).json({
      order: {
        id: insertResult.rows[0].id,
        createdAt: insertResult.rows[0].created_at,
        services: sanitizedServices,
        email: state.user.email,
        usuario: state.user.usuario,
        contacto: {
          id: selectedContact.id,
          plataforma: selectedContact.plataforma,
          contacto: selectedContact.contacto
        },
        metodoPago,
        totalCop,
        totalUsd,
        exchangeRate: getUsdExchangeRate(),
        estado: insertResult.rows[0].estado,
        updatedAt: insertResult.rows[0].updated_at
      }
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.user.id;
    const result = await pool.query(
      `SELECT id, correo, nombre_usuario, contacto_plataforma, contacto_valor, metodo_pago, servicios, total_cop, estado, created_at, updated_at
       FROM ordenes
       WHERE usuario_id = $1
       ORDER BY created_at DESC, id DESC`,
      [userId]
    );

    return res.json({ orders: result.rows.map(mapOrderRow) });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ error: 'ID de pedido invalido.' });
    }

    const userId = req.session.user.id;
    const result = await pool.query(
      `SELECT id, correo, nombre_usuario, contacto_plataforma, contacto_valor, metodo_pago, servicios, total_cop, estado, created_at, updated_at
       FROM ordenes
       WHERE id = $1 AND usuario_id = $2
       LIMIT 1`,
      [orderId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado.' });
    }

    return res.json({ order: mapOrderRow(result.rows[0]) });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
