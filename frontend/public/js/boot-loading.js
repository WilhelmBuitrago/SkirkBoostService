(function () {
  const progressFill = document.getElementById('boot-progress-fill');
  const progressValue = document.getElementById('boot-progress-value');
  const attemptValue = document.getElementById('boot-attempt-value');
  const didacticMessage = document.getElementById('boot-didactic-message');
  const mainMessage = document.getElementById('boot-main-message');
  const finalMessage = document.getElementById('boot-final-message');
  const progressBar = document.querySelector('[role="progressbar"]');
  const messagesNode = document.getElementById('boot-messages');

  if (!progressFill || !progressValue || !attemptValue || !didacticMessage || !mainMessage || !finalMessage || !progressBar) {
    return;
  }

  const parsedMessages = (() => {
    try {
      return JSON.parse(messagesNode ? messagesNode.textContent : '[]');
    } catch (_error) {
      return [];
    }
  })();

  const messages = parsedMessages.length > 0
    ? parsedMessages
    : [
      'Generando servicios para ti',
      'Preparandonos para ti',
      'Ya casi estamos',
      'No te vayas'
    ];

  const bodyData = document.body.dataset;
  const targetPath = bodyData.targetPath || '/';
  const wakeupUrl = (bodyData.bootWakeupUrl || 'https://skirkboostservice-api.onrender.com/').trim();
  const disbotWakeupUrl = (bodyData.bootWakeupDisbotUrl || wakeupUrl).trim();
  const minDuration = Number(bodyData.bootMinDuration) || 10000;
  const maxDuration = Number(bodyData.bootMaxDuration) || 30000;
  const maxAttempts = Math.max(1, Number(bodyData.bootMaxAttempts) || 2);
  const frameMs = 120;
  const wakeupTimeoutMs = 2800;
  const progressCheckpoints = [25, 50, 75, 100];

  let cycleId = 0;
  let phraseTimer = null;

  function randomInRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function updateProgress(value) {
    const safeValue = Math.max(0, Math.min(100, Math.floor(value)));
    progressFill.style.width = `${safeValue}%`;
    progressValue.textContent = `${safeValue}%`;
    progressBar.setAttribute('aria-valuenow', String(safeValue));
  }

  function clearPhraseTimer() {
    if (phraseTimer) {
      window.clearTimeout(phraseTimer);
      phraseTimer = null;
    }
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function pickRandomMessage(previous) {
    if (messages.length === 1) {
      return messages[0];
    }

    let selected = previous;
    while (selected === previous) {
      selected = messages[Math.floor(Math.random() * messages.length)];
    }

    return selected;
  }

  function rotateDidacticMessages(localCycleId) {
    let current = didacticMessage.textContent.trim() || messages[0];

    const tick = function () {
      if (localCycleId !== cycleId) {
        return;
      }

      const next = pickRandomMessage(current);
      didacticMessage.classList.remove('is-visible');

      window.setTimeout(() => {
        if (localCycleId !== cycleId) {
          return;
        }

        didacticMessage.textContent = next;
        didacticMessage.classList.add('is-visible');
        current = next;
      }, 260);

      const nextTick = randomInRange(1800, 3200);
      phraseTimer = window.setTimeout(tick, nextTick);
    };

    phraseTimer = window.setTimeout(tick, randomInRange(1400, 2600));
  }

  async function checkAvailability() {
    try {
      const response = await fetch('/boot/availability', {
        headers: { 'Content-Type': 'application/json' }
      });
      return response.ok;
    } catch (_error) {
      return false;
    }
  }

  async function pingService(url) {
    const abortController = new AbortController();
    const timeout = window.setTimeout(() => abortController.abort(), wakeupTimeoutMs);

    try {
      await fetch(url, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store',
        signal: abortController.signal
      });
      return true;
    } catch (_error) {
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function pingWakeupService() {
    return pingService(wakeupUrl);
  }

  function pingDisbotWakeupService() {
    return pingService(disbotWakeupUrl);
  }

  async function checkCatalogUntilReady(localCycleId, maxChecks) {
    for (let index = 0; index < maxChecks; index += 1) {
      if (localCycleId !== cycleId) {
        return false;
      }

      const isReady = await checkAvailability();
      if (isReady) {
        return true;
      }

      if (index < maxChecks - 1) {
        await delay(650);
      }
    }

    return false;
  }

  async function completeAndTryRedirect(localCycleId) {
    if (localCycleId !== cycleId) {
      return false;
    }

    updateProgress(100);
    mainMessage.textContent = 'API y DisBot despiertos. Cargando catalogo...';
    const ready = await checkCatalogUntilReady(localCycleId, 4);

    if (ready && localCycleId === cycleId) {
      clearPhraseTimer();
      window.location.assign(targetPath);
      return true;
    }

    return false;
  }

  function showFinalMessage() {
    mainMessage.textContent = 'No logramos conectar esta vez.';
    didacticMessage.hidden = true;
    finalMessage.hidden = false;
  }

  async function runAttempt(attempt) {
    cycleId += 1;
    const localCycleId = cycleId;

    clearPhraseTimer();

    updateProgress(0);
    mainMessage.textContent = 'Montando servicios y verificando disponibilidad.';
    attemptValue.textContent = `Intento ${attempt} de ${maxAttempts}`;
    didacticMessage.hidden = false;
    finalMessage.hidden = true;

    rotateDidacticMessages(localCycleId);

    const [initialWakeupReady, initialDisbotReady] = await Promise.all([
      pingWakeupService(),
      pingDisbotWakeupService()
    ]);
    if (initialWakeupReady && initialDisbotReady) {
      const redirected = await completeAndTryRedirect(localCycleId);
      if (redirected || localCycleId !== cycleId) {
        return;
      }
    }

    const duration = randomInRange(minDuration, maxDuration);
    const totalSteps = Math.max(24, Math.floor(duration / frameMs));
    const weights = Array.from({ length: totalSteps }, () => Math.random() + 0.06);
    const totalWeight = weights.reduce((acc, value) => acc + value, 0);

    let progress = 0;
    let checkpointIndex = 0;
    for (let index = 0; index < totalSteps; index += 1) {
      if (localCycleId !== cycleId) {
        return;
      }

      const isFinalStep = index === totalSteps - 1;
      const increment = isFinalStep ? (100 - progress) : (weights[index] / totalWeight) * 100;
      progress = Math.min(100, progress + increment);
      updateProgress(progress);

      while (checkpointIndex < progressCheckpoints.length && progress >= progressCheckpoints[checkpointIndex]) {
        const [wakeupReady, disbotReady] = await Promise.all([
          pingWakeupService(),
          pingDisbotWakeupService()
        ]);
        if (wakeupReady && disbotReady) {
          const redirected = await completeAndTryRedirect(localCycleId);
          if (redirected || localCycleId !== cycleId) {
            return;
          }
        }
        checkpointIndex += 1;
      }

      await delay(frameMs);
    }

    clearPhraseTimer();

    const isReady = await checkAvailability();
    if (isReady) {
      window.location.assign(targetPath);
      return;
    }

    if (attempt < maxAttempts) {
      mainMessage.textContent = 'Aun no esta listo. Reintentando automaticamente...';
      await delay(850);
      runAttempt(attempt + 1);
      return;
    }

    showFinalMessage();
  }

  runAttempt(1);
})();
