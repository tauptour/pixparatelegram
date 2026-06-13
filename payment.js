const crypto = require("node:crypto");

function assertFetchAvailable() {
  if (typeof fetch !== "function") {
    throw new Error(
      "Node.js sem fetch global. Use Node >= 18 ou adicione um polyfill de fetch."
    );
  }
}

function normalizeMisticStatus(transactionState) {
  const s = String(transactionState || "").trim().toUpperCase();
  if (!s) return null;
  if (s === "COMPLETO") return "approved";
  if (s === "PENDENTE") return "pending";
  if (s === "FALHA") return "rejected";
  if (s === "CANCELADO" || s === "CANCELADA") return "cancelled";
  return s.toLowerCase();
}

function extractBase64FromDataUrl(maybeDataUrl) {
  if (!maybeDataUrl) return null;
  const s = String(maybeDataUrl);
  const idx = s.indexOf("base64,");
  if (idx === -1) return s.trim() || null;
  return s.slice(idx + "base64,".length).trim() || null;
}

async function misticRequest(clientId, clientSecret, { method, path, body, idempotencyKey }) {
  assertFetchAvailable();

  const url = `https://api.misticpay.com${path}`;
  const headers = {
    ci: String(clientId),
    cs: String(clientSecret),
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
    const message = json?.message || json?.error || `MisticPay HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.details = json;
    throw err;
  }

  return json;
}

async function createPixPayment({
  clientId,
  clientSecret,
  amount,
  description,
  telegramUserId,
  telegramUsername,
  payerName,
  payerDocument,
  webhookUrl
}) {
  const idempotencyKey = crypto.randomUUID();

  const externalReference = `tg_${telegramUserId}_${Date.now()}`;

  const body = {
    amount,
    payerName: String(payerName || telegramUsername || telegramUserId || "Cliente").trim(),
    payerDocument: String(payerDocument || "").replaceAll(/\D/g, ""),
    transactionId: externalReference,
    description
  };

  if (webhookUrl) body.projectWebhook = webhookUrl;

  const result = await misticRequest(clientId, clientSecret, {
    method: "POST",
    path: "/api/transactions/create",
    body,
    idempotencyKey
  });

  const data = result?.data || {};
  const paymentId = data?.transactionId ?? null;
  const status = normalizeMisticStatus(data?.transactionState);

  return {
    paymentId: paymentId ? String(paymentId) : null,
    amount,
    status,
    createdAt: new Date().toISOString(),
    qrCode: data?.copyPaste || null,
    qrCodeBase64: extractBase64FromDataUrl(data?.qrCodeBase64) || null,
    ticketUrl: data?.qrcodeUrl || null,
    raw: result
  };
}

async function getPaymentById({ clientId, clientSecret, paymentId }) {
  const result = await misticRequest(clientId, clientSecret, {
    method: "POST",
    path: "/api/transactions/check",
    body: { transactionId: paymentId }
  });
  const tx = result?.transaction || null;
  return {
    paymentId: paymentId ? String(paymentId) : null,
    status: normalizeMisticStatus(tx?.transactionState),
    transactionState: tx?.transactionState || null,
    value: tx?.value ?? null,
    raw: result
  };
}

module.exports = { createPixPayment, getPaymentById, normalizeMisticStatus };
