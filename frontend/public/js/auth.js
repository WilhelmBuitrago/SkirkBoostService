(function () {
  const apiBaseUrl = document.body.dataset.apiBaseUrl;
  const bootstrapForm = document.getElementById('bootstrap-form');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const bootstrapCard = document.getElementById('bootstrap-card');
  const message = document.getElementById('auth-message');

  function showMessage(text, isError) {
    message.textContent = text;
    message.style.color = isError ? '#ff8b8b' : '#89f2f8';
  }

  function hasValidApiBaseUrl() {
    return Boolean(apiBaseUrl && /^https?:\/\//.test(apiBaseUrl));
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Error de autenticacion');
    }

    return data;
  }

  async function loadBootstrapStatus() {
    const response = await fetch(`${apiBaseUrl}/auth/bootstrap-status`, {
      credentials: 'include'
    });
    const data = await response.json();

    if (!data.needsBootstrap && bootstrapCard) {
      bootstrapCard.classList.add('hidden');
    }
  }

  if (!hasValidApiBaseUrl()) {
    showMessage('Configuracion API invalida. Contacta al administrador.', true);
    return;
  }

  bootstrapForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(bootstrapForm);

    try {
      await postJson(`${apiBaseUrl}/auth/bootstrap-admin`, {
        usuario: formData.get('usuario'),
        password: formData.get('password')
      });
      showMessage('Administrador creado e inicio de sesion correcto.', false);
      window.location.href = '/config';
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(loginForm);

    try {
      const data = await postJson(`${apiBaseUrl}/auth/login`, {
        usuario: formData.get('usuario'),
        password: formData.get('password')
      });

      showMessage('Sesion iniciada.', false);
      if (data.user.role === 'administrador') {
        window.location.href = '/config';
      } else {
        window.location.href = '/';
      }
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(registerForm);

    try {
      await postJson(`${apiBaseUrl}/auth/register`, {
        usuario: formData.get('usuario'),
        password: formData.get('password')
      });
      showMessage('Cuenta cliente creada e inicio de sesion correcto.', false);
      window.location.href = '/';
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  loadBootstrapStatus();
})();
