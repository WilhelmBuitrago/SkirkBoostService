ALTER TABLE usuarios
ADD COLUMN IF NOT EXISTS email VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email_unique
ON usuarios (LOWER(email))
WHERE email IS NOT NULL;

ALTER TABLE usuarios
DROP CONSTRAINT IF EXISTS chk_usuarios_email_por_rol;

ALTER TABLE usuarios
ADD CONSTRAINT chk_usuarios_email_por_rol
CHECK (rol = 'administrador' OR email IS NOT NULL);

CREATE TABLE IF NOT EXISTS usuario_contactos (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  plataforma VARCHAR(20) NOT NULL CHECK (plataforma IN ('whatsapp', 'tiktok', 'discord', 'instagram')),
  contacto VARCHAR(255) NOT NULL,
  es_principal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usuario_contactos_unique
ON usuario_contactos (usuario_id, plataforma, contacto);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usuario_contacto_principal
ON usuario_contactos (usuario_id)
WHERE es_principal = TRUE;

CREATE TABLE IF NOT EXISTS ordenes (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  correo VARCHAR(255) NOT NULL,
  nombre_usuario VARCHAR(100) NOT NULL,
  contacto_plataforma VARCHAR(20) NOT NULL CHECK (contacto_plataforma IN ('whatsapp', 'tiktok', 'discord', 'instagram')),
  contacto_valor VARCHAR(255) NOT NULL,
  metodo_pago VARCHAR(50) NOT NULL,
  servicios JSONB NOT NULL,
  total_cop INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ordenes_usuario_id ON ordenes(usuario_id);
