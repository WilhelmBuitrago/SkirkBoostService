(function () {
  const apiBaseUrl = document.body.dataset.apiBaseUrl;
  const message = document.getElementById('perfil-message');
  const userBox = document.getElementById('perfil-user');
  const tableBody = document.getElementById('orders-table-body');

  function showMessage(text, isError) {
    if (!message) {
      return;
    }

    message.textContent = text;
    message.style.color = isError ? '#ff8b8b' : '#89f2f8';
  }

  function safeParseJson(response) {
    return response.json().catch(() => ({}));
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

  function renderUserInfo(payload) {
    if (!userBox) {
      return;
    }

    userBox.classList.remove('hidden');
    userBox.textContent = [
      `Usuario: ${payload.user.usuario}`,
      `Correo: ${payload.user.email || '-'}`,
      `Rol: ${payload.user.role}`
    ].join('\n');
  }

  function renderOrders(orders) {
    if (!tableBody) {
      return;
    }

    tableBody.innerHTML = '';

    if (!orders.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 4;
      cell.textContent = 'No tienes pedidos registrados.';
      row.appendChild(cell);
      tableBody.appendChild(row);
      return;
    }

    orders.forEach((order) => {
      const row = document.createElement('tr');

      const idCell = document.createElement('td');
      idCell.textContent = String(order.id);

      const servicesCell = document.createElement('td');
      const labels = Array.isArray(order.services)
        ? order.services.map((service) => service.label).filter(Boolean)
        : [];
      servicesCell.textContent = labels.length > 0 ? labels.join(', ') : '-';

      const statusCell = document.createElement('td');
      statusCell.textContent = order.estado || '-';

      const dateCell = document.createElement('td');
      dateCell.textContent = formatDate(order.createdAt);

      row.appendChild(idCell);
      row.appendChild(servicesCell);
      row.appendChild(statusCell);
      row.appendChild(dateCell);

      tableBody.appendChild(row);
    });
  }

  async function loadProfile() {
    if (!apiBaseUrl || !/^https?:\/\//.test(apiBaseUrl)) {
      showMessage('Configuracion API invalida.', true);
      return;
    }

    try {
      const authResponse = await fetch(`${apiBaseUrl}/auth/me`, {
        credentials: 'include'
      });

      if (authResponse.status === 401 || authResponse.status === 403) {
        throw new Error('Debes iniciar sesion para ver tu perfil.');
      }

      if (!authResponse.ok) {
        throw new Error('No fue posible verificar tu sesion en este momento.');
      }

      const authData = await safeParseJson(authResponse);
      if (!authData.authenticated) {
        throw new Error('Debes iniciar sesion para ver tu perfil.');
      }

      renderUserInfo(authData);

      const ordersResponse = await fetch(`${apiBaseUrl}/orders`, {
        credentials: 'include'
      });

      if (ordersResponse.status === 401 || ordersResponse.status === 403) {
        throw new Error('Debes iniciar sesion para ver tu perfil.');
      }

      const ordersData = await safeParseJson(ordersResponse);

      if (!ordersResponse.ok) {
        showMessage(ordersData.error || 'No fue posible cargar tus pedidos por un error interno.', true);
        renderOrders([]);
        return;
      }

      const orders = Array.isArray(ordersData.orders) ? ordersData.orders : [];
      renderOrders(orders);
      showMessage('Pedidos cargados.', false);
    } catch (error) {
      showMessage(error.message, true);

      if (error.message === 'Debes iniciar sesion para ver tu perfil.') {
        setTimeout(() => {
          window.location.href = '/login';
        }, 800);
      }
    }
  }

  loadProfile();
})();
