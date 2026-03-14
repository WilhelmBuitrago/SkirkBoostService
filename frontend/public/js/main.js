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
      priceCop: payload.priceCop
    });
    saveCart(current);
    return { ok: true };
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
          usdNode.textContent = hasPrice ? formatUsd(priceCop / rate) : '-';
        }

        addButton.dataset.serviceId = hasPrice && selectedOption ? String(selectedOption.serviceId || '') : '';
        addButton.dataset.price = hasPrice ? String(priceCop) : '';
        addButton.dataset.label = `Farmeo de deseos - ${quantityText} (${mapText})`;
        addButton.disabled = !hasPrice;
      }

      quantitySelect.addEventListener('change', syncState);
      mapSelect.addEventListener('change', syncState);
      syncState();
    });
  }

  const pageRate = document.body ? Number(document.body.dataset.exchangeRate) : NaN;
  const rate = Number.isFinite(pageRate) && pageRate > 0 ? pageRate : 2857;

  initWishFarmingBuilder(rate);

  document.querySelectorAll('.farming-card').forEach((card) => {
    const baseCop = Number(card.dataset.price || 0);
    const booksCop = Number(card.dataset.booksPrice || 0);
    const ownedWeapon = card.querySelector('.js-owned-weapon');
    const haveBooks = card.querySelector('.js-have-books');
    const copLabel = card.querySelector('.js-farm-price-cop');
    const usdLabel = card.querySelector('.js-farm-price-usd');
    const contactNote = card.querySelector('.contact-note');

    function setPrice(copValue) {
      if (!copLabel || !usdLabel) {
        return;
      }
      copLabel.textContent = formatCop(copValue);
      usdLabel.textContent = formatUsd(copValue / rate);
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
      });
    }

    if (haveBooks) {
      haveBooks.addEventListener('change', () => {
        const currentPrice = haveBooks.checked && booksCop > 0 ? booksCop : baseCop;
        setPrice(currentPrice);
      });
    }
  });

  document.querySelectorAll('.js-add-cart').forEach((button) => {
    button.addEventListener('click', () => {
      const card = button.closest('.is-disabled');
      if (card) {
        return;
      }

      const priceCop = Number(button.dataset.price || 0);
      if (!Number.isFinite(priceCop) || priceCop <= 0) {
        return;
      }

      const result = addToCart({
        serviceId: button.dataset.serviceId,
        label: button.dataset.label,
        priceCop
      });

      if (!result.ok) {
        window.alert(result.error);
      }
    });
  });
})();
