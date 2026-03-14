(function () {
  function getCartCount() {
    const raw = sessionStorage.getItem('skirk-cart');
    if (!raw) {
      return 0;
    }

    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch (_error) {
      return 0;
    }
  }

  function setCartCount() {
    const badge = document.getElementById('cart-count');
    if (badge) {
      badge.textContent = String(getCartCount());
    }
  }

  async function loadSession() {
    const topbar = document.querySelector('.topbar');
    const apiBaseUrl = topbar ? topbar.dataset.apiBaseUrl : document.body.dataset.apiBaseUrl;
    if (!apiBaseUrl || !/^https?:\/\//.test(apiBaseUrl)) {
      return;
    }

    const loginLink = document.getElementById('login-link');
    const registerLink = document.getElementById('register-link');
    const logoutBtn = document.getElementById('logout-btn');
    const configLink = document.getElementById('config-link');
    const profileLink = document.getElementById('profile-link');
    const sessionUser = document.getElementById('session-user');

    try {
      const response = await fetch(`${apiBaseUrl}/auth/me`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('No session');
      }

      const data = await response.json();
      if (!data.authenticated) {
        throw new Error('No session');
      }

      if (sessionUser) {
        sessionUser.textContent = `${data.user.usuario} (${data.user.role})`;
      }
      if (loginLink) {
        loginLink.classList.add('hidden');
      }
      if (registerLink) {
        registerLink.classList.add('hidden');
      }
      if (logoutBtn) {
        logoutBtn.classList.remove('hidden');
      }
      if (profileLink) {
        profileLink.classList.remove('hidden');
      }
      if (configLink && data.user.role === 'administrador') {
        configLink.classList.remove('hidden');
      }

      if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
          await fetch(`${apiBaseUrl}/auth/logout`, {
            method: 'POST',
            credentials: 'include'
          });
          window.location.href = '/';
        });
      }
    } catch (_error) {
      if (sessionUser) {
        sessionUser.textContent = 'Invitado';
      }
      if (registerLink) {
        registerLink.classList.remove('hidden');
      }
    }
  }

  setCartCount();
  document.addEventListener('skirk-cart-updated', setCartCount);
  loadSession();
})();
