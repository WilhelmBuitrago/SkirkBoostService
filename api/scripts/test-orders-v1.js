/* eslint-disable no-console */
const pool = require('../src/db/pool');
const {
  createOrder,
  processRetryBatch,
  runNotificationRetentionCleanup,
  listActiveRetries,
  listFinalFailures
} = require('../src/services/v1/ordersDomainService');

async function run() {
  const username = `v1_test_admin_${Date.now()}`;

  const userResult = await pool.query(
    `INSERT INTO usuarios (usuario, password_hash, password_salt, rol)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [username, 'hash', 'salt', 'administrador']
  );

  const userId = Number(userResult.rows[0].id);

  const first = await createOrder({
    userId,
    totalCop: 50000,
    totalUsd: 18.5,
    idempotencyKey: 'idem-demo-key'
  });

  if (!first || !first.order || !first.order.orderId) {
    throw new Error('createOrder did not return a valid order.');
  }

  const duplicate = await createOrder({
    userId,
    totalCop: 50000,
    totalUsd: 18.5,
    idempotencyKey: 'idem-demo-key'
  });

  if (duplicate.created !== false) {
    throw new Error('Idempotency check failed, duplicate order was created.');
  }

  const notificationCount = await pool.query(
    'SELECT COUNT(*)::int AS total FROM order_notifications WHERE order_id = $1',
    [first.order.orderId]
  );

  if (notificationCount.rows[0].total !== 1) {
    throw new Error('UNIQUE(order_id) notification invariant failed.');
  }

  await pool.query(
    `UPDATE order_notifications
     SET status = 'retry',
         retry_count = 0,
         next_retry_at = NOW() - INTERVAL '30 seconds',
         last_error = 'forced-test-retry',
         updated_at = NOW()
     WHERE order_id = $1`,
    [first.order.orderId]
  );

  const retryResults = await processRetryBatch();
  if (!Array.isArray(retryResults)) {
    throw new Error('processRetryBatch did not return an array.');
  }

  await pool.query(
    `UPDATE order_notifications
     SET status = 'sent',
         completed_at = NOW() - INTERVAL '8 days',
         updated_at = NOW()
     WHERE order_id = $1`,
    [first.order.orderId]
  );

  const deleted = await runNotificationRetentionCleanup(7);
  if (typeof deleted !== 'number') {
    throw new Error('Retention cleanup did not return deleted row count.');
  }

  const retries = await listActiveRetries(10);
  const failures = await listFinalFailures(10);

  console.log('TEST_V1_OK');
  console.log(
    JSON.stringify(
      {
        created: first.created,
        duplicateCreated: duplicate.created,
        retryProcessed: retryResults.length,
        deletedByRetention: deleted,
        activeRetries: retries.length,
        finalFailures: failures.length
      },
      null,
      2
    )
  );
}

run()
  .catch((error) => {
    console.error('TEST_V1_FAIL', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
