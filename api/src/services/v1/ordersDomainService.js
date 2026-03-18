const { randomUUID } = require('crypto');
const pool = require('../../db/pool');
const { notifyOrderForDmV1 } = require('../disbotService');

const ORDER_STATUS = {
  PENDING: 'PENDING',
  NOTIFIED: 'NOTIFIED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED_NOTIFY: 'FAILED_NOTIFY',
  CANCELLED: 'CANCELLED'
};

const NOTIFICATION_STATUS = {
  PENDING: 'pending',
  RETRY: 'retry',
  SENT: 'sent',
  FAILED: 'failed'
};

const TERMINAL_NOTIFICATION_STATUS = new Set([NOTIFICATION_STATUS.SENT, NOTIFICATION_STATUS.FAILED]);
const ORDER_MUTABLE_STATUS = new Set([
  ORDER_STATUS.PENDING,
  ORDER_STATUS.NOTIFIED,
  ORDER_STATUS.IN_PROGRESS,
  ORDER_STATUS.COMPLETED,
  ORDER_STATUS.FAILED_NOTIFY,
  ORDER_STATUS.CANCELLED
]);

const MAX_RETRIES = Math.max(0, Number(process.env.ORDER_NOTIFY_MAX_RETRIES) || 5);
const RETRY_BASE_DELAY_SECONDS = Math.max(1, Number(process.env.ORDER_NOTIFY_RETRY_BASE_SECONDS) || 30);
const SCHEDULER_BATCH_SIZE = Math.max(1, Number(process.env.ORDER_NOTIFY_BATCH_SIZE) || 25);

function parseMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return null;
  }

  return Math.round(num * 100) / 100;
}

function parseCop(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return null;
  }

  return Math.round(num);
}

function normalizePaymentMethod(value) {
  const parsed = String(value || '').trim();
  if (!parsed) {
    return null;
  }

  return parsed.slice(0, 50);
}

function sanitizeOrderItems(services) {
  const list = Array.isArray(services) ? services : [];

  return list
    .map((entry) => {
      const serviceId = String((entry && entry.serviceId) || '').trim().slice(0, 120);
      const label = String((entry && entry.label) || '').trim().slice(0, 255);
      const isVariablePrice = Boolean(entry && entry.isVariablePrice);
      const priceRangeCop = String((entry && entry.priceRangeCop) || '').trim().slice(0, 100);

      let priceCop = null;
      if (!isVariablePrice) {
        const parsed = parseCop(entry && entry.priceCop);
        if (parsed !== null) {
          priceCop = parsed;
        }
      }

      return {
        serviceId,
        label,
        isVariablePrice,
        priceRangeCop,
        priceCop
      };
    })
    .filter((entry) => {
      if (!entry.serviceId || !entry.label) {
        return false;
      }

      if (entry.isVariablePrice) {
        return true;
      }

      return Number.isInteger(entry.priceCop) && entry.priceCop > 0;
    });
}

function parseContactId(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function parseLegacyServices(rawServices) {
  const list = Array.isArray(rawServices) ? rawServices : [];

  return list
    .map((entry) => ({
      serviceId: String((entry && (entry.serviceId || entry.id)) || '').trim(),
      label: String((entry && entry.label) || '').trim(),
      isVariablePrice: Boolean(entry && entry.isVariablePrice),
      priceRangeCop: String((entry && entry.priceRangeCop) || '').trim(),
      priceCop: entry && entry.priceCop != null ? parseCop(entry.priceCop) : null
    }))
    .filter((entry) => {
      if (!entry.serviceId || !entry.label) {
        return false;
      }

      if (entry.isVariablePrice) {
        entry.priceCop = null;
      }

      return true;
    });
}

function toLegacyState(status) {
  const map = {
    PENDING: 'En espera',
    NOTIFIED: 'En espera',
    IN_PROGRESS: 'Realizando',
    COMPLETED: 'Finalizado',
    FAILED_NOTIFY: 'Cotizacion',
    CANCELLED: 'Cancelado'
  };

  return map[status] || status || 'Cotizacion';
}

function delaySecondsForRetry(retryCount) {
  return RETRY_BASE_DELAY_SECONDS * (2 ** Math.max(0, retryCount));
}

function classifyNotificationError(error) {
  const message = String((error && error.message) || '').toLowerCase();

  if (!message) {
    return { temporary: true, reason: 'unknown_error' };
  }

  if (
    message.includes('timeout')
    || message.includes('timed out')
    || message.includes('network')
    || message.includes('fetch')
    || message.includes('503')
    || message.includes('502')
    || message.includes('500')
    || message.includes('429')
  ) {
    return { temporary: true, reason: 'temporary_upstream_failure' };
  }

  return { temporary: false, reason: 'permanent_upstream_failure' };
}

async function createOrder({
  userId,
  totalCop,
  totalUsd,
  idempotencyKey = null,
  contactoId = null,
  metodoPago = null,
  services = []
}) {
  const parsedCop = parseCop(totalCop);
  const parsedUsd = parseMoney(totalUsd);

  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('Invalid userId.');
  }
  if (parsedCop === null) {
    throw new Error('Invalid totalCop.');
  }
  if (parsedUsd === null) {
    throw new Error('Invalid totalUsd.');
  }

  const client = await pool.connect();
  const normalizedIdempotencyKey = idempotencyKey ? String(idempotencyKey).trim() : null;
  const normalizedContactId = parseContactId(contactoId);
  const normalizedMetodoPago = normalizePaymentMethod(metodoPago);
  const normalizedServices = sanitizeOrderItems(services);

  try {
    await client.query('BEGIN');

    if (normalizedIdempotencyKey) {
      const existingOrder = await client.query(
        `SELECT order_id, user_id, status, total_cop, total_usd, idempotency_key, contacto_id, metodo_pago, created_at, updated_at
         FROM orders
         WHERE user_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [userId, normalizedIdempotencyKey]
      );

      if (existingOrder.rowCount > 0) {
        const [itemsResult, contactResult] = await Promise.all([
          client.query(
            `SELECT service_id, label, is_variable_price, price_range_cop, price_cop
             FROM order_items
             WHERE order_id = $1
             ORDER BY id ASC`,
            [existingOrder.rows[0].order_id]
          ),
          client.query(
            `SELECT id, plataforma, contacto
             FROM usuario_contactos
             WHERE id = $1
             LIMIT 1`,
            [existingOrder.rows[0].contacto_id]
          )
        ]);

        const notification = await client.query(
          `SELECT order_id, status, retry_count, next_retry_at, last_error, completed_at, created_at, updated_at
           FROM order_notifications
           WHERE order_id = $1
           LIMIT 1`,
          [existingOrder.rows[0].order_id]
        );

        await client.query('COMMIT');
        return {
          created: false,
          order: mapOrderRow(existingOrder.rows[0], {
            services: itemsResult.rows.map(mapOrderItemRow),
            contacto: mapContactRow(contactResult.rows[0] || null)
          }),
          notification: mapNotificationRow(notification.rows[0] || null)
        };
      }
    }

    const orderId = randomUUID();

    const orderResult = await client.query(
      `INSERT INTO orders (order_id, user_id, status, total_cop, total_usd, idempotency_key, contacto_id, metodo_pago, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING order_id, user_id, status, total_cop, total_usd, idempotency_key, contacto_id, metodo_pago, created_at, updated_at`,
      [
        orderId,
        userId,
        ORDER_STATUS.PENDING,
        parsedCop,
        parsedUsd,
        normalizedIdempotencyKey,
        normalizedContactId,
        normalizedMetodoPago
      ]
    );

    if (normalizedServices.length > 0) {
      for (const service of normalizedServices) {
        await client.query(
          `INSERT INTO order_items (order_id, service_id, label, is_variable_price, price_range_cop, price_cop)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            orderId,
            service.serviceId,
            service.label,
            service.isVariablePrice,
            service.priceRangeCop,
            service.priceCop
          ]
        );
      }
    }

    const notificationResult = await client.query(
      `INSERT INTO order_notifications (order_id, user_id, status, retry_count, updated_at)
       VALUES ($1, $2, $3, 0, NOW())
       RETURNING order_id, status, retry_count, next_retry_at, last_error, completed_at, created_at, updated_at`,
      [orderId, userId, NOTIFICATION_STATUS.PENDING]
    );

    await client.query('COMMIT');

    const immediateResult = await attemptNotification(orderId);

    return {
      created: true,
      order: immediateResult.order,
      notification: immediateResult.notification,
      dispatch: immediateResult.dispatch
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function attemptNotification(orderId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT o.order_id, o.user_id, o.status AS order_status, o.total_cop, o.total_usd,
              o.created_at AS order_created_at, o.updated_at AS order_updated_at,
              n.status AS notification_status, n.retry_count, n.next_retry_at, n.last_error,
              n.completed_at, n.created_at AS notification_created_at, n.updated_at AS notification_updated_at
       FROM orders o
       INNER JOIN order_notifications n ON n.order_id = o.order_id
       WHERE o.order_id = $1
       FOR UPDATE OF n`,
      [orderId]
    );

    if (result.rowCount === 0) {
      throw new Error('Order not found.');
    }

    const row = result.rows[0];

    if (TERMINAL_NOTIFICATION_STATUS.has(row.notification_status)) {
      await client.query('COMMIT');
      return {
        order: mapOrderRowFromJoin(row),
        notification: mapNotificationRowFromJoin(row),
        dispatch: {
          attempted: false,
          success: row.notification_status === NOTIFICATION_STATUS.SENT,
          reason: 'already_finalized'
        }
      };
    }

    const notificationPayload = await buildNotificationPayload(client, row.order_id);
    const dispatch = await notifyOrderForDmV1(notificationPayload);

    if (dispatch.success) {
      const updated = await client.query(
        `UPDATE order_notifications
         SET status = $2,
             completed_at = NOW(),
             last_error = NULL,
             next_retry_at = NULL,
             updated_at = NOW()
         WHERE order_id = $1
         RETURNING order_id, status, retry_count, next_retry_at, last_error, completed_at, created_at, updated_at`,
        [orderId, NOTIFICATION_STATUS.SENT]
      );

      const orderUpdate = await client.query(
        `UPDATE orders
         SET status = $2,
             updated_at = NOW()
         WHERE order_id = $1
         RETURNING order_id, user_id, status, total_cop, total_usd, idempotency_key, created_at, updated_at`,
        [orderId, ORDER_STATUS.NOTIFIED]
      );

      await client.query('COMMIT');
      return {
        order: mapOrderRow(orderUpdate.rows[0]),
        notification: mapNotificationRow(updated.rows[0]),
        dispatch: { attempted: true, success: true }
      };
    }

    const classification = classifyNotificationError(new Error(dispatch.error || 'notification_failed'));
    const nextRetryCount = Number(row.retry_count) + 1;

    if (!classification.temporary || nextRetryCount > MAX_RETRIES) {
      const updated = await client.query(
        `UPDATE order_notifications
         SET status = $2,
             retry_count = $3,
             last_error = $4,
             next_retry_at = NULL,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE order_id = $1
         RETURNING order_id, status, retry_count, next_retry_at, last_error, completed_at, created_at, updated_at`,
        [orderId, NOTIFICATION_STATUS.FAILED, nextRetryCount, dispatch.error || classification.reason]
      );

      const orderUpdate = await client.query(
        `UPDATE orders
         SET status = $2,
             updated_at = NOW()
         WHERE order_id = $1
         RETURNING order_id, user_id, status, total_cop, total_usd, idempotency_key, created_at, updated_at`,
        [orderId, ORDER_STATUS.FAILED_NOTIFY]
      );

      await client.query('COMMIT');
      return {
        order: mapOrderRow(orderUpdate.rows[0]),
        notification: mapNotificationRow(updated.rows[0]),
        dispatch: { attempted: true, success: false, temporary: false, error: dispatch.error || classification.reason }
      };
    }

    const delaySeconds = delaySecondsForRetry(nextRetryCount);
    const updated = await client.query(
      `UPDATE order_notifications
       SET status = $2,
           retry_count = $3,
           last_error = $4,
           next_retry_at = NOW() + ($5 * INTERVAL '1 second'),
           updated_at = NOW()
       WHERE order_id = $1
       RETURNING order_id, status, retry_count, next_retry_at, last_error, completed_at, created_at, updated_at`,
      [orderId, NOTIFICATION_STATUS.RETRY, nextRetryCount, dispatch.error || classification.reason, delaySeconds]
    );

    await client.query('COMMIT');
    return {
      order: mapOrderRowFromJoin(row),
      notification: mapNotificationRow(updated.rows[0]),
      dispatch: { attempted: true, success: false, temporary: true, error: dispatch.error || classification.reason }
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function processRetryBatch() {
  const client = await pool.connect();
  const processed = [];

  try {
    await client.query('BEGIN');

    const due = await client.query(
      `SELECT n.order_id
       FROM order_notifications n
       WHERE n.status = $1
         AND n.next_retry_at <= NOW()
       ORDER BY n.next_retry_at ASC, n.id ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [NOTIFICATION_STATUS.RETRY, SCHEDULER_BATCH_SIZE]
    );

    for (const row of due.rows) {
      const orderResult = await client.query(
        `SELECT o.order_id, o.user_id, n.retry_count
         FROM orders o
         INNER JOIN order_notifications n ON n.order_id = o.order_id
         WHERE o.order_id = $1
         FOR UPDATE OF n`,
        [row.order_id]
      );

      if (orderResult.rowCount === 0) {
        continue;
      }

      const item = orderResult.rows[0];
      const notificationPayload = await buildNotificationPayload(client, item.order_id);
      const dispatch = await notifyOrderForDmV1(notificationPayload);

      if (dispatch.success) {
        await client.query(
          `UPDATE order_notifications
           SET status = $2,
               completed_at = NOW(),
               next_retry_at = NULL,
               last_error = NULL,
               updated_at = NOW()
           WHERE order_id = $1`,
          [item.order_id, NOTIFICATION_STATUS.SENT]
        );

        await client.query(
          `UPDATE orders
           SET status = $2,
               updated_at = NOW()
           WHERE order_id = $1`,
          [item.order_id, ORDER_STATUS.NOTIFIED]
        );

        processed.push({ orderId: item.order_id, success: true });
        continue;
      }

      const classification = classifyNotificationError(new Error(dispatch.error || 'notification_failed'));
      const nextRetryCount = Number(item.retry_count) + 1;

      if (!classification.temporary || nextRetryCount > MAX_RETRIES) {
        await client.query(
          `UPDATE order_notifications
           SET status = $2,
               retry_count = $3,
               last_error = $4,
               next_retry_at = NULL,
               completed_at = NOW(),
               updated_at = NOW()
           WHERE order_id = $1`,
          [item.order_id, NOTIFICATION_STATUS.FAILED, nextRetryCount, dispatch.error || classification.reason]
        );

        await client.query(
          `UPDATE orders
           SET status = $2,
               updated_at = NOW()
           WHERE order_id = $1`,
          [item.order_id, ORDER_STATUS.FAILED_NOTIFY]
        );

        processed.push({ orderId: item.order_id, success: false, finalized: true });
        continue;
      }

      const delaySeconds = delaySecondsForRetry(nextRetryCount);
      await client.query(
        `UPDATE order_notifications
         SET status = $2,
             retry_count = $3,
             last_error = $4,
             next_retry_at = NOW() + ($5 * INTERVAL '1 second'),
             updated_at = NOW()
         WHERE order_id = $1`,
        [item.order_id, NOTIFICATION_STATUS.RETRY, nextRetryCount, dispatch.error || classification.reason, delaySeconds]
      );

      processed.push({ orderId: item.order_id, success: false, finalized: false });
    }

    await client.query('COMMIT');
    return processed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function runNotificationRetentionCleanup(retentionDays) {
  const days = Math.max(1, Number(retentionDays) || 7);

  const result = await pool.query(
    `DELETE FROM order_notifications
     WHERE status IN ('sent', 'failed')
       AND completed_at < NOW() - ($1 * INTERVAL '1 day')`,
    [days]
  );

  return Number(result.rowCount || 0);
}

async function listOrdersByUser(userId) {
  const result = await pool.query(
    `SELECT o.order_id, o.user_id, o.status, o.total_cop, o.total_usd, o.idempotency_key, o.contacto_id, o.metodo_pago, o.created_at, o.updated_at,
            n.status AS notification_status, n.retry_count, n.next_retry_at, n.last_error, n.completed_at,
            n.created_at AS notification_created_at, n.updated_at AS notification_updated_at,
            uc.id AS contacto_id_joined, uc.plataforma AS contacto_plataforma, uc.contacto AS contacto_valor,
            COALESCE(oi.items, '[]'::json) AS services
     FROM orders o
     LEFT JOIN order_notifications n ON n.order_id = o.order_id
     LEFT JOIN usuario_contactos uc ON uc.id = o.contacto_id
     LEFT JOIN LATERAL (
       SELECT json_agg(
         json_build_object(
           'serviceId', item.service_id,
           'label', item.label,
           'isVariablePrice', item.is_variable_price,
           'priceRangeCop', item.price_range_cop,
           'priceCop', item.price_cop
         )
         ORDER BY item.id
       ) AS items
       FROM order_items item
       WHERE item.order_id = o.order_id
     ) oi ON true
     WHERE o.user_id = $1
     ORDER BY o.created_at DESC, o.order_id DESC`,
    [userId]
  );

  return result.rows.map(mapJoinedOrder);
}

async function listOrdersForAdmin({ q = '', status = '', limit } = {}) {
  const values = [];
  const where = [];
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));

  const normalizedQ = String(q || '').trim().toLowerCase();
  if (normalizedQ) {
    values.push(`%${normalizedQ}%`);
    const qIndex = values.length;
    where.push(`(
      LOWER(o.order_id) LIKE $${qIndex}
      OR LOWER(u.usuario) LIKE $${qIndex}
      OR LOWER(COALESCE(u.email, '')) LIKE $${qIndex}
    )`);
  }

  const normalizedStatus = String(status || '').trim().toUpperCase();
  if (normalizedStatus) {
    values.push(normalizedStatus);
    where.push(`o.status = $${values.length}`);
  }

  values.push(safeLimit);
  const limitIndex = values.length;
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT o.order_id, o.user_id, o.status, o.total_cop, o.total_usd, o.idempotency_key, o.contacto_id, o.metodo_pago, o.created_at, o.updated_at,
            n.status AS notification_status, n.retry_count, n.next_retry_at, n.last_error, n.completed_at,
            n.created_at AS notification_created_at, n.updated_at AS notification_updated_at,
            u.usuario AS usuario, u.email AS email,
            uc.id AS contacto_id_joined, uc.plataforma AS contacto_plataforma, uc.contacto AS contacto_valor,
            COALESCE(oi.items, '[]'::json) AS services
     FROM orders o
     LEFT JOIN order_notifications n ON n.order_id = o.order_id
     INNER JOIN usuarios u ON u.id = o.user_id
     LEFT JOIN usuario_contactos uc ON uc.id = o.contacto_id
     LEFT JOIN LATERAL (
       SELECT json_agg(
         json_build_object(
           'serviceId', item.service_id,
           'label', item.label,
           'isVariablePrice', item.is_variable_price,
           'priceRangeCop', item.price_range_cop,
           'priceCop', item.price_cop
         )
         ORDER BY item.id
       ) AS items
       FROM order_items item
       WHERE item.order_id = o.order_id
     ) oi ON true
     ${whereClause}
     ORDER BY o.created_at DESC, o.order_id DESC
     LIMIT $${limitIndex}`,
    values
  );

  return result.rows.map(mapAdminJoinedOrder);
}

async function getOrderForUser(orderId, userId, isAdmin) {
  const values = [orderId];
  let whereClause = 'o.order_id = $1';

  if (!isAdmin) {
    values.push(userId);
    whereClause += ` AND o.user_id = $${values.length}`;
  }

  const result = await pool.query(
    `SELECT o.order_id, o.user_id, o.status, o.total_cop, o.total_usd, o.idempotency_key, o.contacto_id, o.metodo_pago, o.created_at, o.updated_at,
            n.status AS notification_status, n.retry_count, n.next_retry_at, n.last_error, n.completed_at,
            n.created_at AS notification_created_at, n.updated_at AS notification_updated_at,
            uc.id AS contacto_id_joined, uc.plataforma AS contacto_plataforma, uc.contacto AS contacto_valor,
            COALESCE(oi.items, '[]'::json) AS services
     FROM orders o
     LEFT JOIN order_notifications n ON n.order_id = o.order_id
     LEFT JOIN usuario_contactos uc ON uc.id = o.contacto_id
     LEFT JOIN LATERAL (
       SELECT json_agg(
         json_build_object(
           'serviceId', item.service_id,
           'label', item.label,
           'isVariablePrice', item.is_variable_price,
           'priceRangeCop', item.price_range_cop,
           'priceCop', item.price_cop
         )
         ORDER BY item.id
       ) AS items
       FROM order_items item
       WHERE item.order_id = o.order_id
     ) oi ON true
     WHERE ${whereClause}
     LIMIT 1`,
    values
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapJoinedOrder(result.rows[0]);
}

async function getOrderForAdmin(orderId) {
  const result = await pool.query(
    `SELECT o.order_id, o.user_id, o.status, o.total_cop, o.total_usd, o.idempotency_key, o.contacto_id, o.metodo_pago, o.created_at, o.updated_at,
            n.status AS notification_status, n.retry_count, n.next_retry_at, n.last_error, n.completed_at,
            n.created_at AS notification_created_at, n.updated_at AS notification_updated_at,
            u.usuario AS usuario, u.email AS email,
            uc.id AS contacto_id_joined, uc.plataforma AS contacto_plataforma, uc.contacto AS contacto_valor,
            COALESCE(
              json_agg(
                json_build_object(
                  'serviceId', oi.service_id,
                  'label', oi.label,
                  'isVariablePrice', oi.is_variable_price,
                  'priceRangeCop', oi.price_range_cop,
                  'priceCop', oi.price_cop
                )
                ORDER BY oi.id
              ) FILTER (WHERE oi.id IS NOT NULL),
              '[]'::json
            ) AS services
     FROM orders o
     INNER JOIN order_notifications n ON n.order_id = o.order_id
     INNER JOIN usuarios u ON u.id = o.user_id
     LEFT JOIN usuario_contactos uc ON uc.id = o.contacto_id
     LEFT JOIN order_items oi ON oi.order_id = o.order_id
     WHERE o.order_id = $1
     GROUP BY o.order_id, n.order_id, u.id, uc.id
     LIMIT 1`,
    [orderId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapAdminJoinedOrder(result.rows[0]);
}

async function listActiveRetries(limit) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const result = await pool.query(
    `SELECT order_id, user_id, status, retry_count, next_retry_at, last_error, created_at, updated_at
     FROM order_notifications
     WHERE status = 'retry'
     ORDER BY next_retry_at ASC, id ASC
     LIMIT $1`,
    [safeLimit]
  );

  return result.rows.map(mapNotificationRow);
}

async function listFinalFailures(limit) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const result = await pool.query(
    `SELECT order_id, user_id, status, retry_count, next_retry_at, last_error, completed_at, created_at, updated_at
     FROM order_notifications
     WHERE status = 'failed'
     ORDER BY completed_at DESC NULLS LAST, id DESC
     LIMIT $1`,
    [safeLimit]
  );

  return result.rows.map(mapNotificationRow);
}

async function updateOrderStatus(orderId, status) {
  if (!ORDER_MUTABLE_STATUS.has(status)) {
    throw new Error('Invalid order status.');
  }

  const result = await pool.query(
    `UPDATE orders
     SET status = $2,
         updated_at = NOW()
     WHERE order_id = $1
     RETURNING order_id, user_id, status, total_cop, total_usd, idempotency_key, created_at, updated_at`,
    [orderId, status]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapOrderRow(result.rows[0]);
}

async function deleteOrderById(orderId) {
  const result = await pool.query(
    `DELETE FROM orders
     WHERE order_id = $1
     RETURNING order_id`,
    [orderId]
  );

  return result.rowCount > 0;
}

function mapOrderRow(row, extras = {}) {
  if (!row) {
    return null;
  }

  const services = Array.isArray(extras.services)
    ? extras.services
    : mapOrderItemsJson(row.services);

  return {
    orderId: row.order_id,
    userId: Number(row.user_id),
    status: row.status,
    totalCop: Number(row.total_cop),
    totalUsd: Number(row.total_usd),
    idempotencyKey: row.idempotency_key || null,
    metodoPago: row.metodo_pago || null,
    contactoId: row.contacto_id != null ? Number(row.contacto_id) : null,
    contacto: extras.contacto || mapContactFromRow(row),
    services,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapNotificationRow(row) {
  if (!row) {
    return null;
  }

  return {
    orderId: row.order_id,
    userId: row.user_id != null ? Number(row.user_id) : null,
    status: row.status,
    retryCount: Number(row.retry_count || 0),
    nextRetryAt: row.next_retry_at || null,
    lastError: row.last_error || null,
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapOrderRowFromJoin(row) {
  return {
    orderId: row.order_id,
    userId: Number(row.user_id),
    status: row.order_status,
    totalCop: Number(row.total_cop),
    totalUsd: Number(row.total_usd),
    idempotencyKey: row.idempotency_key || null,
    metodoPago: row.metodo_pago || null,
    contactoId: row.contacto_id != null ? Number(row.contacto_id) : null,
    contacto: mapContactFromRow(row),
    services: mapOrderItemsJson(row.services),
    createdAt: row.order_created_at,
    updatedAt: row.order_updated_at
  };
}

function mapNotificationRowFromJoin(row) {
  return {
    orderId: row.order_id,
    userId: Number(row.user_id),
    status: row.notification_status,
    retryCount: Number(row.retry_count || 0),
    nextRetryAt: row.next_retry_at || null,
    lastError: row.last_error || null,
    completedAt: row.completed_at || null,
    createdAt: row.notification_created_at,
    updatedAt: row.notification_updated_at
  };
}

function mapJoinedOrder(row) {
  return {
    order: {
      orderId: row.order_id,
      userId: Number(row.user_id),
      status: row.status,
      totalCop: Number(row.total_cop),
      totalUsd: Number(row.total_usd),
      idempotencyKey: row.idempotency_key || null,
      metodoPago: row.metodo_pago || null,
      contactoId: row.contacto_id != null ? Number(row.contacto_id) : null,
      contacto: mapContactFromRow(row),
      services: mapOrderItemsJson(row.services),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    },
    notification: {
      orderId: row.order_id,
      userId: Number(row.user_id),
      status: row.notification_status,
      retryCount: Number(row.retry_count || 0),
      nextRetryAt: row.next_retry_at || null,
      lastError: row.last_error || null,
      completedAt: row.completed_at || null,
      createdAt: row.notification_created_at,
      updatedAt: row.notification_updated_at
    }
  };
}

function mapAdminJoinedOrder(row) {
  return {
    orderId: row.order_id,
    userId: Number(row.user_id),
    usuario: row.usuario,
    email: row.email || null,
    status: row.status,
    totalCop: Number(row.total_cop),
    totalUsd: Number(row.total_usd),
    idempotencyKey: row.idempotency_key || null,
    metodoPago: row.metodo_pago || null,
    contactoId: row.contacto_id != null ? Number(row.contacto_id) : null,
    contacto: mapContactFromRow(row),
    services: mapOrderItemsJson(row.services),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notification: {
      status: row.notification_status,
      retryCount: Number(row.retry_count || 0),
      nextRetryAt: row.next_retry_at || null,
      lastError: row.last_error || null,
      completedAt: row.completed_at || null,
      createdAt: row.notification_created_at,
      updatedAt: row.notification_updated_at
    }
  };
}

function mapOrderItemRow(row) {
  return {
    serviceId: row.service_id,
    label: row.label,
    isVariablePrice: Boolean(row.is_variable_price),
    priceRangeCop: row.price_range_cop || '',
    priceCop: row.price_cop == null ? null : Number(row.price_cop)
  };
}

function mapOrderItemsJson(value) {
  const list = Array.isArray(value) ? value : [];

  return list
    .map((entry) => ({
      serviceId: String((entry && entry.serviceId) || '').trim(),
      label: String((entry && entry.label) || '').trim(),
      isVariablePrice: Boolean(entry && entry.isVariablePrice),
      priceRangeCop: String((entry && entry.priceRangeCop) || ''),
      priceCop: entry && entry.priceCop != null ? Number(entry.priceCop) : null
    }))
    .filter((entry) => entry.serviceId && entry.label);
}

function mapContactRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    plataforma: row.plataforma,
    contacto: row.contacto
  };
}

function mapContactFromRow(row) {
  if (!row || row.contacto_id_joined == null) {
    return null;
  }

  return {
    id: Number(row.contacto_id_joined),
    plataforma: row.contacto_plataforma,
    contacto: row.contacto_valor
  };
}

async function findLegacyOrderFallback(client, { userId, totalCop, createdAt }) {
  const result = await client.query(
    `SELECT id, correo, nombre_usuario, contacto_plataforma, contacto_valor, metodo_pago, servicios, total_cop, estado, created_at
     FROM ordenes
     WHERE usuario_id = $1
       AND total_cop = $2
       AND created_at BETWEEN ($3::timestamptz - INTERVAL '10 minutes') AND ($3::timestamptz + INTERVAL '10 minutes')
     ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - $3::timestamptz))) ASC, id DESC
     LIMIT 1`,
    [userId, totalCop, createdAt]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    usuario: row.nombre_usuario,
    email: row.correo,
    contacto: {
      plataforma: row.contacto_plataforma,
      contacto: row.contacto_valor
    },
    metodoPago: row.metodo_pago || null,
    estado: row.estado || null,
    services: parseLegacyServices(row.servicios)
  };
}

async function buildNotificationPayload(client, orderId) {
  const result = await client.query(
    `SELECT o.order_id, o.user_id, o.status, o.total_cop, o.total_usd, o.created_at,
            o.metodo_pago, o.contacto_id,
            u.usuario, u.email,
            uc.id AS contacto_id_joined, uc.plataforma AS contacto_plataforma, uc.contacto AS contacto_valor,
            COALESCE(
              json_agg(
                json_build_object(
                  'serviceId', oi.service_id,
                  'label', oi.label,
                  'isVariablePrice', oi.is_variable_price,
                  'priceRangeCop', oi.price_range_cop,
                  'priceCop', oi.price_cop
                )
                ORDER BY oi.id
              ) FILTER (WHERE oi.id IS NOT NULL),
              '[]'::json
            ) AS services
     FROM orders o
     INNER JOIN usuarios u ON u.id = o.user_id
     LEFT JOIN usuario_contactos uc ON uc.id = o.contacto_id
     LEFT JOIN order_items oi ON oi.order_id = o.order_id
     WHERE o.order_id = $1
     GROUP BY o.order_id, u.id, uc.id
     LIMIT 1`,
    [orderId]
  );

  if (result.rowCount === 0) {
    throw new Error('Order not found for notification payload.');
  }

  const row = result.rows[0];
  let services = mapOrderItemsJson(row.services);
  let contacto = mapContactFromRow(row);
  let metodoPago = row.metodo_pago || null;
  let usuario = row.usuario || null;
  let email = row.email || null;
  let estado = toLegacyState(row.status);

  if (services.length === 0 || !contacto || !metodoPago) {
    const fallback = await findLegacyOrderFallback(client, {
      userId: Number(row.user_id),
      totalCop: Number(row.total_cop),
      createdAt: row.created_at
    });

    if (fallback) {
      if (services.length === 0 && Array.isArray(fallback.services) && fallback.services.length > 0) {
        services = fallback.services;
      }

      if (!contacto && fallback.contacto) {
        contacto = fallback.contacto;
      }

      if (!metodoPago && fallback.metodoPago) {
        metodoPago = fallback.metodoPago;
      }

      if (!usuario && fallback.usuario) {
        usuario = fallback.usuario;
      }

      if (!email && fallback.email) {
        email = fallback.email;
      }

      if (fallback.estado) {
        estado = fallback.estado;
      }
    }
  }

  return {
    orderId: row.order_id,
    userId: Number(row.user_id),
    usuario,
    email,
    contacto: contacto || null,
    metodoPago,
    estado,
    totalCop: Number(row.total_cop),
    totalUsd: Number(row.total_usd),
    services
  };
}

module.exports = {
  ORDER_STATUS,
  NOTIFICATION_STATUS,
  createOrder,
  attemptNotification,
  processRetryBatch,
  runNotificationRetentionCleanup,
  listOrdersByUser,
  listOrdersForAdmin,
  getOrderForUser,
  getOrderForAdmin,
  listActiveRetries,
  listFinalFailures,
  updateOrderStatus,
  deleteOrderById
};
