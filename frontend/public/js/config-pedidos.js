(function () {
  const utils = window.SkirkConfigUtils;
  const apiBaseUrl = utils.getApiBaseUrl();
  const ordersSearchInput = document.getElementById('orders-search');
  const ordersStatusFilter = document.getElementById('orders-status-filter');
  const ordersTableBody = document.getElementById('orders-table-body');
  const message = document.getElementById('config-message');
  const orderStatusValues = ['Cotizacion', 'En espera', 'Realizando', 'Finalizado'];

  let allOrders = [];
  let ordersSearchTimeout = null;

  async function updateOrderStatus(orderId, estado) {
    const response = await fetch(`${apiBaseUrl}/admin/orders/${orderId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ estado })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'No fue posible actualizar el estado del pedido');
    }

    return data.order;
  }

  async function removeOrder(orderId) {
    const response = await fetch(`${apiBaseUrl}/admin/orders/${orderId}`, {
      method: 'DELETE',
      credentials: 'include'
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'No fue posible eliminar el pedido');
    }

    return data;
  }

  function renderOrdersTable() {
    if (!ordersTableBody) {
      return;
    }

    ordersTableBody.innerHTML = '';

    if (allOrders.length < 1) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 8;
      cell.textContent = 'No hay pedidos para los filtros actuales.';
      row.appendChild(cell);
      ordersTableBody.appendChild(row);
      return;
    }

    allOrders.forEach((order) => {
      const row = document.createElement('tr');

      const idCell = document.createElement('td');
      idCell.textContent = String(order.id);

      const userCell = document.createElement('td');
      userCell.textContent = order.usuario || '-';

      const emailCell = document.createElement('td');
      emailCell.textContent = order.email || '-';

      const contactCell = document.createElement('td');
      const platform = order.contacto && order.contacto.plataforma ? utils.formatPlatform(order.contacto.plataforma) : '-';
      const contactValue = order.contacto && order.contacto.contacto ? order.contacto.contacto : '-';
      contactCell.textContent = `${platform}: ${contactValue}`;

      const paymentCell = document.createElement('td');
      paymentCell.textContent = order.metodoPago || '-';

      const servicesCell = document.createElement('td');
      servicesCell.textContent = utils.formatOrderServices(order.services);

      const statusCell = document.createElement('td');
      const statusSelect = document.createElement('select');
      statusSelect.className = 'text-input users-input';
      orderStatusValues.forEach((status) => {
        const option = document.createElement('option');
        option.value = status;
        option.textContent = status;
        statusSelect.appendChild(option);
      });
      statusSelect.value = order.estado;
      statusCell.appendChild(statusSelect);

      const actionsCell = document.createElement('td');
      actionsCell.className = 'users-actions';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn-secondary';
      saveBtn.textContent = 'Guardar';
      saveBtn.addEventListener('click', async () => {
        try {
          const updated = await updateOrderStatus(order.id, statusSelect.value);
          const index = allOrders.findIndex((entry) => entry.id === order.id);
          if (index >= 0) {
            allOrders[index] = updated;
          }
          utils.showMessage(message, 'Estado del pedido actualizado.', false);
          renderOrdersTable();
        } catch (error) {
          utils.showMessage(message, error.message, true);
        }
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn-secondary';
      deleteBtn.textContent = 'Eliminar';
      deleteBtn.addEventListener('click', async () => {
        const accepted = window.confirm(`Eliminar pedido #${order.id}?`);
        if (!accepted) {
          return;
        }

        try {
          await removeOrder(order.id);
          allOrders = allOrders.filter((entry) => entry.id !== order.id);
          utils.showMessage(message, 'Pedido eliminado.', false);
          renderOrdersTable();
        } catch (error) {
          utils.showMessage(message, error.message, true);
        }
      });

      actionsCell.appendChild(saveBtn);
      actionsCell.appendChild(deleteBtn);

      row.appendChild(idCell);
      row.appendChild(userCell);
      row.appendChild(emailCell);
      row.appendChild(contactCell);
      row.appendChild(paymentCell);
      row.appendChild(servicesCell);
      row.appendChild(statusCell);
      row.appendChild(actionsCell);

      ordersTableBody.appendChild(row);
    });
  }

  async function loadOrders() {
    try {
      const q = ordersSearchInput ? ordersSearchInput.value.trim() : '';
      const estado = ordersStatusFilter ? String(ordersStatusFilter.value || '').trim() : '';
      const params = new URLSearchParams();
      if (q) {
        params.set('q', q);
      }
      if (estado) {
        params.set('estado', estado);
      }

      const query = params.toString();
      const url = query ? `${apiBaseUrl}/admin/orders?${query}` : `${apiBaseUrl}/admin/orders`;
      const response = await fetch(url, {
        credentials: 'include'
      });
      const data = await response.json();

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('No autorizado');
        }
        throw new Error(data.error || 'No se pudieron cargar los pedidos');
      }

      allOrders = Array.isArray(data.orders) ? data.orders : [];
      renderOrdersTable();
    } catch (error) {
      utils.showMessage(message, error.message, true);
      if (String(error.message || '').toLowerCase().includes('autoriz')) {
        utils.redirectToLogin();
      }
    }
  }

  if (!utils.hasValidApiBaseUrl(apiBaseUrl)) {
    utils.showMessage(message, 'Configuracion API invalida. Contacta al administrador.', true);
    return;
  }

  if (ordersSearchInput) {
    ordersSearchInput.addEventListener('input', () => {
      if (ordersSearchTimeout) {
        clearTimeout(ordersSearchTimeout);
      }

      ordersSearchTimeout = setTimeout(() => {
        loadOrders();
      }, 180);
    });
  }

  if (ordersStatusFilter) {
    ordersStatusFilter.addEventListener('change', () => {
      loadOrders();
    });
  }

  loadOrders();
})();
