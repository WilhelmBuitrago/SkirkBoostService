const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const session = require('express-session');
const pgSessionFactory = require('connect-pg-simple');
const path = require('path');
const { spawnSync } = require('child_process');
const pool = require('./db/pool');

dotenv.config();

const authRoutes = require('./routes/authRoutes');
const catalogRoutes = require('./routes/catalogRoutes');
const adminRoutes = require('./routes/adminRoutes');

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const isProduction = process.env.NODE_ENV === 'production';

function validateEnvironment() {
  const required = ['DATABASE_URL', 'SESSION_SECRET', 'PEPPER'];
  const missing = required.filter((key) => !process.env[key]);

  if (isProduction && !process.env.FRONTEND_ORIGIN) {
    missing.push('FRONTEND_ORIGIN');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
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

app.use('/auth', authRoutes);
app.use('/catalog', catalogRoutes);
app.use('/admin', adminRoutes);

app.use((err, _req, res, _next) => {
  console.error(isProduction ? err.message : err);
  res.status(500).json({ error: 'Error interno del API' });
});

const server = app.listen(PORT, () => {
  const externalUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`API activa en ${externalUrl}`);
});

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
