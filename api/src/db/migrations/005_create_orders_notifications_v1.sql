CREATE TABLE IF NOT EXISTS orders (
  order_id VARCHAR(64) PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  status VARCHAR(30) NOT NULL,
  total_cop INTEGER NOT NULL,
  total_usd NUMERIC(12, 2) NOT NULL,
  idempotency_key VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_orders_status_v1
    CHECK (status IN ('PENDING', 'NOTIFIED', 'IN_PROGRESS', 'COMPLETED', 'FAILED_NOTIFY', 'CANCELLED')),
  CONSTRAINT chk_orders_total_cop_positive
    CHECK (total_cop >= 0),
  CONSTRAINT chk_orders_total_usd_positive
    CHECK (total_usd >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key_unique
ON orders (user_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_user_created_desc
ON orders (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_status_updated_desc
ON orders (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS order_notifications (
  id BIGSERIAL PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_order_notifications_order_id UNIQUE (order_id),
  CONSTRAINT chk_order_notifications_status
    CHECK (status IN ('pending', 'retry', 'sent', 'failed')),
  CONSTRAINT chk_order_notifications_retry_count_non_negative
    CHECK (retry_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_order_notifications_retry_due
ON order_notifications (status, next_retry_at);

CREATE INDEX IF NOT EXISTS idx_order_notifications_completed_retention
ON order_notifications (status, completed_at);

CREATE INDEX IF NOT EXISTS idx_order_notifications_user_created_desc
ON order_notifications (user_id, created_at DESC);