require("dotenv").config();

const express = require("express");
const path = require("node:path");

const { createStorage } = require("./storage");
const { createPixPayment, getPaymentById } = require("./payment");
const { createTelegramBot } = require("./telegram");
const { createWebhookRouter } = require("./webhook");

function getEnv(name, { required } = { required: true }) {
  const raw = process.env[name];
  const v = typeof raw === "string" ? raw.trim() : raw;
  if (required && (!v || String(v).trim() === "")) {
    throw new Error(`Variável de ambiente ausente: ${name}`);
  }
  return v || null;
}

function isTruthyEnv(v) {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

function looksLikeTelegramToken(token) {
  if (!token) return false;
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(String(token).trim());
}

function normalizeWebhookUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(String(rawUrl).trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseVipPrice(raw) {
  if (!raw) return 29.9;
  const s = String(raw).trim().replace(",", ".");
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 29.9;
  return n;
}

async function main() {
  const WEBHOOK_ONLY = isTruthyEnv(getEnv("WEBHOOK_ONLY", { required: false })) || isTruthyEnv(getEnv("ONLY_WEBHOOK", { required: false }));

  const PORT = Number(getEnv("PORT", { required: false }) || 3000);
  const MERCADO_PAGO_ACCESS_TOKEN = getEnv("MERCADO_PAGO_ACCESS_TOKEN");
  const WEBHOOK_URL = normalizeWebhookUrl(getEnv("WEBHOOK_URL", { required: false }));
  const STORAGE_FILE = getEnv("STORAGE_FILE", { required: false });
  const STORAGE_DIR = getEnv("STORAGE_DIR", { required: false });
  const VIP_PRICE = parseVipPrice(getEnv("VIP_PRICE", { required: false }));

  const TELEGRAM_TOKEN = getEnv("TELEGRAM_TOKEN", { required: !WEBHOOK_ONLY });
  const GROUP_CHAT_ID = getEnv("GROUP_CHAT_ID", { required: !WEBHOOK_ONLY });
  const storageFilePath = STORAGE_FILE || (STORAGE_DIR ? path.join(STORAGE_DIR, "data.json") : undefined);

  if (TELEGRAM_TOKEN && !looksLikeTelegramToken(TELEGRAM_TOKEN)) {
    throw new Error("TELEGRAM_TOKEN inválido. Verifique se você colou apenas o token do bot, sem SUPPORT_USERNAME ou outros textos.");
  }

  const storage = createStorage(storageFilePath ? { filePath: storageFilePath } : undefined);
  await storage.ensureLoaded();

  const ADMIN_TELEGRAM_ID = getEnv("ADMIN_TELEGRAM_ID", { required: false });

  async function onApprovedUser({ telegramUserId }) {
    try {
      const user = await storage.getUser(telegramUserId);
      if (!user?.paid) return;
      const inviteLink = await bot.createVipInviteLink();
      await bot.sendVipInvite({ telegramUserId, inviteLink });
      await storage.markInviteSent(telegramUserId, inviteLink);
    } catch (err) {
      const msg = err?.message || String(err);
      console.error("[invite] error:", msg);
      if (ADMIN_TELEGRAM_ID && bot?.sendMessage) {
        await bot.sendMessage(ADMIN_TELEGRAM_ID, `[invite] falha ao gerar/enviar convite para ${telegramUserId}: ${msg}`);
      }
      throw err;
    }
  }

  async function createOrReusePayment({ telegramUserId, telegramUsername }) {
    const forceNew = false;
    return createOrReusePaymentInternal({ telegramUserId, telegramUsername, forceNew });
  }

  async function createOrReusePaymentInternal({ telegramUserId, telegramUsername, forceNew }) {
    const existing = await storage.getPendingPayment(telegramUserId);
    if (existing && !forceNew) {
      const createdAtMs = Date.parse(existing.createdAt || "") || 0;
      const ageMs = Date.now() - createdAtMs;
      const isFresh = ageMs >= 0 && ageMs <= 30 * 60 * 1000;
      if (isFresh && existing.status && existing.status !== "approved") return existing;
    }

    const payment = await createPixPayment({
      accessToken: MERCADO_PAGO_ACCESS_TOKEN,
      amount: VIP_PRICE,
      description: "Acesso ao Grupo VIP Telegram",
      telegramUserId,
      telegramUsername,
      webhookUrl: WEBHOOK_URL
    });

    await storage.setPendingPayment(telegramUserId, {
      paymentId: payment.paymentId,
      status: payment.status,
      createdAt: payment.createdAt,
      qrCode: payment.qrCode,
      qrCodeBase64: payment.qrCodeBase64,
      ticketUrl: payment.ticketUrl
    });

    return payment;
  }

  async function createPaymentForceNew({ telegramUserId, telegramUsername }) {
    return createOrReusePaymentInternal({ telegramUserId, telegramUsername, forceNew: true });
  }

  async function checkPaymentStatus({ telegramUserId }) {
    const user = await storage.getUser(telegramUserId);
    const paymentId = user?.pendingPaymentId ? String(user.pendingPaymentId) : null;
    if (!paymentId) return null;
    const mpPayment = await getPaymentById({
      accessToken: MERCADO_PAGO_ACCESS_TOKEN,
      paymentId
    });
    return { paymentId, status: mpPayment?.status || null, mpPayment };
  }

  let bot = {
    pollLoop: async () => {},
    createVipInviteLink: async () => null,
    sendVipInvite: async () => {},
    removeUserFromGroup: async () => {}
  };

  if (TELEGRAM_TOKEN && GROUP_CHAT_ID) {
    if (!String(GROUP_CHAT_ID).startsWith("-")) {
      console.log(
        `[server] Aviso: GROUP_CHAT_ID parece incorreto (${GROUP_CHAT_ID}). Para supergrupos, normalmente é algo como -100xxxxxxxxxx.`
      );
    }

    bot = createTelegramBot({
      token: TELEGRAM_TOKEN,
      groupChatId: GROUP_CHAT_ID,
      vipPrice: VIP_PRICE,
      storage,
      createOrReusePayment,
      createPaymentForceNew,
      checkPaymentStatus,
      onApprovedUser
    });
  } else if (!WEBHOOK_ONLY) {
    throw new Error("TELEGRAM_TOKEN e GROUP_CHAT_ID são obrigatórios quando WEBHOOK_ONLY não está habilitado.");
  }

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (req, res) => res.json({ ok: true }));
  app.use(
    createWebhookRouter({
      mercadoPagoAccessToken: MERCADO_PAGO_ACCESS_TOKEN,
      storage,
      bot
    })
  );

  app.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}`);
    if (storageFilePath) {
      console.log(`[storage] ${storageFilePath}`);
    }
    if (!WEBHOOK_URL) {
      console.log(
        "[server] WEBHOOK_URL ausente ou inválido. O Pix vai ser gerado, mas a aprovação não será automática sem um webhook público."
      );
    }
    if (WEBHOOK_ONLY) {
      console.log("[server] WEBHOOK_ONLY ativo: bot não inicia polling (/start não vai funcionar), apenas webhook/health.");
    }
  });

  if (!WEBHOOK_ONLY) {
    bot.pollLoop();

    setInterval(async () => {
      try {
        const users = await storage.listUsersNeedingInvite(50);
        for (const user of users) {
          const telegramUserId = Number(user?.telegramUserId);
          if (!Number.isFinite(telegramUserId)) continue;
          await onApprovedUser({ telegramUserId });
        }
      } catch (err) {
        const msg = err?.message || String(err);
        console.error("[invite] retry error:", msg);
      }
    }, 60_000);
  }
}

main().catch((err) => {
  console.error("[fatal]", err?.message || err);
  process.exit(1);
});
