const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { getRuntimeConfig, saveRuntimeConfig } = require('../services/runtimeConfigService');
const { getCatalog, getAllServiceIds, updatePriceByServiceId } = require('../services/catalogService');

const router = express.Router();

const STATUS_VALUES = new Set(['ACTIVA', 'PARCIAL', 'NO_ACTIVA']);

router.use(requireAdmin);

router.get('/config', (req, res, next) => {
  try {
    const runtimeConfig = getRuntimeConfig();
    const catalog = getCatalog(runtimeConfig);

    res.json({
      runtimeConfig,
      allServiceIds: getAllServiceIds(),
      catalog,
      canEdit: true,
      user: req.session.user
    });
  } catch (error) {
    next(error);
  }
});

router.put('/status', (req, res, next) => {
  try {
    const { status } = req.body;
    if (!STATUS_VALUES.has(status)) {
      return res.status(400).json({ error: 'Estado invalido' });
    }

    const current = getRuntimeConfig();
    const saved = saveRuntimeConfig(
      {
        platformStatus: status,
        disabledServiceIds: current.disabledServiceIds
      },
      req.session.user.usuario
    );

    return res.json({ runtimeConfig: saved });
  } catch (error) {
    return next(error);
  }
});

router.put('/availability', (req, res, next) => {
  try {
    const { disabledServiceIds } = req.body;
    if (!Array.isArray(disabledServiceIds)) {
      return res.status(400).json({ error: 'disabledServiceIds debe ser un array' });
    }

    const allowed = new Set(getAllServiceIds());
    const invalid = disabledServiceIds.filter((id) => !allowed.has(id));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Service IDs invalidos: ${invalid.join(', ')}` });
    }

    const current = getRuntimeConfig();
    const saved = saveRuntimeConfig(
      {
        platformStatus: current.platformStatus,
        disabledServiceIds
      },
      req.session.user.usuario
    );

    return res.json({ runtimeConfig: saved });
  } catch (error) {
    return next(error);
  }
});

router.put('/price', (req, res, next) => {
  try {
    const { serviceId, priceCop } = req.body;
    if (!serviceId || typeof priceCop === 'undefined') {
      return res.status(400).json({ error: 'serviceId y priceCop son requeridos' });
    }

    updatePriceByServiceId(serviceId, priceCop);

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
