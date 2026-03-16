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

  function addToCart(payload) {
    if (!payload || !payload.serviceId) {
      return { ok: false, error: 'Servicio invalido.' };
    }

    const current = getCart();
    const duplicated = current.some((entry) => entry.serviceId === payload.serviceId);
    if (duplicated) {
      return { ok: false, error: 'Este servicio ya esta en el carrito. Eliminalo antes de volver a agregarlo.' };
    }

    current.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      serviceId: payload.serviceId,
      label: payload.label,
      priceCop: payload.priceCop,
      isVariablePrice: Boolean(payload.isVariablePrice),
      priceRangeCop: payload.priceRangeCop || '',
      priceRangeUsd: payload.priceRangeUsd || '',
      serviceFamily: payload.serviceFamily || '',
      serviceName: payload.serviceName || payload.label || '',
      hasOwnedWeaponSelected: Boolean(payload.hasOwnedWeaponSelected),
      hasBooksSelected: Boolean(payload.hasBooksSelected),
      hasBooksCheck: Boolean(payload.hasBooksCheck),
      basePriceCop: Number.isFinite(Number(payload.basePriceCop)) ? Number(payload.basePriceCop) : null
    });
    saveCart(current);
    return { ok: true };
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

  function readWishOptions() {
    const source = document.getElementById('wish-farming-options');
    if (!source) {
      return null;
    }

    try {
      const parsed = JSON.parse(source.textContent || '{}');
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      return parsed;
    } catch (_error) {
      return null;
    }
  }

  function getWishMapText(mapValue) {
    return mapValue === 'moreThan50' ? 'Mas del 50% del mapa' : 'Menos del 50% del mapa';
  }

  function initWishFarmingBuilder(rate) {
    const options = readWishOptions();
    if (!options) {
      return;
    }

    document.querySelectorAll('.wish-farming-builder').forEach((card) => {
      const quantitySelect = card.querySelector('.js-wish-quantity');
      const mapSelect = card.querySelector('.js-wish-map');
      const copNode = card.querySelector('.js-wish-price-cop');
      const usdNode = card.querySelector('.js-wish-price-usd');
      const addButton = card.querySelector('.js-add-cart-wish');
      const isCardAvailable = card.dataset.wishAvailable !== '0';

      if (!quantitySelect || !mapSelect || !addButton) {
        return;
      }

      function syncState() {
        const quantity = String(quantitySelect.value || '');
        const mapValue = String(mapSelect.value || 'lessThan50');
        const mapEntries = options[mapValue] || {};
        const selectedOption = mapEntries[quantity] || null;
        const priceCop = Number(selectedOption ? selectedOption.priceCop : 0);
        const hasPrice = isCardAvailable && Number.isFinite(priceCop) && priceCop > 0;
        const quantityText = selectedOption && selectedOption.label ? selectedOption.label : `${quantity} deseos`;
        const mapText = getWishMapText(mapValue);

        if (copNode) {
          copNode.textContent = hasPrice ? formatCop(priceCop) : '-';
        }
        if (usdNode) {
          const usdValue = hasPrice ? convertCopToFinalUsd(priceCop, rate) : null;
          usdNode.textContent = hasPrice && usdValue !== null ? formatUsd(usdValue) : '-';
        }

        addButton.dataset.serviceId = hasPrice && selectedOption ? String(selectedOption.serviceId || '') : '';
        addButton.dataset.price = hasPrice ? String(priceCop) : '';
        addButton.dataset.label = `Farmeo de deseos - ${quantityText} (${mapText})`;
        addButton.dataset.serviceFamily = 'wishFarming';
        addButton.dataset.serviceName = quantityText;
        addButton.disabled = !hasPrice;
      }

      quantitySelect.addEventListener('change', syncState);
      mapSelect.addEventListener('change', syncState);
      syncState();
    });
  }

  const pageRate = document.body ? Number(document.body.dataset.exchangeRate) : NaN;
  const rate = Number.isFinite(pageRate) && pageRate > 0 ? pageRate : null;

  initWishFarmingBuilder(rate);

  document.querySelectorAll('.farming-card').forEach((card) => {
    const baseCop = Number(card.dataset.price || 0);
    const booksCop = Number(card.dataset.booksPrice || 0);
    const hasOwnedCheck = card.dataset.hasOwnedCheck === '1';
    const hasBooksCheck = card.dataset.hasBooksCheck === '1';
    const serviceName = card.dataset.serviceName || '';
    const ownedWeapon = card.querySelector('.js-owned-weapon');
    const haveBooks = card.querySelector('.js-have-books');
    const addButton = card.querySelector('.js-add-cart');
    const copLabel = card.querySelector('.js-farm-price-cop');
    const usdLabel = card.querySelector('.js-farm-price-usd');
    const contactNote = card.querySelector('.contact-note');

    function syncFarmingPayload() {
      if (!addButton) {
        return;
      }

      const hasBooksSelected = Boolean(haveBooks && haveBooks.checked && booksCop > 0);
      const currentPrice = hasBooksSelected ? booksCop : baseCop;
      addButton.dataset.price = String(currentPrice);
      addButton.dataset.serviceName = serviceName || addButton.dataset.label || '';
      addButton.dataset.hasOwnedWeaponSelected = hasOwnedCheck && ownedWeapon ? String(ownedWeapon.checked) : 'false';
      addButton.dataset.hasBooksSelected = hasBooksCheck && haveBooks ? String(haveBooks.checked) : 'false';
      addButton.dataset.hasBooksCheck = hasBooksCheck ? '1' : '0';
      addButton.dataset.basePrice = Number.isFinite(baseCop) ? String(baseCop) : '';
    }

    function setPrice(copValue) {
      if (!copLabel || !usdLabel) {
        return;
      }
      copLabel.textContent = formatCop(copValue);
      const usdValue = convertCopToFinalUsd(copValue, rate);
      usdLabel.textContent = usdValue === null ? '-' : formatUsd(usdValue);
    }

    if (ownedWeapon) {
      ownedWeapon.addEventListener('change', () => {
        if (!contactNote) {
          return;
        }
        if (ownedWeapon.checked) {
          contactNote.classList.remove('hidden');
        } else {
          contactNote.classList.add('hidden');
        }
        syncFarmingPayload();
      });
    }

    if (haveBooks) {
      haveBooks.addEventListener('change', () => {
        const currentPrice = haveBooks.checked && booksCop > 0 ? booksCop : baseCop;
        setPrice(currentPrice);
        syncFarmingPayload();
      });
    }

    syncFarmingPayload();
  });

  document.querySelectorAll('.js-add-cart').forEach((button) => {
    button.addEventListener('click', () => {
      const card = button.closest('.is-disabled');
      if (card) {
        return;
      }

      const isVariablePrice = button.dataset.variablePrice === '1';
      const priceCop = Number(button.dataset.price || 0);
      if (!isVariablePrice && (!Number.isFinite(priceCop) || priceCop <= 0)) {
        return;
      }

      const result = addToCart({
        serviceId: button.dataset.serviceId,
        label: button.dataset.label,
        priceCop: isVariablePrice ? null : priceCop,
        isVariablePrice,
        priceRangeCop: button.dataset.priceRangeCop || '',
        priceRangeUsd: button.dataset.priceRangeUsd || '',
        serviceFamily: button.dataset.serviceFamily || '',
        serviceName: button.dataset.serviceName || button.dataset.label,
        hasOwnedWeaponSelected: button.dataset.hasOwnedWeaponSelected === 'true',
        hasBooksSelected: button.dataset.hasBooksSelected === 'true',
        hasBooksCheck: button.dataset.hasBooksCheck === '1',
        basePriceCop: button.dataset.basePrice
      });

      if (!result.ok) {
        window.alert(result.error);
      }
    });
  });
})();
