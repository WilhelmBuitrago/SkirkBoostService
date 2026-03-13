(function () {
  const apiBaseUrl = document.body.dataset.apiBaseUrl;
  const form = document.getElementById('register-step1-form');
  const message = document.getElementById('register-step1-message');

  function showMessage(text, isError) {
    if (!message) {
      return;
    }
    message.textContent = text;
    message.style.color = isError ? '#ff8b8b' : '#89f2f8';
  }

  if (!form || !apiBaseUrl || !/^https?:\/\//.test(apiBaseUrl)) {
    showMessage('Configuracion API invalida.', true);
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);

    const email = String(formData.get('email') || '').trim();
    const password = String(formData.get('password') || '');

    if (!email || !password) {
      showMessage('Correo y contrasena son requeridos.', true);
      return;
    }

    try {
      const response = await fetch(`${apiBaseUrl}/auth/register/start`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'No se pudo iniciar el registro.');
      }

      window.location.href = '/registro-contacto';
    } catch (error) {
      showMessage(error.message, true);
    }
  });
})();
