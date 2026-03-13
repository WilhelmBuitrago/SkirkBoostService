(function () {
  const apiBaseUrl = document.body.dataset.apiBaseUrl;
  const statusIndicator = document.getElementById('status-indicator');
  const statusButtons = document.querySelectorAll('.js-status');
  const checklistContainer = document.getElementById('service-checklist');
  const priceEditor = document.getElementById('price-editor');
  const searchInput = document.getElementById('service-search');
  const message = document.getElementById('config-message');

  let currentConfig = null;
  let allServices = [];

  function formatCop(value) {
    return new Intl.NumberFormat('es-CO').format(value);
  }

  function showMessage(text, isError) {
    message.textContent = text;
    message.style.color = isError ? '#ff8b8b' : '#89f2f8';
  }

  function hasValidApiBaseUrl() {
    return Boolean(apiBaseUrl && /^https?:\/\//.test(apiBaseUrl));
  }

  function setIndicator(status) {
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

  function flattenServices(catalog) {
    const rows = [];

    catalog.zones.forEach((zone) => {
      rows.push({ serviceId: zone.serviceId, label: `Zona: ${zone.name}`, priceCop: zone.basePriceCop });
      zone.missionOptions.forEach((mission) => {
        rows.push({
          serviceId: mission.serviceId,
          label: `Mision ${zone.name}: ${mission.name}`,
          priceCop: mission.priceCop
        });
      });
    });

    catalog.services.wishFarming.lessThan50.forEach((item) => {
      rows.push({ serviceId: item.serviceId, label: `Deseos <50%: ${item.label}`, priceCop: item.priceCop });
    });
    catalog.services.wishFarming.moreThan50.forEach((item) => {
      rows.push({ serviceId: item.serviceId, label: `Deseos >50%: ${item.label}`, priceCop: item.priceCop });
    });
    catalog.services.missions.items.forEach((item) => {
      rows.push({ serviceId: item.serviceId, label: `Misiones: ${item.label}`, priceCop: item.priceCop || 0 });
    });
    catalog.services.farming.items.forEach((item) => {
      rows.push({ serviceId: item.serviceId, label: `Farmeo: ${item.label}`, priceCop: item.priceCop || 0 });
    });
    catalog.services.maintenance.items.forEach((item) => {
      rows.push({ serviceId: item.serviceId, label: `Mantenimiento: ${item.label}`, priceCop: item.priceCop || 0 });
    });

    return rows;
  }

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
            showMessage('Disponibilidad actualizada.', false);
          } catch (error) {
            showMessage(error.message, true);
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

  function renderPriceEditor() {
    priceEditor.innerHTML = '';

    allServices.forEach((service) => {
      const row = document.createElement('div');
      row.className = 'price-row';

      const label = document.createElement('span');
      label.textContent = `${service.label} (COP actual: ${formatCop(service.priceCop || 0)})`;

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
          showMessage('Precio actualizado.', false);
          service.priceCop = nextPrice;
          label.textContent = `${service.label} (COP actual: ${formatCop(service.priceCop || 0)})`;
        } catch (error) {
          showMessage(error.message, true);
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
      const response = await fetch(`${apiBaseUrl}/admin/config`, {
        credentials: 'include'
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'No autorizado');
      }

      currentConfig = data;
      setIndicator(data.runtimeConfig.platformStatus);
      allServices = flattenServices(data.catalog);
      renderChecklist('');
      renderPriceEditor();
    } catch (error) {
      showMessage(error.message, true);
      setTimeout(() => {
        window.location.href = '/login';
      }, 600);
    }
  }

  if (!hasValidApiBaseUrl()) {
    showMessage('Configuracion API invalida. Contacta al administrador.', true);
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
        currentConfig.runtimeConfig = data.runtimeConfig;
        setIndicator(data.runtimeConfig.platformStatus);
        showMessage('Estado actualizado.', false);
      } catch (error) {
        showMessage(error.message, true);
      }
    });
  });

  searchInput.addEventListener('input', () => {
    renderChecklist(searchInput.value);
  });

  loadConfig();
})();
