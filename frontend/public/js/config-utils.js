(function () {
  function getApiBaseUrl() {
    return document.body.dataset.apiBaseUrl;
  }

  function hasValidApiBaseUrl(apiBaseUrl) {
    return Boolean(apiBaseUrl && /^https?:\/\//.test(apiBaseUrl));
  }

  function showMessage(messageNode, text, isError) {
    if (!messageNode) {
      return;
    }

    messageNode.textContent = text;
    messageNode.style.color = isError ? '#ff8b8b' : '#89f2f8';
  }

  function formatCop(value) {
    return new Intl.NumberFormat('es-CO').format(value);
  }

  function formatDate(value) {
    if (!value) {
      return '-';
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return '-';
    }

    return parsed.toLocaleString('es-CO');
  }

  function formatPlatform(value) {
    const map = {
      whatsapp: 'WhatsApp',
      tiktok: 'TikTok',
      discord: 'Discord',
      instagram: 'Instagram'
    };

    return map[value] || value || '-';
  }

  function formatOrderServices(services) {
    if (!Array.isArray(services) || services.length < 1) {
      return '-';
    }

    return services
      .map((service) => String(service.label || '').trim())
      .filter(Boolean)
      .join(', ');
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
      rows.push({
        serviceId: item.serviceId,
        label: `Farmeo de deseos - ${item.label} (Menos del 50% del mapa)`,
        priceCop: item.priceCop
      });
    });
    catalog.services.wishFarming.moreThan50.forEach((item) => {
      rows.push({
        serviceId: item.serviceId,
        label: `Farmeo de deseos - ${item.label} (Mas del 50% del mapa)`,
        priceCop: item.priceCop
      });
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

  async function fetchAdminConfig(apiBaseUrl) {
    const response = await fetch(`${apiBaseUrl}/admin/config`, {
      credentials: 'include'
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'No autorizado');
    }

    return data;
  }

  function redirectToLogin() {
    setTimeout(() => {
      window.location.href = '/login';
    }, 600);
  }

  window.SkirkConfigUtils = {
    fetchAdminConfig,
    flattenServices,
    formatCop,
    formatDate,
    formatOrderServices,
    formatPlatform,
    getApiBaseUrl,
    hasValidApiBaseUrl,
    redirectToLogin,
    showMessage
  };
})();
