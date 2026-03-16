(function () {
  function getCart() {
    const raw = sessionStorage.getItem('skirk-cart');
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }

  function saveCart(items) {
    sessionStorage.setItem('skirk-cart', JSON.stringify(items));
    document.dispatchEvent(new CustomEvent('skirk-cart-updated'));
  }

  function formatCop(value) {
    return new Intl.NumberFormat('es-CO').format(value);
  }

  function formatUsd(value) {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(value);
  }

  function convertCopToFinalUsd(priceCop, rateValue) {
    if (!Number.isFinite(rateValue) || rateValue <= 0) {
      return null;
    }

    const baseUsd = Number(priceCop || 0) / rateValue;
    if (!Number.isFinite(baseUsd) || baseUsd <= 0) {
      return 0;
    }

    const withFee = (baseUsd + 0.3) / 0.946;
    return Math.ceil(withFee) + 1;
  }

  const zoneName = document.body ? document.body.dataset.zoneName : '';
  const zoneId = document.body ? document.body.dataset.zoneId : '';
  const zoneServiceId = document.body ? document.body.dataset.zoneServiceId : '';
  const basePriceCop = document.body ? Number(document.body.dataset.zoneBaseCop) : NaN;
  const zoneAvailable = document.body ? document.body.dataset.zoneAvailable === 'true' : false;
  const exchangeRate = document.body ? Number(document.body.dataset.exchangeRate) : NaN;
  if (!zoneName || !zoneId || !Number.isFinite(basePriceCop)) {
    return;
  }

  const zoneData = {
    name: zoneName,
    id: zoneId,
    basePriceCop,
    exchangeRate: Number.isFinite(exchangeRate) && exchangeRate > 0 ? exchangeRate : null
  };

  const missionChecks = document.querySelectorAll('.js-mission');
  const totalCop = document.getElementById('total-cop');
  const totalUsd = document.getElementById('total-usd');
  const addCartBtn = document.getElementById('add-cart-zone-btn');
  const zoneCartMessage = document.getElementById('zone-cart-message');

  function showZoneMessage(text, isError) {
    if (!zoneCartMessage) {
      return;
    }
    zoneCartMessage.textContent = text;
    zoneCartMessage.style.color = isError ? '#ff8b8b' : '#89f2f8';
  }

  function getSelectedMissionNames() {
    return Array.from(missionChecks)
      .filter((input) => input.checked)
      .map((input) => input.dataset.missionName)
      .join(', ');
  }

  function calculateTotal() {
    let total = Number(zoneData.basePriceCop || 0);

    missionChecks.forEach((missionInput) => {
      if (missionInput.checked) {
        total += Number(missionInput.dataset.price || 0);
      }
    });

    totalCop.textContent = formatCop(total);
    const totalFinalUsd = convertCopToFinalUsd(total, zoneData.exchangeRate);
    totalUsd.textContent = totalFinalUsd === null ? '-' : formatUsd(totalFinalUsd);
    return total;
  }

  missionChecks.forEach((missionInput) => {
    missionInput.addEventListener('change', calculateTotal);
  });

  calculateTotal();

  if (addCartBtn) {
    addCartBtn.addEventListener('click', () => {
      if (!zoneAvailable) {
        showZoneMessage('Este servicio no esta disponible por estado de plataforma.', true);
        return;
      }

      const currentTotal = calculateTotal();
      const selectedMissions = getSelectedMissionNames();
      const current = getCart();
      const duplicated = current.some((entry) => entry.serviceId === zoneServiceId);
      if (duplicated) {
        showZoneMessage('Esta exploracion ya esta en el carrito. Debes eliminarla antes de volver a agregarla.', true);
        return;
      }

      current.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        serviceId: zoneServiceId,
        label: selectedMissions ? `Exploracion - ${zoneData.name} (${selectedMissions})` : `Exploracion - ${zoneData.name}`,
        priceCop: currentTotal,
        serviceFamily: 'exploration',
        serviceName: zoneData.name
      });
      saveCart(current);
      showZoneMessage('Exploracion agregada al carrito.', false);
    });
  }
})();
