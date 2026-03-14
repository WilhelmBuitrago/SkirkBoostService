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
    const sessionMenu = document.getElementById('session-menu');
    const sessionMenuToggle = document.getElementById('session-menu-toggle');
    const sessionMenuLabel = document.getElementById('session-menu-label');
    const sessionMenuDropdown = document.getElementById('session-menu-dropdown');

    function closeMenu() {
      if (!sessionMenuDropdown || !sessionMenuToggle) {
        return;
      }

      sessionMenuDropdown.classList.remove('is-open');
      sessionMenuToggle.setAttribute('aria-expanded', 'false');
    }

    function openMenu() {
      if (!sessionMenuDropdown || !sessionMenuToggle) {
        return;
      }

      sessionMenuDropdown.classList.add('is-open');
      sessionMenuToggle.setAttribute('aria-expanded', 'true');
    }

    function setMenuEntries(entries) {
      if (!sessionMenuDropdown) {
        return;
      }

      sessionMenuDropdown.innerHTML = '';

      entries.forEach((entry) => {
        if (entry.type === 'button') {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'session-menu__item';
          button.textContent = entry.label;
          button.addEventListener('click', entry.onClick);
          sessionMenuDropdown.appendChild(button);
          return;
        }

        const link = document.createElement('a');
        link.href = entry.href;
        link.className = 'session-menu__item';
        link.textContent = entry.label;
        sessionMenuDropdown.appendChild(link);
      });
    }

    if (sessionMenuToggle && sessionMenuDropdown && sessionMenu) {
      sessionMenuToggle.addEventListener('click', () => {
        if (sessionMenuDropdown.classList.contains('is-open')) {
          closeMenu();
          return;
        }

        openMenu();
      });

      document.addEventListener('click', (event) => {
        if (!sessionMenu.contains(event.target)) {
          closeMenu();
        }
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          closeMenu();
        }
      });
    }

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

      if (loginLink) {
        loginLink.classList.add('hidden');
      }
      if (registerLink) {
        registerLink.classList.add('hidden');
      }

      if (sessionMenu && sessionMenuLabel) {
        sessionMenuLabel.textContent = `${data.user.usuario} (${data.user.role})`;
        sessionMenu.classList.remove('hidden');
      }

      const menuEntries = [{ type: 'link', label: 'Perfil', href: '/perfil' }];
      if (data.user.role === 'administrador') {
        menuEntries.push({ type: 'link', label: 'Config', href: '/config' });
      }

      menuEntries.push({
        type: 'button',
        label: 'Logout',
        onClick: async () => {
          await fetch(`${apiBaseUrl}/auth/logout`, {
            method: 'POST',
            credentials: 'include'
          });
          window.location.href = '/';
        }
      });

      setMenuEntries(menuEntries);
    } catch (_error) {
      if (sessionMenu) {
        sessionMenu.classList.add('hidden');
      }
      if (registerLink) {
        registerLink.classList.remove('hidden');
      }
      if (loginLink) {
        loginLink.classList.remove('hidden');
      }
    }
  }

  setCartCount();
  document.addEventListener('skirk-cart-updated', setCartCount);
  loadSession();
})();
