(function () {
  const utils = window.SkirkConfigUtils;
  const apiBaseUrl = utils.getApiBaseUrl();
  const priceEditor = document.getElementById('price-editor');
  const priceSearchInput = document.getElementById('price-search');
  const message = document.getElementById('config-message');

  let allServices = [];

  function renderPriceEditor(filterText) {
    const normalizedFilter = (filterText || '').trim().toLowerCase();
    priceEditor.innerHTML = '';

    allServices
      .filter((service) => service.label.toLowerCase().includes(normalizedFilter))
      .forEach((service) => {
        const row = document.createElement('div');
        row.className = 'price-row';

        const label = document.createElement('span');
        label.textContent = `${service.label} (COP actual: ${utils.formatCop(service.priceCop || 0)})`;

        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.value = String(service.priceCop || 0);
        input.className = 'text-input';

        const button = document.createElement('button');
        button.className = 'btn-secondary';
        button.textContent = 'Guardar';
        button.addEventListener('click', async () => {
          const nextPrice = Number(input.value || 0);
          try {
            const response = await fetch(`${apiBaseUrl}/admin/price`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ serviceId: service.serviceId, priceCop: nextPrice })
            });
            const data = await response.json();
            if (!response.ok) {
              throw new Error(data.error || 'No fue posible actualizar precio');
            }

            utils.showMessage(message, 'Precio actualizado.', false);
            service.priceCop = nextPrice;
            label.textContent = `${service.label} (COP actual: ${utils.formatCop(service.priceCop || 0)})`;
          } catch (error) {
            utils.showMessage(message, error.message, true);
          }
        });

        row.appendChild(label);
        row.appendChild(input);
        row.appendChild(button);
        priceEditor.appendChild(row);
      });
  }

  async function loadConfig() {
    try {
      const currentConfig = await utils.fetchAdminConfig(apiBaseUrl);
      allServices = utils.flattenServices(currentConfig.catalog);
      renderPriceEditor('');
    } catch (error) {
      utils.showMessage(message, error.message, true);
      utils.redirectToLogin();
    }
  }

  if (!utils.hasValidApiBaseUrl(apiBaseUrl)) {
    utils.showMessage(message, 'Configuracion API invalida. Contacta al administrador.', true);
    return;
  }

  if (priceSearchInput) {
    priceSearchInput.addEventListener('input', () => {
      renderPriceEditor(priceSearchInput.value);
    });
  }

  loadConfig();
})();
