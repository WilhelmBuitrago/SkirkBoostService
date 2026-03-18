const DISBOT_BASE_URL = String(process.env.DISBOT_BASE_URL || '').trim();
const DISBOT_SHARED_SECRET = String(process.env.DISBOT_SHARED_SECRET || '').trim();
const DISBOT_TIMEOUT_MS = Math.max(1000, Number(process.env.DISBOT_TIMEOUT_MS) || 6000);

function buildDisbotHeaders() {
  if (!DISBOT_SHARED_SECRET) {
    throw new Error('DISBOT_SHARED_SECRET is required.');
  }

  const headers = {
    'Content-Type': 'application/json'
  };

  headers['x-api-shared-secret'] = DISBOT_SHARED_SECRET;

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

    const isDirectSuccess = data && data.success === true;
    const isEnqueueSuccess = data && data.accepted === true && data.enqueued === true;
    if (isDirectSuccess || isEnqueueSuccess) {
      return data;
    }

    const reason = (data && data.error) || 'DisBot did not confirm notification.';
    throw new Error(reason);
  } finally {
    clearTimeout(timeout);
  }
}

async function notifyOrderForDmV1(payload) {
  if (!payload || !payload.orderId) {
    throw new Error('notifyOrderForDmV1 requires orderId.');
  }

  const normalizedPayload = {
    ...payload,
    orderId: String(payload.orderId),
    userId: payload.userId == null ? null : Number(payload.userId)
  };

  const response = await notifyOrderForDm(normalizedPayload);

  const acceptedStyleSuccess = Boolean(response && response.accepted && response.enqueued);
  const successStyleSuccess = Boolean(response && response.success === true);

  if (acceptedStyleSuccess || successStyleSuccess) {
    return { success: true };
  }

  return {
    success: false,
    error: (response && response.error) || 'notification_not_confirmed'
  };
}

module.exports = {
  notifyOrderForDm,
  notifyOrderForDmV1
};