const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const session = require('express-session');
const pgSessionFactory = require('connect-pg-simple');
const path = require('path');
const { spawnSync } = require('child_process');
const pool = require('./db/pool');
const { hashPassword } = require('./services/passwordService');

dotenv.config();

const authRoutes = require('./routes/authRoutes');
const catalogRoutes = require('./routes/catalogRoutes');
const adminRoutes = require('./routes/adminRoutes');
const ordersV1Routes = require('./routes/v1/ordersRoutes');
const { startOrderNotificationJobs, stopOrderNotificationJobs } = require('./jobs/orderNotificationJobs');

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const isProduction = process.env.NODE_ENV === 'production';

function isAdminBootstrapEnabled() {
  return String(process.env.ADMIN_BOOTSTRAP_ENABLED || '').toLowerCase() === 'true';
}

function validateEnvironment() {
  const required = ['DATABASE_URL', 'SESSION_SECRET', 'PEPPER', 'DISBOT_BASE_URL', 'DISBOT_SHARED_SECRET'];
  const missing = required.filter((key) => !process.env[key]);

  if (isProduction && !process.env.FRONTEND_ORIGIN) {
    missing.push('FRONTEND_ORIGIN');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  if (isAdminBootstrapEnabled()) {
    const adminRequired = ['ADMIN_BOOTSTRAP_USER', 'ADMIN_BOOTSTRAP_PASSWORD'];
    adminRequired.forEach((key) => {
      if (!process.env[key]) {
        missing.push(key);
      }
    });

    if (missing.length > 0) {
      throw new Error(`Missing required env vars: ${missing.join(', ')}`);
    }

    if (String(process.env.ADMIN_BOOTSTRAP_USER).trim().length < 3) {
      throw new Error('ADMIN_BOOTSTRAP_USER must have at least 3 characters');
    }

    if (String(process.env.ADMIN_BOOTSTRAP_PASSWORD).length < 12) {
      throw new Error('ADMIN_BOOTSTRAP_PASSWORD must have at least 12 characters');
    }
  }

  if (isProduction && process.env.SESSION_SECRET === 'unsafe_dev_secret') {
    throw new Error('SESSION_SECRET insecure value is not allowed in production');
  }
}

validateEnvironment();

function runMigrationsOnStartup() {
  const migrationPath = path.join(__dirname, 'db', 'runMigrations.js');
  const result = spawnSync(process.execPath, [migrationPath], {
    stdio: 'inherit',
    env: process.env,
    timeout: 30000
  });

  if (result.status !== 0) {
    throw new Error('Could not run migrations on startup');
  }
}

runMigrationsOnStartup();

async function ensureAdminFromEnv() {
  if (!isAdminBootstrapEnabled()) {
    return;
  }

  const existingAdmin = await pool.query("SELECT id FROM usuarios WHERE rol = 'administrador' LIMIT 1");
  if (existingAdmin.rowCount > 0) {
    console.log('Admin bootstrap: administrador ya existe, no se realizaron cambios.');
    return;
  }

  const username = String(process.env.ADMIN_BOOTSTRAP_USER || '').trim();
  const password = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || '');
  const { hash, salt } = await hashPassword(password);

  try {
    await pool.query(
      'INSERT INTO usuarios (usuario, password_hash, password_salt, rol) VALUES ($1, $2, $3, $4)',
      [username, hash, salt, 'administrador']
    );
    console.log('Admin bootstrap: administrador inicial creado desde variables de entorno.');
  } catch (error) {
    if (String(error.message || '').includes('duplicate key')) {
      console.log('Admin bootstrap: usuario ya existe, no se realizaron cambios.');
      return;
    }

    throw error;
  }
}

const PgSession = pgSessionFactory(session);
const allowedOrigins = (process.env.FRONTEND_ORIGIN || (isProduction ? '' : 'http://localhost:3000'))
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (isProduction) {
  app.set('trust proxy', 1);
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true
  })
);
app.use(express.json());
app.use(
  session({
    name: 'sid',
    secret: process.env.SESSION_SECRET,
    store: new PgSession({
      pool,
      tableName: 'session',
      createTableIfMissing: false
    }),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: isProduction ? 'none' : 'lax',
      secure: isProduction,
      maxAge: 1000 * 60 * 60 * 24
    }
  })
);

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch (_error) {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

app.get('/', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'api', status: 'operativa' });
  } catch (_error) {
    res.status(503).json({ ok: false, service: 'api', status: 'db_down' });
  }
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/catalog', catalogRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1', ordersV1Routes);

app.use((err, _req, res, _next) => {
  console.error(isProduction ? err.message : err);
  res.status(500).json({ error: 'Error interno del API' });
});

let server;

async function startServer() {
  await ensureAdminFromEnv();

  server = app.listen(PORT, () => {
    const externalUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    console.log(`API activa en ${externalUrl}`);
  });

  startOrderNotificationJobs();
}

startServer().catch(async (error) => {
  console.error(isProduction ? error.message : error);
  await pool.end();
  process.exit(1);
});

async function shutdown() {
  stopOrderNotificationJobs();

  if (!server) {
    await pool.end();
    process.exit(0);
    return;
  }

  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
