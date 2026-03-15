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

class CatalogUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'CatalogUnavailableError';
    this.cause = cause;
  }
}

async function fetchCatalog() {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 5000);

  try {
    const response = await fetch(`${API_BASE_URL}/catalog`, {
      headers: { 'Content-Type': 'application/json' },
      signal: abortController.signal
    });

    if (!response.ok) {
      throw new CatalogUnavailableError(`Error catalog API: ${response.status}`);
    }

    return response.json();
  } catch (error) {
    if (error instanceof CatalogUnavailableError) {
      throw error;
    }

    throw new CatalogUnavailableError('Catalog API is unavailable.', error);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPlatformStatus() {
  try {
    const data = await fetchCatalog();
    return data.runtimeConfig.platformStatus || 'ACTIVA';
  } catch (_error) {
    return 'ACTIVA';
  }
}

function splitFarmingItems(services) {
  const ascensionItem = services.farming.items.find((item) => item.id === 'ascension-personajes') || null;
  const farmingItems = services.farming.items.filter((item) => item.id !== 'ascension-personajes');
  return { ascensionItem, farmingItems };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/', async (_req, res, next) => {
  try {
    const data = await fetchCatalog();
    const { farmingItems, ascensionItem } = splitFarmingItems(data.services);

    const serviceCards = [
      {
        id: 'exploracion',
        title: 'Exploracion',
        href: '/exploracion',
        description: 'Explora regiones y calcula servicios por zona con detalle completo.',
        meta: `${data.zones.length} regiones`
      },
      {
        id: 'farmeo-deseos',
        title: 'Farmeo de deseos',
        href: '/farmeo-deseos',
        description: 'Tarifas por cantidad de deseos segun avance del mapa.',
        meta: `${data.services.wishFarming.lessThan50.length + data.services.wishFarming.moreThan50.length} opciones`
      },
      {
        id: 'misiones',
        title: 'Realizacion de misiones',
        href: '/misiones',
        description: 'Servicios por tipo de mision, desde Arconte hasta eventos.',
        meta: `${data.services.missions.items.length} tipos`
      },
      {
        id: 'farmeo',
        title: 'Farmeo',
        href: '/farmeo',
        description: 'Armas, recursos y farm especializado para tu cuenta.',
        meta: `${farmingItems.length} servicios`
      },
      {
        id: 'ascension',
        title: 'Ascension de personajes',
        href: '/ascension',
        description: 'Servicio de ascension enfocado y configurable.',
        meta: ascensionItem ? '1 servicio dedicado' : 'Consultar disponibilidad'
      },
      {
        id: 'mantenimiento',
        title: 'Mantenimiento de cuenta',
        href: '/mantenimiento',
        description: 'Plan diario, semanal o mensual para mantener progreso.',
        meta: `${data.services.maintenance.items.length} planes`
      }
    ];

    res.render('index', {
      pageTitle: "Skirk's Boost Service",
      exchangeRate: data.exchangeRate,
      serviceCards,
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
        apiBaseUrl: PUBLIC_API_BASE_URL,
        platformStatus: data.runtimeConfig.platformStatus
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

app.get('/exploracion', async (_req, res, next) => {
  try {
    const data = await fetchCatalog();
    res.render('exploration', {
      pageTitle: 'Exploracion por regiones',
      zones: data.zones,
      platformStatus: data.runtimeConfig.platformStatus,
      apiBaseUrl: PUBLIC_API_BASE_URL
    });
  } catch (error) {
    next(error);
  }
});

app.get('/farmeo-deseos', async (_req, res, next) => {
  try {
    const data = await fetchCatalog();
    res.render('wish-farming', {
      pageTitle: 'Farmeo de deseos',
      wishFarming: data.services.wishFarming,
      exchangeRate: data.exchangeRate,
      platformStatus: data.runtimeConfig.platformStatus,
      apiBaseUrl: PUBLIC_API_BASE_URL
    });
  } catch (error) {
    next(error);
  }
});

app.get('/misiones', async (_req, res, next) => {
  try {
    const data = await fetchCatalog();
    res.render('missions', {
      pageTitle: 'Realizacion de misiones',
      missions: data.services.missions,
      exchangeRate: data.exchangeRate,
      platformStatus: data.runtimeConfig.platformStatus,
      apiBaseUrl: PUBLIC_API_BASE_URL
    });
  } catch (error) {
    next(error);
  }
});

app.get('/farmeo', async (_req, res, next) => {
  try {
    const data = await fetchCatalog();
    const { farmingItems } = splitFarmingItems(data.services);
    res.render('farming', {
      pageTitle: 'Farmeo',
      farming: {
        title: data.services.farming.title,
        items: farmingItems
      },
      exchangeRate: data.exchangeRate,
      platformStatus: data.runtimeConfig.platformStatus,
      apiBaseUrl: PUBLIC_API_BASE_URL
    });
  } catch (error) {
    next(error);
  }
});

app.get('/ascension', async (_req, res, next) => {
  try {
    const data = await fetchCatalog();
    const { ascensionItem } = splitFarmingItems(data.services);

    if (!ascensionItem) {
      return res.status(404).render('404', {
        pageTitle: 'Servicio no encontrado',
        message: 'No se encontro el servicio de ascension de personajes.',
        apiBaseUrl: PUBLIC_API_BASE_URL,
        platformStatus: data.runtimeConfig.platformStatus
      });
    }

    return res.render('ascension', {
      pageTitle: 'Ascension de personajes',
      ascensionItem,
      exchangeRate: data.exchangeRate,
      platformStatus: data.runtimeConfig.platformStatus,
      apiBaseUrl: PUBLIC_API_BASE_URL
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/mantenimiento', async (_req, res, next) => {
  try {
    const data = await fetchCatalog();
    res.render('maintenance', {
      pageTitle: 'Mantenimiento de cuenta',
      maintenance: data.services.maintenance,
      exchangeRate: data.exchangeRate,
      platformStatus: data.runtimeConfig.platformStatus,
      apiBaseUrl: PUBLIC_API_BASE_URL
    });
  } catch (error) {
    next(error);
  }
});

app.get('/login', async (_req, res) => {
  const platformStatus = await fetchPlatformStatus();
  res.render('login', {
    pageTitle: 'Ingresar',
    apiBaseUrl: PUBLIC_API_BASE_URL,
    platformStatus
  });
});

app.get('/registro', async (_req, res) => {
  const platformStatus = await fetchPlatformStatus();
  res.render('registro', {
    pageTitle: 'Registrar - Paso 1',
    apiBaseUrl: PUBLIC_API_BASE_URL,
    platformStatus
  });
});

app.get('/registro-contacto', async (_req, res) => {
  const platformStatus = await fetchPlatformStatus();
  res.render('registro-contacto', {
    pageTitle: 'Registrar - Paso 2',
    apiBaseUrl: PUBLIC_API_BASE_URL,
    platformStatus
  });
});

async function renderConfigPage(res, viewName, pageTitle, activeConfigSection) {
  const platformStatus = await fetchPlatformStatus();
  res.render(viewName, {
    pageTitle,
    apiBaseUrl: PUBLIC_API_BASE_URL,
    platformStatus,
    activeConfigSection
  });
}

app.get('/config', async (_req, res) => {
  await renderConfigPage(res, 'config', 'Configuracion', 'inicio');
});

app.get('/config/servicios-parciales', async (_req, res) => {
  await renderConfigPage(res, 'config-servicios', 'Configuracion - Servicios parciales', 'servicios');
});

app.get('/config/precios', async (_req, res) => {
  await renderConfigPage(res, 'config-precios', 'Configuracion - Edicion de precios', 'precios');
});

app.get('/config/usuarios', async (_req, res) => {
  await renderConfigPage(res, 'config-usuarios', 'Configuracion - Usuarios', 'usuarios');
});

app.get('/config/pedidos', async (_req, res) => {
  await renderConfigPage(res, 'config-pedidos', 'Configuracion - Pedidos', 'pedidos');
});

app.get('/carrito', async (_req, res) => {
  const platformStatus = await fetchPlatformStatus();
  res.render('cart', {
    pageTitle: 'Carrito',
    apiBaseUrl: PUBLIC_API_BASE_URL,
    exchangeRate: Number(process.env.USD_VALUE) || 2857,
    platformStatus
  });
});

app.get('/perfil', async (_req, res) => {
  const platformStatus = await fetchPlatformStatus();
  res.render('perfil', {
    pageTitle: 'Perfil',
    apiBaseUrl: PUBLIC_API_BASE_URL,
    platformStatus
  });
});

app.get('/boot/availability', async (_req, res) => {
  try {
    await fetchCatalog();
    res.json({ ready: true });
  } catch (_error) {
    res.status(503).json({ ready: false });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err instanceof CatalogUnavailableError) {
    const requestedPath = _req.originalUrl && !_req.originalUrl.startsWith('/boot/')
      ? _req.originalUrl
      : '/';

    return res.status(503).render('boot-loading', {
      pageTitle: 'Preparando Skirk Boost Service',
      apiBaseUrl: PUBLIC_API_BASE_URL,
      platformStatus: 'NO_ACTIVA',
      targetPath: requestedPath,
      bootMinDurationMs: 10000,
      bootMaxDurationMs: 30000,
      maxAttempts: 2,
      didacticMessages: [
        'Generando servicios para ti',
        'Preparandonos para ti',
        'Sincronizando detalles de tu pedido',
        'Ajustando todo para tu experiencia',
        'Cargando catalogo en tiempo real',
        'Un momento, estamos afinando todo',
        'Ya casi estamos',
        'No te vayas, esto se pone bueno',
        'Armando tu panel personalizado',
        'Verificando disponibilidad de servicios',
        'Calentando motores',
        'Estamos a punto de comenzar'
      ]
    });
  }

  return res.status(500).render('404', {
    pageTitle: 'Error interno',
    message: 'Ocurrio un error interno al cargar la informacion del servicio.',
    apiBaseUrl: PUBLIC_API_BASE_URL,
    platformStatus: 'NO_ACTIVA'
  });
});

app.listen(PORT, "0.0.0.0", () => {
  const externalUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`Frontend activo en ${externalUrl}`);
});