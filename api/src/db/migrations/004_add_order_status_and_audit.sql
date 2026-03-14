ALTER TABLE ordenes
ADD COLUMN IF NOT EXISTS estado VARCHAR(30) NOT NULL DEFAULT 'Cotizacion';

ALTER TABLE ordenes
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

ALTER TABLE ordenes
DROP CONSTRAINT IF EXISTS chk_ordenes_estado;

ALTER TABLE ordenes
ADD CONSTRAINT chk_ordenes_estado
CHECK (estado IN ('Cotizacion', 'En espera', 'Realizando', 'Finalizado'));

CREATE INDEX IF NOT EXISTS idx_ordenes_nombre_usuario_lower
ON ordenes (LOWER(nombre_usuario));

CREATE INDEX IF NOT EXISTS idx_ordenes_estado
ON ordenes (estado);

CREATE INDEX IF NOT EXISTS idx_ordenes_created_at_desc
ON ordenes (created_at DESC);
