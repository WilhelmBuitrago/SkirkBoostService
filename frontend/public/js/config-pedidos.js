(function () {
  const utils = window.SkirkConfigUtils;
  const apiBaseUrl = utils.getApiBaseUrl();
  const ordersSearchInput = document.getElementById('orders-search');
  const ordersStatusFilter = document.getElementById('orders-status-filter');
  const ordersTableBody = document.getElementById('orders-table-body');
  const message = document.getElementById('config-message');
  const ORDER_STATUS_VALUES = ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
  const STATUS_LABELS = {
    PENDING: 'Pendiente',
    NOTIFIED: 'Notificado',
    IN_PROGRESS: 'En progreso',
    COMPLETED: 'Completado',
    FAILED_NOTIFY: 'Fallo notificacion',
    CANCELLED: 'Cancelado'
  };
  const NOTIFICATION_LABELS = {
    pending: 'Pendiente',
    retry: 'Reintento',
    sent: 'Enviada',
    failed: 'Fallida'
  };

  let allOrders = [];
  let ordersSearchTimeout = null;

  function toStatusLabel(status) {
    return STATUS_LABELS[status] || status || '-';
  }

  function toNotificationLabel(status) {
    return NOTIFICATION_LABELS[status] || status || '-';
  }

  function toServicesLabel(order) {
    const list = Array.isArray(order && order.services)
      ? order.services
      : [];
    const labels = list
      .map((service) => (service && service.label ? String(service.label).trim() : ''))
      .filter(Boolean);

    if (labels.length > 0) {
      return labels.join(', ');
    }

    return 'Sin detalle historico';
  }

  async function updateOrderStatus(orderId, status) {
    const response = await fetch(`${apiBaseUrl}/orders/admin/${orderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ status })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'No fue posible actualizar el estado del pedido');
    }

    return data.order;
  }

  async function removeOrder(orderId) {
    const response = await fetch(`${apiBaseUrl}/orders/admin/${orderId}`, {
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
      cell.colSpan = 9;
      cell.textContent = 'No hay pedidos para los filtros actuales.';
      row.appendChild(cell);
      ordersTableBody.appendChild(row);
      return;
    }

    allOrders.forEach((order) => {
      const row = document.createElement('tr');

      const idCell = document.createElement('td');
      idCell.textContent = String(order.orderId || '-');

      const userCell = document.createElement('td');
      userCell.textContent = order.usuario || '-';

      const emailCell = document.createElement('td');
      emailCell.textContent = order.email || '-';

      const servicesCell = document.createElement('td');
      servicesCell.textContent = toServicesLabel(order);

      const totalCell = document.createElement('td');
      const totalCop = Number(order.totalCop || 0);
      const totalUsd = Number(order.totalUsd || 0);
      totalCell.textContent = `${utils.formatCop(totalCop)} COP / ${totalUsd.toFixed(2)} USD`;

      const notificationCell = document.createElement('td');
      const notification = order.notification || {};
      notificationCell.textContent = `${toNotificationLabel(notification.status)} (reintentos: ${Number(notification.retryCount || 0)})`;

      const updatedCell = document.createElement('td');
      updatedCell.textContent = utils.formatDate(order.updatedAt);

      const statusCell = document.createElement('td');
      const statusSelect = document.createElement('select');
      statusSelect.className = 'text-input users-input';
      ORDER_STATUS_VALUES.forEach((status) => {
        const option = document.createElement('option');
        option.value = status;
        option.textContent = toStatusLabel(status);
        statusSelect.appendChild(option);
      });

      if (!ORDER_STATUS_VALUES.includes(order.status)) {
        const current = document.createElement('option');
        current.value = order.status;
        current.textContent = `${toStatusLabel(order.status)} (actual)`;
        current.selected = true;
        statusSelect.appendChild(current);
      } else {
        statusSelect.value = order.status;
      }

      statusCell.appendChild(statusSelect);

      const actionsCell = document.createElement('td');
      actionsCell.className = 'users-actions';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn-secondary';
      saveBtn.textContent = 'Guardar';
      saveBtn.addEventListener('click', async () => {
        try {
          const updated = await updateOrderStatus(order.orderId, statusSelect.value);
          const index = allOrders.findIndex((entry) => entry.orderId === order.orderId);
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
        const accepted = window.confirm(`Eliminar pedido #${order.orderId}?`);
        if (!accepted) {
          return;
        }

        try {
          await removeOrder(order.orderId);
          allOrders = allOrders.filter((entry) => entry.orderId !== order.orderId);
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
      row.appendChild(servicesCell);
      row.appendChild(totalCell);
      row.appendChild(notificationCell);
      row.appendChild(updatedCell);
      row.appendChild(statusCell);
      row.appendChild(actionsCell);

      ordersTableBody.appendChild(row);
    });
  }

  async function loadOrders() {
    try {
      const q = ordersSearchInput ? ordersSearchInput.value.trim() : '';
      const status = ordersStatusFilter ? String(ordersStatusFilter.value || '').trim().toUpperCase() : '';
      const params = new URLSearchParams();
      if (q) {
        params.set('q', q);
      }
      if (status) {
        params.set('status', status);
      }

      const query = params.toString();
      const url = query ? `${apiBaseUrl}/orders/admin?${query}` : `${apiBaseUrl}/orders/admin`;
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
