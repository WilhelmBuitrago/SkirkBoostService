(function () {
  const utils = window.SkirkConfigUtils;
  const apiBaseUrl = utils.getApiBaseUrl();
  const statusIndicator = document.getElementById('status-indicator');
  const statusButtons = document.querySelectorAll('.js-status');
  const message = document.getElementById('config-message');

  let currentConfig = null;

  function setIndicator(status) {
    if (!statusIndicator) {
      return;
    }

    statusIndicator.classList.remove('status-green', 'status-yellow', 'status-red');
    if (status === 'ACTIVA') {
      statusIndicator.classList.add('status-green');
    } else if (status === 'PARCIAL') {
      statusIndicator.classList.add('status-yellow');
    } else {
      statusIndicator.classList.add('status-red');
    }
    statusIndicator.textContent = status;
  }

  async function loadConfig() {
    try {
      currentConfig = await utils.fetchAdminConfig(apiBaseUrl);
      setIndicator(currentConfig.runtimeConfig.platformStatus);
    } catch (error) {
      utils.showMessage(message, error.message, true);
      utils.redirectToLogin();
    }
  }

  if (!utils.hasValidApiBaseUrl(apiBaseUrl)) {
    utils.showMessage(message, 'Configuracion API invalida. Contacta al administrador.', true);
    return;
  }

  statusButtons.forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/admin/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ status: button.dataset.value })
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'No fue posible cambiar estado');
        }

        if (currentConfig) {
          currentConfig.runtimeConfig = data.runtimeConfig;
        }
        setIndicator(data.runtimeConfig.platformStatus);
        utils.showMessage(message, 'Estado actualizado.', false);
      } catch (error) {
        utils.showMessage(message, error.message, true);
      }
    });
  });

  loadConfig();
})();
