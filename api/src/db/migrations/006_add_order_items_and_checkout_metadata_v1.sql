ALTER TABLE orders
ADD COLUMN IF NOT EXISTS metodo_pago VARCHAR(50);

ALTER TABLE orders
ADD COLUMN IF NOT EXISTS contacto_id INTEGER REFERENCES usuario_contactos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_contacto_id
ON orders (contacto_id);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  service_id VARCHAR(120) NOT NULL,
  label VARCHAR(255) NOT NULL,
  is_variable_price BOOLEAN NOT NULL DEFAULT FALSE,
  price_range_cop VARCHAR(100) NOT NULL DEFAULT '',
  price_cop INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_order_items_price_non_negative
    CHECK (price_cop IS NULL OR price_cop >= 0)
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id
ON order_items (order_id, id);

CREATE INDEX IF NOT EXISTS idx_order_items_service_id
ON order_items (service_id);