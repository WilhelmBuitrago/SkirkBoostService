(function () {
  const apiBaseUrl = document.body.dataset.apiBaseUrl;
  const exchangeRateRaw = Number(document.body.dataset.exchangeRate);
  const exchangeRate = Number.isFinite(exchangeRateRaw) && exchangeRateRaw > 0 ? exchangeRateRaw : null;

  const cartItemsContainer = document.getElementById('cart-items');
  const subtotalCopLabel = document.getElementById('subtotal-cop');
  const subtotalUsdLabel = document.getElementById('subtotal-usd');
  const totalCopLabel = document.getElementById('total-cop');
  const totalUsdLabel = document.getElementById('total-usd');
  const checkoutForm = document.getElementById('checkout-form');
  const confirmButton = document.getElementById('confirm-order-btn');
  const contactoSelect = document.getElementById('contacto-select');
  const checkoutMessage = document.getElementById('checkout-message');
  const checkoutSummary = document.getElementById('checkout-summary');

  let currentSession = null;
  let currentContacts = [];

  function formatCop(value) {
    return new Intl.NumberFormat('es-CO').format(value);
  }

  function formatUsd(value) {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(value);
  }

  function convertCopToFinalUsd(priceCop) {
    if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
      return null;
    }

    const baseUsd = Number(priceCop || 0) / exchangeRate;
    if (!Number.isFinite(baseUsd) || baseUsd <= 0) {
      return 0;
    }

    const withFee = (baseUsd + 0.3) / 0.946;
    return Math.ceil(withFee) + 1;
  }

  function resolveServiceFamily(item) {
    if (item.serviceFamily) {
      return String(item.serviceFamily);
    }
    const id = String(item.serviceId || '');
    if (id.startsWith('missions.')) return 'missions';
    if (id.startsWith('wishFarming.')) return 'wishFarming';
    if (id.startsWith('maintenance.')) return 'maintenance';
    if (id.startsWith('zone.')) return 'exploration';
    if (id.startsWith('farming.ascension-personajes')) return 'ascension';
    if (id.startsWith('farming.')) return 'farming';
    return '';
  }

  function buildPriceText(item) {
    if (item.isVariablePrice) {
      const rangeCop = String(item.priceRangeCop || '').trim();
      return rangeCop ? `PRECIO VARIABLE: ${rangeCop} COP` : 'PRECIO VARIABLE';
    }

    const priceCop = Number(item.priceCop || 0);
    return `${formatCop(priceCop)} COP`;
  }

  function buildConfirmedLabel(item) {
    const family = resolveServiceFamily(item);
    const serviceName = String(item.serviceName || item.label || '').trim();
    const baseName = serviceName || String(item.label || '').trim();
    const priceText = buildPriceText(item);

    if (family === 'missions') {
      return `Realizacion de misiones - ${baseName} - ${priceText}`;
    }

    if (family === 'maintenance') {
      return `Mantenimiento de cuenta - ${baseName} (${priceText})`;
    }

    if (family === 'ascension') {
      const booksText = item.hasBooksSelected ? 'Tiene libros' : 'No tiene libros';
      return `Ascension de personajes - ${baseName} - (${booksText}) (${priceText})`;
    }

    if (family === 'farming') {
      if (baseName === '100 Cristalopteros') {
        return `Farmeo - ${baseName} (${priceText})`;
      }

      if (item.hasOwnedWeaponSelected) {
        return `Farmeo - ${baseName} - (Tiene arma/refinamiento) (PRECIO BASE: ${priceText})`;
      }

      if (item.hasBooksCheck) {
        const booksText = item.hasBooksSelected ? 'Tiene libros' : 'No tiene libros';
        return `Farmeo - ${baseName} - (${booksText}) (${priceText})`;
      }

      return `Farmeo - ${baseName} (${priceText})`;
    }

    if (family === 'wishFarming') {
      return `${String(item.label || baseName)} (${priceText})`;
    }

    if (family === 'exploration') {
      return `${String(item.label || baseName)} (${priceText})`;
    }

    return `${String(item.label || baseName)} (${priceText})`;
  }

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

  function showMessage(text, isError) {
    checkoutMessage.textContent = text;
    checkoutMessage.style.color = isError ? '#ff8b8b' : '#89f2f8';
  }

  function setConfirmEnabled(enabled) {
    if (!confirmButton) {
      return;
    }
    confirmButton.disabled = !enabled;
  }

  function formatPlatform(value) {
    const map = {
      whatsapp: 'WhatsApp',
      tiktok: 'TikTok',
      discord: 'Discord',
      instagram: 'Instagram'
    };

    return map[value] || value;
  }

  function renderContactOptions() {
    if (!contactoSelect) {
      return;
    }

    contactoSelect.innerHTML = '<option value="">Seleccionar...</option>';
    currentContacts.forEach((entry) => {
      const option = document.createElement('option');
      option.value = String(entry.id);
      option.textContent = `${formatPlatform(entry.plataforma)}: ${entry.contacto}${entry.es_principal ? ' (Principal)' : ''}`;
      contactoSelect.appendChild(option);
    });

    const principal = currentContacts.find((entry) => entry.es_principal) || currentContacts[0];
    if (principal) {
      contactoSelect.value = String(principal.id);
    }
  }

  function renderSummary(order) {
    if (!checkoutSummary) {
      return;
    }

    const lines = [];
    lines.push(`Confirmacion #${order.id}`);
    lines.push(`Correo: ${order.email}`);
    lines.push(`Usuario: ${order.usuario}`);
    lines.push(`Contacto: ${formatPlatform(order.contacto.plataforma)} - ${order.contacto.contacto}`);
    lines.push(`Metodo de pago: ${order.metodoPago}`);
    lines.push(`Servicios:`);
    order.services.forEach((service) => {
      lines.push(`- ${service.label}`);
    });
    lines.push(`Total: $ ${formatCop(order.totalCop)} COP`);
    if (Number.isFinite(Number(order.totalUsd))) {
      lines.push(`Total USD: $ ${formatUsd(Number(order.totalUsd))} USD`);
    }

    checkoutSummary.textContent = lines.join('\n');
    checkoutSummary.classList.remove('hidden');
  }

  async function loadSessionState() {
    if (!apiBaseUrl || !/^https?:\/\//.test(apiBaseUrl)) {
      setConfirmEnabled(false);
      showMessage('Configuracion API invalida.', true);
      return;
    }

    try {
      const response = await fetch(`${apiBaseUrl}/auth/me`, { credentials: 'include' });
      if (!response.ok) {
        throw new Error('No autenticado');
      }

      const data = await response.json();
      if (!data.authenticated) {
        throw new Error('No autenticado');
      }

      currentSession = data;
      currentContacts = Array.isArray(data.contacts) ? data.contacts : [];
      renderContactOptions();

      if (!data.profileComplete) {
        setConfirmEnabled(false);
        showMessage('Tu perfil esta incompleto. Debes registrar correo y al menos un contacto.', true);
        return;
      }

      if (currentContacts.length < 1) {
        setConfirmEnabled(false);
        showMessage('No tienes contactos para confirmar el pedido.', true);
        return;
      }

      setConfirmEnabled(true);
      showMessage('Listo para confirmar.', false);
    } catch (_error) {
      currentSession = null;
      currentContacts = [];
      renderContactOptions();
      setConfirmEnabled(false);
      showMessage('Debes iniciar sesion para confirmar.', true);
    }
  }

  function render() {
    const items = getCart();
    cartItemsContainer.innerHTML = '';

    let subtotalCop = 0;
    let subtotalUsd = 0;

    items.forEach((item) => {
      const card = document.createElement('article');
      card.className = 'mini-card';

      const name = document.createElement('h3');
      name.textContent = item.label;

      const copText = document.createElement('p');
      const usdText = document.createElement('p');
      const isVariablePrice = Boolean(item.isVariablePrice);
      const numericPriceCop = Number(item.priceCop || 0);

      if (isVariablePrice) {
        const rangeCop = String(item.priceRangeCop || '').trim();
        const rangeUsd = String(item.priceRangeUsd || '').trim();
        copText.textContent = rangeCop ? `Precio variable: $ ${rangeCop} COP` : 'Precio variable';
        usdText.textContent = rangeUsd ? `Precio variable: $ ${rangeUsd} USD` : 'Precio variable';
      } else {
        subtotalCop += numericPriceCop;
        copText.textContent = `$ ${formatCop(numericPriceCop)} COP`;
        const serviceUsd = convertCopToFinalUsd(numericPriceCop);
        if (serviceUsd === null) {
          usdText.textContent = 'USD no disponible';
        } else {
          subtotalUsd += serviceUsd;
          usdText.textContent = `$ ${formatUsd(serviceUsd)} USD`;
        }
      }

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-secondary';
      removeBtn.type = 'button';
      removeBtn.textContent = 'Eliminar';
      removeBtn.addEventListener('click', () => {
        const nextItems = getCart().filter((entry) => entry.id !== item.id);
        saveCart(nextItems);
        render();
      });

      card.appendChild(name);
      card.appendChild(copText);
      card.appendChild(usdText);

      if (item.hasOwnedWeaponSelected) {
        const ownershipNote = document.createElement('p');
        ownershipNote.className = 'small-note';
        ownershipNote.textContent = 'Observacion: precio base. Puede bajar si tienes arma/refinamiento.';
        card.appendChild(ownershipNote);
      }

      if (resolveServiceFamily(item) === 'ascension') {
        const booksNote = document.createElement('p');
        booksNote.className = 'small-note';
        booksNote.textContent = item.hasBooksSelected ? 'Incluye estado: Tiene libros.' : 'Incluye estado: No tiene libros.';
        card.appendChild(booksNote);
      }

      card.appendChild(removeBtn);
      cartItemsContainer.appendChild(card);
    });

    subtotalCopLabel.textContent = formatCop(subtotalCop);
    subtotalUsdLabel.textContent = Number.isFinite(subtotalUsd) ? formatUsd(subtotalUsd) : '-';
    totalCopLabel.textContent = formatCop(subtotalCop);
    totalUsdLabel.textContent = Number.isFinite(subtotalUsd) ? formatUsd(subtotalUsd) : '-';
  }

  checkoutForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!currentSession || !currentSession.authenticated) {
      setConfirmEnabled(false);
      showMessage('Debes iniciar sesion para confirmar.', true);
      return;
    }

    if (!currentSession.profileComplete) {
      setConfirmEnabled(false);
      showMessage('Tu perfil esta incompleto. Completa tus datos para confirmar.', true);
      return;
    }

    const formData = new FormData(checkoutForm);
    const contactoId = Number(formData.get('contactoId'));
    const metodoPago = String(formData.get('metodoPago') || '').trim();

    const selectedContact = currentContacts.find((entry) => entry.id === contactoId);
    if (!selectedContact) {
      showMessage('Debes seleccionar un contacto valido.', true);
      return;
    }

    if (!['Nequi', 'PayPal'].includes(metodoPago)) {
      showMessage('Metodo de pago invalido.', true);
      return;
    }

    const items = getCart();
    if (items.length < 1) {
      showMessage('Tu carrito esta vacio.', true);
      return;
    }

    const payloadItems = items.map((item) => ({
      id: item.id,
      serviceId: item.serviceId,
      label: buildConfirmedLabel(item),
      priceCop: item.isVariablePrice ? null : Number(item.priceCop || 0),
      isVariablePrice: Boolean(item.isVariablePrice),
      priceRangeCop: item.priceRangeCop || ''
    }));

    try {
      setConfirmEnabled(false);
      const response = await fetch(`${apiBaseUrl}/orders`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          servicios: payloadItems,
          contactoId,
          metodoPago
        })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'No se pudo confirmar la orden.');
      }

      showMessage('Orden confirmada correctamente.', false);
      renderSummary(data.order);
      saveCart([]);
      render();
      setConfirmEnabled(true);
    } catch (error) {
      setConfirmEnabled(true);
      showMessage(error.message, true);
    }
  });

  render();
  loadSessionState();
})();
