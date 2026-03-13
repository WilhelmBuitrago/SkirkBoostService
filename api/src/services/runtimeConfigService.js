const fs = require('fs');
const path = require('path');

const defaultConfig = {
  platformStatus: 'ACTIVA',
  disabledServiceIds: [],
  updatedAt: null,
  updatedBy: null
};

const runtimeConfigPath = process.env.RUNTIME_CONFIG_PATH
  ? path.resolve(process.env.RUNTIME_CONFIG_PATH)
  : path.join(__dirname, '..', '..', 'data', 'runtime-config.json');

function ensureRuntimeConfigFile() {
  const runtimeDir = path.dirname(runtimeConfigPath);
  fs.mkdirSync(runtimeDir, { recursive: true });

  if (!fs.existsSync(runtimeConfigPath)) {
    fs.writeFileSync(runtimeConfigPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, 'utf8');
  }
}

function getRuntimeConfig() {
  ensureRuntimeConfigFile();
  const data = JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf8'));
  return {
    platformStatus: data.platformStatus || defaultConfig.platformStatus,
    disabledServiceIds: Array.isArray(data.disabledServiceIds) ? data.disabledServiceIds : [],
    updatedAt: data.updatedAt || defaultConfig.updatedAt,
    updatedBy: data.updatedBy || defaultConfig.updatedBy
  };
}

function saveRuntimeConfig(nextConfig, updatedBy) {
  ensureRuntimeConfigFile();
  const payload = {
    platformStatus: nextConfig.platformStatus,
    disabledServiceIds: nextConfig.disabledServiceIds,
    updatedAt: new Date().toISOString(),
    updatedBy
  };

  fs.writeFileSync(runtimeConfigPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

module.exports = {
  getRuntimeConfig,
  saveRuntimeConfig
};
