const express = require('express');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const API_BASE_URL = process.env.API_BASE_URL || (isProduction ? '' : 'http://localhost:4000');
const PUBLIC_API_BASE_URL = process.env.PUBLIC_API_BASE_URL || API_BASE_URL;

if (!API_BASE_URL) {
  throw new Error('API_BASE_URL is required.');
}

if (isProduction && !PUBLIC_API_BASE_URL) {
  throw new Error('PUBLIC_API_BASE_URL is required in production.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function formatCop(value) {
  return new Intl.NumberFormat('es-CO').format(value);
}

function formatUsd(value) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

async function fetchCatalog() {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 5000);

  const response = await fetch(`${API_BASE_URL}/catalog`, {
    headers: { 'Content-Type': 'application/json' },
    signal: abortController.signal
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    throw new Error(`Error catalog API: ${response.status}`);
  }

  return response.json();
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/', async (_req, res, next) => {
  try {
    const data = await fetchCatalog();
    res.render('index', {
      pageTitle: "Skirk's Boost Service",
      exchangeRate: data.exchangeRate,
      zones: data.zones,
      services: data.services,
      platformStatus: data.runtimeConfig.platformStatus,
      apiBaseUrl: PUBLIC_API_BASE_URL
    });
  } catch (error) {
    next(error);
  }
});

app.get('/exploracion/:zoneId', async (req, res, next) => {
  try {
    const data = await fetchCatalog();
    const zone = data.zones.find((item) => item.id === req.params.zoneId);

    if (!zone) {
      return res.status(404).render('404', {
        pageTitle: 'Zona no encontrada',
        message: 'La region solicitada no existe o fue removida del catalogo.',
        apiBaseUrl: PUBLIC_API_BASE_URL
      });
    }

    return res.render('zone-detail', {
      pageTitle: `Exploracion - ${zone.name}`,
      exchangeRate: data.exchangeRate,
      zone,
      formatCop,
      formatUsd,
      convertCopToUsd: (value) => value / Number(data.exchangeRate || 2857),
      platformStatus: data.runtimeConfig.platformStatus,
      apiBaseUrl: PUBLIC_API_BASE_URL
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/login', (_req, res) => {
  res.render('login', {
    pageTitle: 'Login',
    apiBaseUrl: PUBLIC_API_BASE_URL
  });
});

app.get('/config', (_req, res) => {
  res.render('config', {
    pageTitle: 'Configuracion',
    apiBaseUrl: PUBLIC_API_BASE_URL
  });
});

app.get('/carrito', (_req, res) => {
  res.render('cart', {
    pageTitle: 'Carrito',
    apiBaseUrl: PUBLIC_API_BASE_URL,
    exchangeRate: Number(process.env.USD_VALUE) || 2857
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).render('404', {
    pageTitle: 'Error interno',
    message: 'Ocurrio un error interno al cargar la informacion del servicio.',
    apiBaseUrl: PUBLIC_API_BASE_URL
  });
});

app.listen(PORT, () => {
  const externalUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`Frontend activo en ${externalUrl}`);
});
