(function () {
  const apiBaseUrl = document.body.dataset.apiBaseUrl;
  const statusIndicator = document.getElementById('status-indicator');
  const statusButtons = document.querySelectorAll('.js-status');
  const checklistContainer = document.getElementById('service-checklist');
  const priceEditor = document.getElementById('price-editor');
  const searchInput = document.getElementById('service-search');
  const priceSearchInput = document.getElementById('price-search');
  const usersSearchInput = document.getElementById('users-search');
  const usersTableBody = document.getElementById('users-table-body');
  const ordersSearchInput = document.getElementById('orders-search');
  const ordersStatusFilter = document.getElementById('orders-status-filter');
  const ordersTableBody = document.getElementById('orders-table-body');
  const message = document.getElementById('config-message');
  const orderStatusValues = ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
  const legacyToV1Status = {
    Cotizacion: 'PENDING',
    'En espera': 'NOTIFIED',
    Realizando: 'IN_PROGRESS',
    Finalizado: 'COMPLETED'
  };
  const v1ToLegacyStatus = {
    PENDING: 'Cotizacion',
    NOTIFIED: 'En espera',
    IN_PROGRESS: 'Realizando',
    COMPLETED: 'Finalizado',
    FAILED_NOTIFY: 'Cotizacion',
    CANCELLED: 'Cancelado'
  };

  let currentConfig = null;
  let allServices = [];
  let allUsers = [];
  let allOrders = [];
  let ordersSearchTimeout = null;

  function formatCop(value) {
    return new Intl.NumberFormat('es-CO').format(value);
  }

  function showMessage(text, isError) {
    message.textContent = text;
    message.style.color = isError ? '#ff8b8b' : '#89f2f8';
  }

  function hasValidApiBaseUrl() {
    return Boolean(apiBaseUrl && /^https?:\/\//.test(apiBaseUrl));
  }

  function setIndicator(status) {
    statusIndicator.classList.remove('status-green', 'status-yellow', 'status-red');
    if (status === 'ACTIVA') {
      statusIndicator.classList.add('status-green');
    } else if (status === 'PARCIAL') {
      statusIndicator.classList.add('status-yellow');
    } else {
      statusIndicator.classList.add('status-red');
    }
    statusIndicator.textContent = status;
  }

  function flattenServices(catalog) {
    const rows = [];

    catalog.zones.forEach((zone) => {
      rows.push({ serviceId: zone.serviceId, label: `Zona: ${zone.name}`, priceCop: zone.basePriceCop });
      zone.missionOptions.forEach((mission) => {
        rows.push({
          serviceId: mission.serviceId,
          label: `Mision ${zone.name}: ${mission.name}`,
          priceCop: mission.priceCop
        });
      });
    });

    catalog.services.wishFarming.lessThan50.forEach((item) => {
      rows.push({ serviceId: item.serviceId, label: `Deseos <50%: ${item.label}`, priceCop: item.priceCop });
    });
    catalog.services.wishFarming.moreThan50.forEach((item) => {
      rows.push({ serviceId: item.serviceId, label: `Deseos >50%: ${item.label}`, priceCop: item.priceCop });
    });
    catalog.services.missions.items.forEach((item) => {
      rows.push({ serviceId: item.serviceId, label: `Misiones: ${item.label}`, priceCop: item.priceCop || 0 });
    });
    catalog.services.farming.items.forEach((item) => {
      rows.push({ serviceId: item.serviceId, label: `Farmeo: ${item.label}`, priceCop: item.priceCop || 0 });
    });
    catalog.services.maintenance.items.forEach((item) => {
      rows.push({ serviceId: item.serviceId, label: `Mantenimiento: ${item.label}`, priceCop: item.priceCop || 0 });
    });

    return rows;
  }

  function renderChecklist(filterText) {
    const normalizedFilter = (filterText || '').trim().toLowerCase();
    const disabled = new Set(currentConfig.runtimeConfig.disabledServiceIds || []);

    checklistContainer.innerHTML = '';

    allServices
      .filter((service) => service.label.toLowerCase().includes(normalizedFilter))
      .forEach((service) => {
        const wrapper = document.createElement('label');
        wrapper.className = 'mini-card check-line';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = disabled.has(service.serviceId);
        input.addEventListener('change', async () => {
          if (input.checked) {
            disabled.add(service.serviceId);
          } else {
            disabled.delete(service.serviceId);
          }

          try {
            const response = await fetch(`${apiBaseUrl}/admin/availability`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ disabledServiceIds: Array.from(disabled) })
            });
            const data = await response.json();
            if (!response.ok) {
              throw new Error(data.error || 'No fue posible actualizar disponibilidad');
            }
            currentConfig.runtimeConfig = data.runtimeConfig;
            showMessage('Disponibilidad actualizada.', false);
          } catch (error) {
            showMessage(error.message, true);
            input.checked = !input.checked;
          }
        });

        const text = document.createElement('span');
        text.textContent = service.label;

        wrapper.appendChild(input);
        wrapper.appendChild(text);
        checklistContainer.appendChild(wrapper);
      });
  }

  function renderPriceEditor(filterText) {
    const normalizedFilter = (filterText || '').trim().toLowerCase();
    priceEditor.innerHTML = '';

    allServices
      .filter((service) => service.label.toLowerCase().includes(normalizedFilter))
      .forEach((service) => {
      const row = document.createElement('div');
      row.className = 'price-row';

      const label = document.createElement('span');
      label.textContent = `${service.label} (COP actual: ${formatCop(service.priceCop || 0)})`;

      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.value = String(service.priceCop || 0);
      input.className = 'text-input';

      const button = document.createElement('button');
      button.className = 'btn-secondary';
      button.textContent = 'Guardar';
      button.addEventListener('click', async () => {
        const nextPrice = Number(input.value || 0);
        try {
          const response = await fetch(`${apiBaseUrl}/admin/price`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ serviceId: service.serviceId, priceCop: nextPrice })
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || 'No fue posible actualizar precio');
          }
          showMessage('Precio actualizado.', false);
          service.priceCop = nextPrice;
          label.textContent = `${service.label} (COP actual: ${formatCop(service.priceCop || 0)})`;
        } catch (error) {
          showMessage(error.message, true);
        }
      });

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(button);
      priceEditor.appendChild(row);
    });
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

  async function updateUser(userId, payload) {
    const response = await fetch(`${apiBaseUrl}/admin/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'No fue posible actualizar el usuario');
    }

    return data.user;
  }

  async function deleteUser(userId) {
    const response = await fetch(`${apiBaseUrl}/admin/users/${userId}`, {
      method: 'DELETE',
      credentials: 'include'
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'No fue posible eliminar el usuario');
    }

    return data;
  }

  function renderUsersTable(filterText) {
    if (!usersTableBody) {
      return;
    }

    const normalizedFilter = (filterText || '').trim().toLowerCase();
    usersTableBody.innerHTML = '';

    allUsers
      .filter((entry) => {
        if (!normalizedFilter) {
          return true;
        }

        return (
          String(entry.usuario || '').toLowerCase().includes(normalizedFilter) ||
          String(entry.email || '').toLowerCase().includes(normalizedFilter) ||
          String(entry.role || '').toLowerCase().includes(normalizedFilter)
        );
      })
      .forEach((entry) => {
        const row = document.createElement('tr');

        const idCell = document.createElement('td');
        idCell.textContent = String(entry.id);

        const userCell = document.createElement('td');
        const userInput = document.createElement('input');
        userInput.className = 'text-input users-input';
        userInput.value = entry.usuario || '';
        userCell.appendChild(userInput);

        const emailCell = document.createElement('td');
        const emailInput = document.createElement('input');
        emailInput.className = 'text-input users-input';
        emailInput.value = entry.email || '';
        emailCell.appendChild(emailInput);

        const roleCell = document.createElement('td');
        const roleSelect = document.createElement('select');
        roleSelect.className = 'text-input users-input';
        const userOption = document.createElement('option');
        userOption.value = 'usuario';
        userOption.textContent = 'usuario';
        const adminOption = document.createElement('option');
        adminOption.value = 'administrador';
        adminOption.textContent = 'administrador';
        roleSelect.appendChild(userOption);
        roleSelect.appendChild(adminOption);
        roleSelect.value = entry.role;
        roleCell.appendChild(roleSelect);

        const createdCell = document.createElement('td');
        createdCell.textContent = formatDate(entry.createdAt);

        const actionsCell = document.createElement('td');
        actionsCell.className = 'users-actions';

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'btn-secondary';
        saveBtn.textContent = 'Guardar';
        saveBtn.addEventListener('click', async () => {
          try {
            const updated = await updateUser(entry.id, {
              usuario: userInput.value,
              email: emailInput.value,
              role: roleSelect.value
            });

            const index = allUsers.findIndex((item) => item.id === entry.id);
            if (index >= 0) {
              allUsers[index] = updated;
            }
            showMessage('Usuario actualizado.', false);
            renderUsersTable(usersSearchInput ? usersSearchInput.value : '');
          } catch (error) {
            showMessage(error.message, true);
          }
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-secondary';
        deleteBtn.textContent = 'Eliminar';
        deleteBtn.addEventListener('click', async () => {
          const accepted = window.confirm(`Eliminar usuario ${entry.usuario}?`);
          if (!accepted) {
            return;
          }

          try {
            await deleteUser(entry.id);
            allUsers = allUsers.filter((item) => item.id !== entry.id);
            showMessage('Usuario eliminado.', false);
            renderUsersTable(usersSearchInput ? usersSearchInput.value : '');
          } catch (error) {
            showMessage(error.message, true);
          }
        });

        actionsCell.appendChild(saveBtn);
        actionsCell.appendChild(deleteBtn);

        row.appendChild(idCell);
        row.appendChild(userCell);
        row.appendChild(emailCell);
        row.appendChild(roleCell);
        row.appendChild(createdCell);
        row.appendChild(actionsCell);

        usersTableBody.appendChild(row);
      });
  }

  function formatPlatform(value) {
    const map = {
      whatsapp: 'WhatsApp',
      tiktok: 'TikTok',
      discord: 'Discord',
      instagram: 'Instagram'
    };

    return map[value] || value || '-';
  }

  function formatOrderServices(services) {
    if (!Array.isArray(services) || services.length < 1) {
      return '-';
    }

    return services
      .map((service) => String(service.label || '').trim())
      .filter(Boolean)
      .join(', ');
  }

  function toLegacyOrderShape(order) {
    return {
      id: order.orderId,
      usuario: order.usuario || '-',
      email: order.email || '-',
      contacto: { plataforma: '', contacto: '' },
      metodoPago: '-',
      services: [],
      estado: v1ToLegacyStatus[order.status] || order.status,
      _rawStatus: order.status
    };
  }

  async function updateOrderStatus(orderId, estado) {
    const status = legacyToV1Status[estado] || estado;
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

    return toLegacyOrderShape(data.order || {});
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
      const platform = order.contacto && order.contacto.plataforma ? formatPlatform(order.contacto.plataforma) : '-';
      const contactValue = order.contacto && order.contacto.contacto ? order.contacto.contacto : '-';
      contactCell.textContent = `${platform}: ${contactValue}`;

      const paymentCell = document.createElement('td');
      paymentCell.textContent = order.metodoPago || '-';

      const servicesCell = document.createElement('td');
      servicesCell.textContent = formatOrderServices(order.services);

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
          showMessage('Estado del pedido actualizado.', false);
          renderOrdersTable();
        } catch (error) {
          showMessage(error.message, true);
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
          showMessage('Pedido eliminado.', false);
          renderOrdersTable();
        } catch (error) {
          showMessage(error.message, true);
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
        params.set('status', (legacyToV1Status[estado] || estado).toUpperCase());
      }

      const query = params.toString();
      const url = query ? `${apiBaseUrl}/orders/admin?${query}` : `${apiBaseUrl}/orders/admin`;
      const response = await fetch(url, {
        credentials: 'include'
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'No se pudieron cargar los pedidos');
      }

      allOrders = Array.isArray(data.orders) ? data.orders.map((entry) => toLegacyOrderShape(entry)) : [];
      renderOrdersTable();
    } catch (error) {
      showMessage(error.message, true);
    }
  }

  async function loadConfig() {
    try {
      const response = await fetch(`${apiBaseUrl}/admin/config`, {
        credentials: 'include'
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'No autorizado');
      }

      currentConfig = data;
      setIndicator(data.runtimeConfig.platformStatus);
      allServices = flattenServices(data.catalog);
      allUsers = Array.isArray(data.users) ? data.users : [];
      renderChecklist('');
      renderPriceEditor('');
      renderUsersTable('');
      await loadOrders();
    } catch (error) {
      showMessage(error.message, true);
      setTimeout(() => {
        window.location.href = '/login';
      }, 600);
    }
  }

  if (!hasValidApiBaseUrl()) {
    showMessage('Configuracion API invalida. Contacta al administrador.', true);
    return;
  }

  statusButtons.forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/admin/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ status: button.dataset.value })
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'No fue posible cambiar estado');
        }
        currentConfig.runtimeConfig = data.runtimeConfig;
        setIndicator(data.runtimeConfig.platformStatus);
        showMessage('Estado actualizado.', false);
      } catch (error) {
        showMessage(error.message, true);
      }
    });
  });

  searchInput.addEventListener('input', () => {
    renderChecklist(searchInput.value);
  });

  if (priceSearchInput) {
    priceSearchInput.addEventListener('input', () => {
      renderPriceEditor(priceSearchInput.value);
    });
  }

  if (usersSearchInput) {
    usersSearchInput.addEventListener('input', () => {
      renderUsersTable(usersSearchInput.value);
    });
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

  loadConfig();
})();
