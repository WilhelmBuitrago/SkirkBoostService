const DISBOT_BASE_URL = String(process.env.DISBOT_BASE_URL || '').trim();
const DISBOT_SHARED_SECRET = String(process.env.DISBOT_SHARED_SECRET || '').trim();
const DISBOT_TIMEOUT_MS = Math.max(1000, Number(process.env.DISBOT_TIMEOUT_MS) || 6000);

function buildDisbotHeaders() {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (DISBOT_SHARED_SECRET) {
    headers['x-api-shared-secret'] = DISBOT_SHARED_SECRET;
  }

  return headers;
}

async function notifyOrderForDm(orderPayload) {
  if (!DISBOT_BASE_URL) {
    throw new Error('DISBOT_BASE_URL is not configured.');
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), DISBOT_TIMEOUT_MS);

  try {
    const response = await fetch(`${DISBOT_BASE_URL}/orders/notify`, {
      method: 'POST',
      headers: buildDisbotHeaders(),
      body: JSON.stringify(orderPayload),
      signal: abortController.signal
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const upstreamMessage = data.error ? ` ${data.error}` : '';
      throw new Error(`DisBot rejected notification (${response.status}).${upstreamMessage}`);
    }

    if (!data.accepted || !data.enqueued) {
      throw new Error('DisBot did not confirm task enqueue.');
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  notifyOrderForDm
};