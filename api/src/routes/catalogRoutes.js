const express = require('express');
const { getRuntimeConfig } = require('../services/runtimeConfigService');
const { getCatalog } = require('../services/catalogService');

const router = express.Router();

router.get('/', (_req, res, next) => {
  try {
    const runtimeConfig = getRuntimeConfig();
    const catalog = getCatalog(runtimeConfig);

    res.json({
      runtimeConfig,
      ...catalog
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
