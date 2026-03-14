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

  const pageRate = document.body ? Number(document.body.dataset.exchangeRate) : NaN;
  const rate = Number.isFinite(pageRate) && pageRate > 0 ? pageRate : 2857;

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
