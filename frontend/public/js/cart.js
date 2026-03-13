(function () {
  const exchangeRateRaw = Number(document.body.dataset.exchangeRate || 2857);
  const exchangeRate = Number.isFinite(exchangeRateRaw) && exchangeRateRaw > 0 ? exchangeRateRaw : 2857;

  const cartItemsContainer = document.getElementById('cart-items');
  const subtotalCopLabel = document.getElementById('subtotal-cop');
  const subtotalUsdLabel = document.getElementById('subtotal-usd');
  const totalCopLabel = document.getElementById('total-cop');
  const totalUsdLabel = document.getElementById('total-usd');
  const checkoutForm = document.getElementById('checkout-form');
  const checkoutMessage = document.getElementById('checkout-message');

  function formatCop(value) {
    return new Intl.NumberFormat('es-CO').format(value);
  }

  function formatUsd(value) {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value);
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

  function getCheckoutInfo() {
    const raw = sessionStorage.getItem('skirk-checkout');
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch (_error) {
      return null;
    }
  }

  function setCheckoutInfo(info) {
    sessionStorage.setItem('skirk-checkout', JSON.stringify(info));
  }

  function render() {
    const items = getCart();
    cartItemsContainer.innerHTML = '';

    let subtotalCop = 0;

    items.forEach((item) => {
      const card = document.createElement('article');
      card.className = 'mini-card';

      const name = document.createElement('h3');
      name.textContent = item.label;

      const priceCop = Number(item.priceCop || 0);
      subtotalCop += priceCop;

      const copText = document.createElement('p');
      copText.textContent = `$ ${formatCop(priceCop)} COP`;

      const usdText = document.createElement('p');
      usdText.textContent = `$ ${formatUsd(priceCop / exchangeRate)} USD`;

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
      card.appendChild(removeBtn);
      cartItemsContainer.appendChild(card);
    });

    const subtotalUsd = subtotalCop / exchangeRate;
    subtotalCopLabel.textContent = formatCop(subtotalCop);
    subtotalUsdLabel.textContent = formatUsd(subtotalUsd);
    totalCopLabel.textContent = formatCop(subtotalCop);
    totalUsdLabel.textContent = formatUsd(subtotalUsd);
  }

  checkoutForm.addEventListener('submit', (event) => {
    event.preventDefault();

    const formData = new FormData(checkoutForm);
    const contactMethod = formData.get('contactMethod');
    const paymentMethod = formData.get('paymentMethod');

    const allowedContact = new Set(['TikTok', 'Instagram', 'Discord']);
    const allowedPayment = new Set(['Nequi', 'PayPal']);

    if (!allowedContact.has(contactMethod)) {
      checkoutMessage.textContent = 'Metodo de contacto invalido.';
      checkoutMessage.style.color = '#ff8b8b';
      return;
    }

    if (!allowedPayment.has(paymentMethod)) {
      checkoutMessage.textContent = 'Metodo de pago invalido.';
      checkoutMessage.style.color = '#ff8b8b';
      return;
    }

    const payload = {
      contactMethod,
      paymentMethod,
      updatedAt: new Date().toISOString(),
      items: getCart()
    };

    setCheckoutInfo(payload);
    checkoutMessage.textContent = 'Informacion guardada temporalmente en esta sesion.';
    checkoutMessage.style.color = '#89f2f8';
  });

  const previousInfo = getCheckoutInfo();
  if (previousInfo) {
    checkoutForm.elements.contactMethod.value = previousInfo.contactMethod || '';
    checkoutForm.elements.paymentMethod.value = previousInfo.paymentMethod || '';
  }

  render();
})();
