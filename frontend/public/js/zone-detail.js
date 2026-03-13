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
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value);
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
    exchangeRate: Number.isFinite(exchangeRate) && exchangeRate > 0 ? exchangeRate : 2857
  };

  const missionChecks = document.querySelectorAll('.js-mission');
  const totalCop = document.getElementById('total-cop');
  const totalUsd = document.getElementById('total-usd');
  const confirmBtn = document.getElementById('confirm-btn');
  const addCartBtn = document.getElementById('add-cart-zone-btn');

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
    totalUsd.textContent = formatUsd(total / Number(zoneData.exchangeRate || 2857));
    return total;
  }

  missionChecks.forEach((missionInput) => {
    missionInput.addEventListener('change', calculateTotal);
  });

  calculateTotal();

  if (confirmBtn) {
    confirmBtn.addEventListener('click', () => {
      if (!zoneAvailable) {
        window.alert('Este servicio no esta disponible por estado de plataforma.');
        return;
      }

      const currentTotal = calculateTotal();
      const selectedMissions = getSelectedMissionNames();
      const missionLabel = selectedMissions ? ` | Misiones: ${selectedMissions}` : '';
      window.alert(
        `Solicitud confirmada para ${zoneData.name}. Total: $ ${formatCop(currentTotal)} COP ($ ${formatUsd(
          currentTotal / Number(zoneData.exchangeRate || 2857)
        )} USD)${missionLabel}`
      );
    });
  }

  if (addCartBtn) {
    addCartBtn.addEventListener('click', () => {
      if (!zoneAvailable) {
        window.alert('Este servicio no esta disponible por estado de plataforma.');
        return;
      }

      const currentTotal = calculateTotal();
      const selectedMissions = getSelectedMissionNames();
      const current = getCart();
      current.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        serviceId: zoneServiceId,
        label: selectedMissions ? `Exploracion - ${zoneData.name} (${selectedMissions})` : `Exploracion - ${zoneData.name}`,
        priceCop: currentTotal
      });
      saveCart(current);
      window.alert('Exploracion agregada al carrito.');
    });
  }
})();
