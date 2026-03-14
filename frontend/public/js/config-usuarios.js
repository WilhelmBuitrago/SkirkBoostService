(function () {
  const utils = window.SkirkConfigUtils;
  const apiBaseUrl = utils.getApiBaseUrl();
  const usersSearchInput = document.getElementById('users-search');
  const usersTableBody = document.getElementById('users-table-body');
  const message = document.getElementById('config-message');

  let allUsers = [];

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
        createdCell.textContent = utils.formatDate(entry.createdAt);

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
            utils.showMessage(message, 'Usuario actualizado.', false);
            renderUsersTable(usersSearchInput ? usersSearchInput.value : '');
          } catch (error) {
            utils.showMessage(message, error.message, true);
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
            utils.showMessage(message, 'Usuario eliminado.', false);
            renderUsersTable(usersSearchInput ? usersSearchInput.value : '');
          } catch (error) {
            utils.showMessage(message, error.message, true);
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

  async function loadConfig() {
    try {
      const currentConfig = await utils.fetchAdminConfig(apiBaseUrl);
      allUsers = Array.isArray(currentConfig.users) ? currentConfig.users : [];
      renderUsersTable('');
    } catch (error) {
      utils.showMessage(message, error.message, true);
      utils.redirectToLogin();
    }
  }

  if (!utils.hasValidApiBaseUrl(apiBaseUrl)) {
    utils.showMessage(message, 'Configuracion API invalida. Contacta al administrador.', true);
    return;
  }

  if (usersSearchInput) {
    usersSearchInput.addEventListener('input', () => {
      renderUsersTable(usersSearchInput.value);
    });
  }

  loadConfig();
})();
