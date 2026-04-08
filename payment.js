const crypto = require("node:crypto");

function assertFetchAvailable() {
  if (typeof fetch !== "function") {
    throw new Error(
      "Node.js sem fetch global. Use Node >= 18 ou adicione um polyfill de fetch."
    );
  }
}

async function mpRequest(accessToken, { method, path, body, idempotencyKey }) {
  assertFetchAvailable();

  const url = `https://api.mercadopago.com${path}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json"
  };

  if (idempotencyKey) {
    headers["X-Idempotency-Key"] = idempotencyKey;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const message = json?.message || json?.error || `Mercado Pago HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.details = json;
    throw err;
  }

  return json;
}

async function createPixPayment({
  accessToken,
  amount,
  description,
  telegramUserId,
  telegramUsername,
  webhookUrl
}) {
  const idempotencyKey = crypto.randomUUID();

  const payerEmail = `tg-${telegramUserId}@example.com`;
  const externalReference = `tg_${telegramUserId}_${Date.now()}`;

  const body = {
    transaction_amount: amount,
    description,
    payment_method_id: "pix",
    payer: {
      email: payerEmail
    },
    external_reference: externalReference,
    metadata: {
      telegram_user_id: String(telegramUserId),
      telegram_username: telegramUsername ? String(telegramUsername) : null
    }
  };

  if (webhookUrl) {
    body.notification_url = webhookUrl;
  }

  const payment = await mpRequest(accessToken, {
    method: "POST",
    path: "/v1/payments",
    body,
    idempotencyKey
  });

  const tx = payment?.point_of_interaction?.transaction_data || {};
  return {
    paymentId: String(payment.id),
    status: payment.status,
    createdAt: new Date().toISOString(),
    qrCode: tx.qr_code || null,
    qrCodeBase64: tx.qr_code_base64 || null,
    ticketUrl: tx.ticket_url || null,
    raw: payment
  };
}

async function getPaymentById({ accessToken, paymentId }) {
  return mpRequest(accessToken, {
    method: "GET",
    path: `/v1/payments/${encodeURIComponent(paymentId)}`
  });
}

module.exports = { createPixPayment, getPaymentById };

