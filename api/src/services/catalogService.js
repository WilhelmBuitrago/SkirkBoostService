const fs = require('fs');
const path = require('path');

const USD_VALUE = Number(process.env.USD_VALUE) || 2857;
const bundledZonesPath = path.join(__dirname, '..', '..', 'config', 'exploration-zones.json');
const bundledServicesPath = path.join(__dirname, '..', '..', 'config', 'services.json');

function resolveWritableConfigPath(envVarName, fallbackPath) {
  const overridePath = process.env[envVarName] ? path.resolve(process.env[envVarName]) : null;
  if (!overridePath) {
    return fallbackPath;
  }

  fs.mkdirSync(path.dirname(overridePath), { recursive: true });

  if (!fs.existsSync(overridePath)) {
    fs.copyFileSync(fallbackPath, overridePath);
  }

  return overridePath;
}

const zonesPath = resolveWritableConfigPath('ZONES_CONFIG_PATH', bundledZonesPath);
const servicesPath = resolveWritableConfigPath('SERVICES_CONFIG_PATH', bundledServicesPath);

function formatCop(value) {
  return new Intl.NumberFormat('es-CO').format(value);
}

function formatUsd(value) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function convertCopToUsd(value) {
  return value / USD_VALUE;
}

function toSlug(label) {
  return String(label || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function normalizeZone(zone) {
  const missionOptions = Array.isArray(zone.missionOptions) ? zone.missionOptions : [];
  return {
    ...zone,
    serviceId: `zone.${zone.id}`,
    missionOptions: missionOptions.map((mission) => ({
      ...mission,
      serviceId: `zone.${zone.id}.mission.${mission.id || toSlug(mission.name)}`,
      priceCopFormatted: mission.priceCop ? formatCop(mission.priceCop) : null,
      priceUsdFormatted: mission.priceCop ? formatUsd(convertCopToUsd(mission.priceCop)) : null
    })),
    basePriceCopFormatted: formatCop(Number(zone.basePriceCop || 0)),
    basePriceUsdFormatted: formatUsd(convertCopToUsd(Number(zone.basePriceCop || 0))),
    missionBundleTotalCopFormatted: zone.missionBundleTotalCop ? formatCop(Number(zone.missionBundleTotalCop)) : null,
    missionBundleTotalUsdFormatted: zone.missionBundleTotalCop ? formatUsd(convertCopToUsd(Number(zone.missionBundleTotalCop))) : null
  };
}

function normalizeServices(services) {
  const copy = JSON.parse(JSON.stringify(services));

  copy.wishFarming.lessThan50 = copy.wishFarming.lessThan50.map((item, index) => ({
    ...item,
    serviceId: `wishFarming.lessThan50.${index}`,
    priceCopFormatted: item.priceCop ? formatCop(item.priceCop) : null,
    priceUsdFormatted: item.priceCop ? formatUsd(convertCopToUsd(item.priceCop)) : null
  }));

  copy.wishFarming.moreThan50 = copy.wishFarming.moreThan50.map((item, index) => ({
    ...item,
    serviceId: `wishFarming.moreThan50.${index}`,
    priceCopFormatted: item.priceCop ? formatCop(item.priceCop) : null,
    priceUsdFormatted: item.priceCop ? formatUsd(convertCopToUsd(item.priceCop)) : null
  }));

  copy.missions.items = copy.missions.items.map((item, index) => ({
    ...item,
    serviceId: `missions.${item.id || toSlug(item.label) || index}`,
    priceCopFormatted: item.priceCop ? formatCop(item.priceCop) : null,
    priceUsdFormatted: item.priceCop ? formatUsd(convertCopToUsd(item.priceCop)) : null,
    priceRangeCopFormatted:
      item.priceCopMin && item.priceCopMax ? `${formatCop(item.priceCopMin)} - ${formatCop(item.priceCopMax)}` : null,
    priceRangeUsdFormatted:
      item.priceCopMin && item.priceCopMax
        ? `${formatUsd(convertCopToUsd(item.priceCopMin))} - ${formatUsd(convertCopToUsd(item.priceCopMax))}`
        : null
  }));

  copy.farming.items = copy.farming.items.map((item, index) => ({
    ...item,
    serviceId: `farming.${item.id || toSlug(item.label) || index}`,
    priceCopFormatted: item.priceCop ? formatCop(item.priceCop) : null,
    priceUsdFormatted: item.priceCop ? formatUsd(convertCopToUsd(item.priceCop)) : null,
    withBooksPriceCopFormatted: item.withBooksPriceCop ? formatCop(item.withBooksPriceCop) : null,
    withBooksPriceUsdFormatted: item.withBooksPriceCop ? formatUsd(convertCopToUsd(item.withBooksPriceCop)) : null
  }));

  copy.maintenance.items = copy.maintenance.items.map((item, index) => ({
    ...item,
    serviceId: `maintenance.${item.id || toSlug(item.label) || index}`,
    priceCopFormatted: item.priceCop ? formatCop(item.priceCop) : null,
    priceUsdFormatted: item.priceCop ? formatUsd(convertCopToUsd(item.priceCop)) : null
  }));

  return copy;
}

function applyAvailabilityToCatalog(catalog, runtimeConfig) {
  const disabled = new Set(runtimeConfig.disabledServiceIds || []);

  function mark(item) {
    const isInactive = runtimeConfig.platformStatus === 'NO_ACTIVA';
    const isDisabledByPartial = runtimeConfig.platformStatus === 'PARCIAL' && disabled.has(item.serviceId);
    return {
      ...item,
      isAvailable: !(isInactive || isDisabledByPartial)
    };
  }

  return {
    ...catalog,
    zones: catalog.zones.map((zone) => ({
      ...mark(zone),
      missionOptions: zone.missionOptions.map(mark)
    })),
    services: {
      ...catalog.services,
      wishFarming: {
        ...catalog.services.wishFarming,
        lessThan50: catalog.services.wishFarming.lessThan50.map(mark),
        moreThan50: catalog.services.wishFarming.moreThan50.map(mark)
      },
      missions: {
        ...catalog.services.missions,
        items: catalog.services.missions.items.map(mark)
      },
      farming: {
        ...catalog.services.farming,
        items: catalog.services.farming.items.map(mark)
      },
      maintenance: {
        ...catalog.services.maintenance,
        items: catalog.services.maintenance.items.map(mark)
      }
    }
  };
}

function getRawConfig() {
  return {
    zones: readJson(zonesPath),
    services: readJson(servicesPath)
  };
}

function getCatalog(runtimeConfig) {
  const raw = getRawConfig();
  const catalog = {
    exchangeRate: USD_VALUE,
    platformStatus: runtimeConfig.platformStatus,
    zones: raw.zones.map(normalizeZone),
    services: normalizeServices(raw.services)
  };

  return applyAvailabilityToCatalog(catalog, runtimeConfig);
}

function getAllServiceIds() {
  const catalog = getCatalog({ platformStatus: 'ACTIVA', disabledServiceIds: [] });
  const ids = [];

  catalog.zones.forEach((zone) => {
    ids.push(zone.serviceId);
    zone.missionOptions.forEach((mission) => ids.push(mission.serviceId));
  });

  catalog.services.wishFarming.lessThan50.forEach((item) => ids.push(item.serviceId));
  catalog.services.wishFarming.moreThan50.forEach((item) => ids.push(item.serviceId));
  catalog.services.missions.items.forEach((item) => ids.push(item.serviceId));
  catalog.services.farming.items.forEach((item) => ids.push(item.serviceId));
  catalog.services.maintenance.items.forEach((item) => ids.push(item.serviceId));

  return ids;
}

function updatePriceByServiceId(serviceId, priceCop) {
  const nextPrice = Number(priceCop);
  if (!Number.isFinite(nextPrice) || nextPrice < 0) {
    throw new Error('Precio invalido');
  }

  const raw = getRawConfig();

  for (const zone of raw.zones) {
    if (`zone.${zone.id}` === serviceId) {
      zone.basePriceCop = nextPrice;
      writeJson(zonesPath, raw.zones);
      return;
    }

    if (Array.isArray(zone.missionOptions)) {
      for (const mission of zone.missionOptions) {
        const missionServiceId = `zone.${zone.id}.mission.${mission.id || toSlug(mission.name)}`;
        if (missionServiceId === serviceId) {
          mission.priceCop = nextPrice;
          writeJson(zonesPath, raw.zones);
          return;
        }
      }
    }
  }

  for (const [index, item] of raw.services.wishFarming.lessThan50.entries()) {
    if (`wishFarming.lessThan50.${index}` === serviceId) {
      item.priceCop = nextPrice;
      writeJson(servicesPath, raw.services);
      return;
    }
  }

  for (const [index, item] of raw.services.wishFarming.moreThan50.entries()) {
    if (`wishFarming.moreThan50.${index}` === serviceId) {
      item.priceCop = nextPrice;
      writeJson(servicesPath, raw.services);
      return;
    }
  }

  for (const [index, item] of raw.services.missions.items.entries()) {
    const currentId = `missions.${item.id || toSlug(item.label) || index}`;
    if (currentId === serviceId) {
      item.priceCop = nextPrice;
      delete item.priceCopMin;
      delete item.priceCopMax;
      writeJson(servicesPath, raw.services);
      return;
    }
  }

  for (const [index, item] of raw.services.farming.items.entries()) {
    const currentId = `farming.${item.id || toSlug(item.label) || index}`;
    if (currentId === serviceId) {
      item.priceCop = nextPrice;
      writeJson(servicesPath, raw.services);
      return;
    }
  }

  for (const [index, item] of raw.services.maintenance.items.entries()) {
    const currentId = `maintenance.${item.id || toSlug(item.label) || index}`;
    if (currentId === serviceId) {
      item.priceCop = nextPrice;
      writeJson(servicesPath, raw.services);
      return;
    }
  }

  throw new Error('Service ID no encontrado');
}

module.exports = {
  getCatalog,
  getAllServiceIds,
  updatePriceByServiceId
};
