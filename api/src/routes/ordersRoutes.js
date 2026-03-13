const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const allowedPayment = new Set(['Nequi', 'PayPal']);

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

    let totalCop = 0;
    const sanitizedServices = servicios
      .map((entry) => ({
        id: String(entry.id || ''),
        serviceId: String(entry.serviceId || ''),
        label: String(entry.label || ''),
        priceCop: Number(entry.priceCop || 0)
      }))
      .filter((entry) => entry.label && Number.isFinite(entry.priceCop) && entry.priceCop > 0);

    if (sanitizedServices.length < 1) {
      return res.status(400).json({ error: 'No hay servicios validos para confirmar.' });
    }

    for (const service of sanitizedServices) {
      totalCop += Math.round(service.priceCop);
    }

    const insertResult = await pool.query(
      `INSERT INTO ordenes
       (usuario_id, correo, nombre_usuario, contacto_plataforma, contacto_valor, metodo_pago, servicios, total_cop)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING id, created_at`,
      [
        state.user.id,
        state.user.email,
        state.user.usuario,
        selectedContact.plataforma,
        selectedContact.contacto,
        metodoPago,
        JSON.stringify(sanitizedServices),
        totalCop
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
        totalCop
      }
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
