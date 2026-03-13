(function () {
  const apiBaseUrl = document.body.dataset.apiBaseUrl;
  const form = document.getElementById('register-step2-form');
  const message = document.getElementById('register-step2-message');

  function showMessage(text, isError) {
    if (!message) {
      return;
    }
    message.textContent = text;
    message.style.color = isError ? '#ff8b8b' : '#89f2f8';
  }

  function buildContacts(formData) {
    const platforms = ['whatsapp', 'tiktok', 'discord', 'instagram'];
    return platforms
      .map((platform) => {
        const value = String(formData.get(platform) || '').trim();
        if (!value) {
          return null;
        }

        return {
          plataforma: platform,
          contacto: value
        };
      })
      .filter(Boolean);
  }

  if (!form || !apiBaseUrl || !/^https?:\/\//.test(apiBaseUrl)) {
    showMessage('Configuracion API invalida.', true);
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);

    const usuario = String(formData.get('usuario') || '').trim();
    const contactos = buildContacts(formData);

    if (!usuario) {
      showMessage('Nombre de usuario es obligatorio.', true);
      return;
    }

    if (contactos.length < 1) {
      showMessage('Debes agregar al menos una plataforma de contacto.', true);
      return;
    }

    try {
      const response = await fetch(`${apiBaseUrl}/auth/register/complete`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usuario, contactos })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'No se pudo completar el registro.');
      }

      showMessage('Cuenta creada. Redirigiendo...', false);
      window.location.href = '/';
    } catch (error) {
      showMessage(error.message, true);
    }
  });
})();
