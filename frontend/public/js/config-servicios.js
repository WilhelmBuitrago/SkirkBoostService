(function () {
  const utils = window.SkirkConfigUtils;
  const apiBaseUrl = utils.getApiBaseUrl();
  const checklistContainer = document.getElementById('service-checklist');
  const searchInput = document.getElementById('service-search');
  const message = document.getElementById('config-message');

  let currentConfig = null;
  let allServices = [];

  function renderChecklist(filterText) {
    const normalizedFilter = (filterText || '').trim().toLowerCase();
    const disabled = new Set(currentConfig.runtimeConfig.disabledServiceIds || []);

    checklistContainer.innerHTML = '';

    allServices
      .filter((service) => service.label.toLowerCase().includes(normalizedFilter))
      .forEach((service) => {
        const wrapper = document.createElement('label');
        wrapper.className = 'mini-card check-line';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = disabled.has(service.serviceId);
        input.addEventListener('change', async () => {
          if (input.checked) {
            disabled.add(service.serviceId);
          } else {
            disabled.delete(service.serviceId);
          }

          try {
            const response = await fetch(`${apiBaseUrl}/admin/availability`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ disabledServiceIds: Array.from(disabled) })
            });
            const data = await response.json();
            if (!response.ok) {
              throw new Error(data.error || 'No fue posible actualizar disponibilidad');
            }

            currentConfig.runtimeConfig = data.runtimeConfig;
            utils.showMessage(message, 'Disponibilidad actualizada.', false);
          } catch (error) {
            utils.showMessage(message, error.message, true);
            input.checked = !input.checked;
          }
        });

        const text = document.createElement('span');
        text.textContent = service.label;

        wrapper.appendChild(input);
        wrapper.appendChild(text);
        checklistContainer.appendChild(wrapper);
      });
  }

  async function loadConfig() {
    try {
      currentConfig = await utils.fetchAdminConfig(apiBaseUrl);
      allServices = utils.flattenServices(currentConfig.catalog);
      renderChecklist('');
    } catch (error) {
      utils.showMessage(message, error.message, true);
      utils.redirectToLogin();
    }
  }

  if (!utils.hasValidApiBaseUrl(apiBaseUrl)) {
    utils.showMessage(message, 'Configuracion API invalida. Contacta al administrador.', true);
    return;
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderChecklist(searchInput.value);
    });
  }

  loadConfig();
})();
