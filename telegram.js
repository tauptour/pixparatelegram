const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const config = require("./config");

function assertFetchAvailable() {
  if (typeof fetch !== "function") {
    throw new Error(
      "Node.js sem fetch global. Use Node >= 18 ou adicione um polyfill de fetch."
    );
  }
}

function createTelegramClient({ token }) {
  assertFetchAvailable();

  const baseUrl = `https://api.telegram.org/bot${token}`;

  async function api(method, params) {
    const res = await fetch(`${baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params || {})
    });

    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      const err = new Error(json?.description || `Telegram API error (${method})`);
      err.status = res.status;
      err.details = json;
      throw err;
    }
    return json.result;
  }

  function buildMultipart({ fields, fileFieldName, fileName, fileBuffer, mimeType }) {
    const boundary = `--------------------------${crypto.randomUUID().replaceAll("-", "")}`;
    const chunks = [];

    for (const [key, value] of Object.entries(fields || {})) {
      if (value === undefined || value === null) continue;
      const normalizedValue = typeof value === "object" ? JSON.stringify(value) : value;
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${key}"\r\n\r\n`));
      chunks.push(Buffer.from(String(normalizedValue)));
      chunks.push(Buffer.from("\r\n"));
    }

    if (fileBuffer) {
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${fileFieldName}"; filename="${fileName}"\r\n`
        )
      );
      chunks.push(Buffer.from(`Content-Type: ${mimeType}\r\n\r\n`));
      chunks.push(fileBuffer);
      chunks.push(Buffer.from("\r\n"));
    }

    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return {
      body: Buffer.concat(chunks),
      contentType: `multipart/form-data; boundary=${boundary}`
    };
  }

  async function apiMultipart(method, { fields, file }) {
    const { body, contentType } = buildMultipart({
      fields,
      fileFieldName: file.fieldName,
      fileName: file.fileName,
      fileBuffer: file.buffer,
      mimeType: file.mimeType
    });

    const res = await fetch(`${baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body
    });

    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      const err = new Error(json?.description || `Telegram API error (${method})`);
      err.status = res.status;
      err.details = json;
      throw err;
    }
    return json.result;
  }

  async function sendMessage(chatId, text, options = {}) {
    return api("sendMessage", {
      chat_id: chatId,
      text,
      ...options
    });
  }

  async function sendPhotoFromBase64(chatId, base64Png, caption, options = {}) {
    const buffer = Buffer.from(base64Png, "base64");
    return apiMultipart("sendPhoto", {
      fields: {
        chat_id: chatId,
        caption: caption || undefined,
        ...options
      },
      file: {
        fieldName: "photo",
        fileName: "qrcode.png",
        mimeType: "image/png",
        buffer
      }
    });
  }

  async function sendPhotoFromFile(chatId, filePath, caption, options = {}) {
    const buffer = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
    const fileName = path.basename(filePath);

    return apiMultipart("sendPhoto", {
      fields: {
        chat_id: chatId,
        caption: caption || undefined,
        ...options
      },
      file: {
        fieldName: "photo",
        fileName,
        mimeType,
        buffer
      }
    });
  }

  async function sendVideoFromFile(chatId, filePath, caption, options = {}) {
    const buffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);

    return apiMultipart("sendVideo", {
      fields: {
        chat_id: chatId,
        caption: caption || undefined,
        ...options
      },
      file: {
        fieldName: "video",
        fileName,
        mimeType: "video/mp4",
        buffer
      }
    });
  }

  async function answerCallbackQuery(callbackQueryId, options = {}) {
    return api("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...options
    });
  }

  async function getUpdates({ offset, timeoutSeconds }) {
    return api("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message", "callback_query"]
    });
  }

  async function createOneTimeInviteLink({ groupChatId, expireSeconds = 600 }) {
    const now = Math.floor(Date.now() / 1000);
    return api("createChatInviteLink", {
      chat_id: groupChatId,
      member_limit: 1,
      expire_date: now + expireSeconds
    });
  }

  async function removeUserFromGroup({ groupChatId, telegramUserId }) {
    const now = Math.floor(Date.now() / 1000);
    await api("banChatMember", {
      chat_id: groupChatId,
      user_id: telegramUserId,
      until_date: now + 60
    });
    await api("unbanChatMember", {
      chat_id: groupChatId,
      user_id: telegramUserId,
      only_if_banned: true
    });
  }

  return {
    api,
    sendMessage,
    sendPhotoFromBase64,
    sendPhotoFromFile,
    sendVideoFromFile,
    answerCallbackQuery,
    getUpdates,
    createOneTimeInviteLink,
    removeUserFromGroup
  };
}

function createTelegramBot({
  token,
  groupChatId,
  vipPrice,
  adminTelegramId,
  storage,
  createOrReusePayment,
  createPaymentForceNew,
  checkPaymentStatus,
  getAnalyticsReportText,
  onApprovedUser,
  redeemWebCheckoutClaim
}) {
  const tg = createTelegramClient({ token });
  const normalizedGroupChatId = normalizeGroupChatId(groupChatId);
  const vipPreviewPath = config.telegram.media.vipPreviewPath;
  const startPhotoPath = config.telegram.media.startPhotoPath;
  const pixPreviewPath = config.telegram.media.pixPreviewPath;
  const startVideoPath = config.telegram.media.startVideoPath;
  const videoCallPhotoPath = config.telegram.media.videoCallPhotoPath;
  const previewPhotoPaths = config.telegram.media.previewPhotoPaths;
  const vipOffers = Array.isArray(config.telegram.vipOffers) ? config.telegram.vipOffers : [];
  const pixReminderTimers = new Map();

  let lastUpdateId = 0;
  let running = false;

  function normalizeGroupChatId(chatId) {
    const s = String(chatId || "").trim();
    if (!s) return s;
    if (s.startsWith("-")) return s;
    if (/^\d+$/.test(s) && s.startsWith("100")) return `-${s}`;
    return s;
  }

  function isPrivateChat(messageOrChat) {
    const chat = messageOrChat?.chat ? messageOrChat.chat : messageOrChat;
    return chat?.type === "private";
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function normalizeWhatsAppPhone(rawPhone) {
    const digits = String(rawPhone || "").replaceAll(/\D/g, "");
    return digits || null;
  }

  function buildWhatsAppUrl({ phone, text }) {
    const p = normalizeWhatsAppPhone(phone);
    if (!p) return null;
    const t = text ? encodeURIComponent(String(text)) : "";
    return t ? `https://wa.me/${p}?text=${t}` : `https://wa.me/${p}`;
  }

  function formatBrl(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "R$ 0,00";
    const fixed = n.toFixed(2).replace(".", ",");
    return `R$ ${fixed}`;
  }

  function clearPixReminderTimers(telegramUserId) {
    const key = String(telegramUserId || "");
    const timers = pixReminderTimers.get(key);
    if (!timers) return;
    for (const timer of timers) clearTimeout(timer);
    pixReminderTimers.delete(key);
  }


  async function isPaymentStillPending(telegramUserId) {
    const user = await storage.getUser(telegramUserId);
    if (!user) return false;
    if (user.paid) return false;
    if (!user.pendingPaymentId) return false;
    return true;
  }

  function schedulePixReminders({ chatId, telegramUserId }) {
    clearPixReminderTimers(telegramUserId);
    const reminders = Array.isArray(config.telegram.texts.pixReminderMessages)
      ? config.telegram.texts.pixReminderMessages
      : [];
    if (reminders.length === 0) return;

    const delaysMs = [1 * 60 * 1000, 3 * 60 * 1000, 5 * 60 * 1000];
    const timers = reminders.map((message, index) =>
      setTimeout(async () => {
        try {
          const stillPending = await isPaymentStillPending(telegramUserId);
          if (!stillPending) return;
          await tg.sendMessage(chatId, message, { parse_mode: "HTML" });
        } catch (err) {
          console.error("[telegram] erro ao enviar lembrete pix:", err?.message || err);
        }
      }, delaysMs[index] || delaysMs[delaysMs.length - 1])
    );

    pixReminderTimers.set(String(telegramUserId), timers);
  }

  function getOfferByStep(step) {
    return vipOffers.find((offer) => offer?.step === step) || null;
  }

  function getOfferById(offerId) {
    return vipOffers.find((offer) => offer?.id === offerId) || null;
  }

  function getOfferCallbackData(offer) {
    if (!offer?.id) return null;
    return offer.step || `offer:${offer.id}`;
  }

  function getOfferByCallbackData(callbackData) {
    return vipOffers.find((offer) => getOfferCallbackData(offer) === callbackData) || null;
  }

  function buildVipOfferKeyboardRows(offers = vipOffers) {
    return offers
      .map((offer) => {
        const callbackData = getOfferCallbackData(offer);
        if (!callbackData || !offer?.label) return null;
        return [{ text: offer.label, callback_data: callbackData }];
      })
      .filter(Boolean);
  }

  function normalizeCpfDigits(raw) {
    const digits = String(raw || "").replaceAll(/\D/g, "");
    return digits || null;
  }

  function isValidCpf(cpfDigits) {
    const cpf = normalizeCpfDigits(cpfDigits);
    if (!cpf || cpf.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(cpf)) return false;

    const nums = cpf.split("").map((c) => Number(c));
    if (nums.some((n) => !Number.isFinite(n))) return false;

    const calc = (len) => {
      let sum = 0;
      for (let i = 0; i < len; i += 1) sum += nums[i] * (len + 1 - i);
      const mod = sum % 11;
      return mod < 2 ? 0 : 11 - mod;
    };

    const d1 = calc(9);
    const d2 = calc(10);
    return d1 === nums[9] && d2 === nums[10];
  }

  function buildPayerName(from, fallbackUsername) {
    const first = String(from?.first_name || "").trim();
    const last = String(from?.last_name || "").trim();
    const full = [first, last].filter(Boolean).join(" ").trim();
    if (full) return full;
    const u = String(fallbackUsername || "").trim();
    if (u) return u;
    return "Cliente";
  }

  async function trySendPhoto(chatId, filePath, caption, options) {
    try {
      await fs.access(filePath);
      await tg.sendPhotoFromFile(chatId, filePath, caption, options);
      return true;
    } catch {
      return false;
    }
  }

  async function trySendVideo(chatId, filePath, caption, options) {
    try {
      await fs.access(filePath);
      await tg.sendVideoFromFile(chatId, filePath, caption, options);
      return true;
    } catch (err) {
      console.error("[telegram] erro ao enviar video:", err?.message || err, err?.details || "");
      return false;
    }
  }

  async function trySendQrPhoto(chatId, base64Png, caption, options) {
    try {
      if (!base64Png) return false;
      await tg.sendPhotoFromBase64(chatId, base64Png, caption, options);
      return true;
    } catch (err) {
      console.error("[telegram] erro ao enviar QR em foto:", err?.message || err);
      return false;
    }
  }

  async function sendPixFlow({ chatId, from, forceNew, offer }) {
    const telegramUserId = from.id;
    const username = from.username || null;
    const selectedOffer = offer || vipOffers[0] || null;
    await storage.upsertUser(telegramUserId, {
      startReminderStage: null,
      startReminderBaseAt: null,
      startReminderNextAt: null
    });

    const user = await storage.upsertUser(telegramUserId, {
      telegramUsername: username,
      firstName: from.first_name || null,
      lastName: from.last_name || null,
      pendingVipOfferId: selectedOffer?.id || null
    });

    if (user.paid) {
      await tg.sendMessage(chatId, "<b>Pagamento já confirmado.</b>\nGerando seu link de acesso...", {
        parse_mode: "HTML"
      });
      await onApprovedUser({ telegramUserId });
      return;
    }

    const payerDocument = user.payerDocument || user.cpf || null;
    if (!payerDocument) {
      await storage.upsertUser(telegramUserId, {
        awaitingCpf: true,
        pendingPixForceNew: Boolean(forceNew),
        pendingVipOfferId: selectedOffer?.id || null
      });
      await tg.sendMessage(
        chatId,
        [
          "<b>Antes de gerar o Pix, preciso do seu CPF.</b>",
          "",
          "Envie agora seu CPF <b>apenas números</b> (11 dígitos).",
          "Ex: <code>12345678909</code>"
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    await storage.upsertUser(telegramUserId, {
      awaitingCpf: false,
      pendingPixForceNew: null,
      pendingVipOfferId: selectedOffer?.id || null,
      payerName: user.payerName || buildPayerName(from, username),
      payerDocument
    });

    const payment = forceNew && createPaymentForceNew
      ? await createPaymentForceNew({ telegramUserId, telegramUsername: username, offer: selectedOffer })
      : await createOrReusePayment({ telegramUserId, telegramUsername: username, offer: selectedOffer });

    await storage.upsertUser(telegramUserId, { pendingPaymentExpiredNotifiedAt: null });

    const amountBrl = escapeHtml(formatBrl(payment.amount || selectedOffer?.amount || vipPrice || 29.9));
    const qrCode = escapeHtml(payment.qrCode || "(não retornado pela API)");

    const text = config.telegram.texts.pixMessage({
      amountBrl,
      qrCode
    });

    const supportUser = process.env.SUPPORT_USERNAME ? String(process.env.SUPPORT_USERNAME).trim() : null;
    const supportUrl = supportUser ? `https://t.me/${supportUser.replace(/^@/, "")}` : null;
    const reply_markup = {
      inline_keyboard: [
        [{ text: config.telegram.buttons.checkPaid, callback_data: config.telegram.steps.checkPayment }],
        [{ text: config.telegram.buttons.copyPixCode, callback_data: config.telegram.steps.copyPix }],
        supportUrl ? [{ text: config.telegram.buttons.support, url: supportUrl }] : []
      ].filter((row) => row.length > 0)
    };

    const sentQr = await trySendQrPhoto(chatId, payment.qrCodeBase64, text, { parse_mode: "HTML", reply_markup });
    schedulePixReminders({ chatId, telegramUserId });
    if (sentQr) return;

    schedulePixReminders({ chatId, telegramUserId });
    await tg.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup });
  }

  async function handleStart(message) {
    if (!isPrivateChat(message)) return;
    const chatId = message.chat.id;
    const telegramUserId = message.from?.id || chatId;
    const startPayload = String(message.text || "").trim().split(/\s+/)[1] || null;
    await storage.upsertUser(telegramUserId, {
      telegramUsername: message.from?.username || null,
      firstName: message.from?.first_name || null,
      lastName: message.from?.last_name || null,
      botBlockedAt: null,
      botBlockedContext: null,
      startedAt: (await storage.getUser(telegramUserId))?.startedAt || new Date().toISOString(),
      lastStartAt: new Date().toISOString(),
      startReminderStage: 0,
      startReminderBaseAt: new Date().toISOString(),
      startReminderNextAt: new Date(Date.now() + 60_000).toISOString()
    });

    if (startPayload?.startsWith("claim_") && redeemWebCheckoutClaim) {
      const claimToken = startPayload.slice("claim_".length).trim();
      const result = await redeemWebCheckoutClaim({
        claimToken,
        telegramUserId,
        telegramUsername: message.from?.username || null,
        firstName: message.from?.first_name || null,
        lastName: message.from?.last_name || null
      });

      if (result?.status === "ok") {
        await tg.sendMessage(chatId, "<b>Pagamento localizado.</b>\nTo liberando seu acesso agora... \u{1F525}", {
          parse_mode: "HTML"
        });
        return;
      }
      if (result?.status === "pending") {
        await tg.sendMessage(chatId, "Seu pagamento web ainda nao apareceu como aprovado. Assim que pagar, abra este link novamente.", {
          parse_mode: "HTML"
        });
        return;
      }
      if (result?.status === "expired") {
        await tg.sendMessage(chatId, "Esse checkout web expirou. Gere um novo Pix no site.", {
          parse_mode: "HTML"
        });
        return;
      }
      if (result?.status === "claimed_by_other") {
        await tg.sendMessage(chatId, "Esse pagamento ja foi resgatado por outra conta do Telegram.", {
          parse_mode: "HTML"
        });
        return;
      }
      await tg.sendMessage(chatId, "Nao encontrei um checkout web valido para este link.", {
        parse_mode: "HTML"
      });
      return;
    }

    const text = config.telegram.texts.start();

    const reply_markup = { inline_keyboard: buildVipOfferKeyboardRows() };

    const sent = await trySendPhoto(chatId, startPhotoPath, text, {
      parse_mode: "HTML",
      reply_markup
    });
    if (sent) return;

    const sentVideo = await trySendVideo(chatId, startVideoPath, text, {
      parse_mode: "HTML",
      supports_streaming: true,
      reply_markup
    });
    if (sentVideo) return;

    await tg.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup
    });
  }

  async function handlePayCallback(callbackQuery, { forceNew, offer } = { forceNew: false, offer: null }) {
    const from = callbackQuery.from;
    const chatId = callbackQuery.message?.chat?.id || from.id;
    const chatType = callbackQuery.message?.chat?.type || "private";

    if (chatType !== "private") {
      await tg.answerCallbackQuery(callbackQuery.id, { text: "Abra uma conversa privada comigo para pagar." });
      return;
    }

    await tg.answerCallbackQuery(callbackQuery.id, { text: "Gerando Pix... 🔥" });

    try {
      const user = await storage.getUser(from.id);
      const resolvedOffer = offer || getOfferById(user?.pendingVipOfferId) || vipOffers[0] || null;
      await sendPixFlow({ chatId, from, forceNew, offer: resolvedOffer });
    } catch (err) {
      const message = err?.message || "Erro inesperado ao gerar o Pix.";
      console.error("[telegram] erro ao gerar pix:", message, err?.details || "");
      await tg.sendMessage(
        chatId,
        [
          "<b>Não consegui gerar o Pix agora.</b>",
          "",
          escapeHtml(message),
          "",
          "Revise as variáveis da MisticPay e o WEBHOOK_URL. Depois tente novamente."
        ].join("\n"),
        { parse_mode: "HTML" }
      );
    }
  }

  async function handleVideoCallCallback(callbackQuery) {
    const chatId = callbackQuery.message?.chat?.id || callbackQuery.from.id;
    const chatType = callbackQuery.message?.chat?.type || "private";
    if (chatType !== "private") {
      await tg.answerCallbackQuery(callbackQuery.id, { text: "Abra uma conversa privada comigo." });
      return;
    }
    await tg.answerCallbackQuery(callbackQuery.id, { text: "Abrindo... 📸🔥" });

    const phone = process.env.WHATSAPP_NUMBER || config.telegram.videoCall?.whatsappPhone;
    const offers = config.telegram.videoCall?.offers || [];

    const inline_keyboard = offers
      .map((offer) => {
        const text = config.telegram.videoCall?.whatsappText
          ? config.telegram.videoCall.whatsappText({ minutes: offer.minutes, price: offer.price })
          : `Quero chamada de video ${offer.minutes}min (R$ ${offer.price})`;
        const url = buildWhatsAppUrl({ phone, text });
        if (!url) return null;
        return [{ text: offer.label, url }];
      })
      .filter(Boolean);

    const reply_markup = inline_keyboard.length > 0 ? { inline_keyboard } : undefined;

    const caption = config.telegram.texts.videoCall();
    const sent = await trySendPhoto(chatId, videoCallPhotoPath, caption, {
      parse_mode: "HTML",
      reply_markup
    });
    if (sent) return;

    await tg.sendMessage(chatId, caption, { parse_mode: "HTML", reply_markup });
  }

  async function handlePreviewCallback(callbackQuery) {
    const chatId = callbackQuery.message?.chat?.id || callbackQuery.from.id;
    const chatType = callbackQuery.message?.chat?.type || "private";
    if (chatType !== "private") {
      await tg.answerCallbackQuery(callbackQuery.id, { text: "Abra uma conversa privada comigo." });
      return;
    }
    await tg.answerCallbackQuery(callbackQuery.id, { text: "Enviando... 😈🔥" });

    const photos = Array.isArray(previewPhotoPaths) ? previewPhotoPaths : [];
    for (let i = 0; i < photos.length; i += 1) {
      const caption = i === 0 ? config.telegram.texts.previewCaption() : undefined;
      const options = caption ? { parse_mode: "HTML" } : undefined;
      await trySendPhoto(chatId, photos[i], caption, options);
    }

    await tg.sendMessage(chatId, config.telegram.texts.previewCta(), {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: buildVipOfferKeyboardRows(vipOffers.slice(0, 1))
      }
    });
  }


  async function handlePrivacyCallback(callbackQuery) {
    const chatId = callbackQuery.message?.chat?.id || callbackQuery.from.id;
    const chatType = callbackQuery.message?.chat?.type || "private";
    if (chatType !== "private") {
      await tg.answerCallbackQuery(callbackQuery.id, { text: "Abra uma conversa privada comigo." });
      return;
    }
    await tg.answerCallbackQuery(callbackQuery.id, { text: "Certo." });

    const text = config.telegram.texts.privacy();

    await tg.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          ...buildVipOfferKeyboardRows(),
          [{ text: config.telegram.buttons.startPreview, callback_data: config.telegram.steps.preview }]
        ]
      }
    });
  }

  async function handleCheckPaymentCallback(callbackQuery) {
    const from = callbackQuery.from;
    const chatId = callbackQuery.message?.chat?.id || from.id;
    const chatType = callbackQuery.message?.chat?.type || "private";
    if (chatType !== "private") {
      await tg.answerCallbackQuery(callbackQuery.id, { text: "Checagem só no privado." });
      return;
    }

    await tg.answerCallbackQuery(callbackQuery.id, { text: "Checando pagamento..." });
    if (!checkPaymentStatus) {
      await tg.sendMessage(chatId, "Checagem manual não está habilitada.", { parse_mode: "HTML" });
      return;
    }

    const result = await checkPaymentStatus({ telegramUserId: from.id });
    if (!result?.paymentId) {
      await tg.sendMessage(chatId, "Não encontrei um Pix pendente. Gere um novo no botão abaixo.", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buildVipOfferKeyboardRows() }
      });
      return;
    }

    if (result.status === "approved") {
      clearPixReminderTimers(from.id);
      await tg.sendMessage(chatId, config.telegram.texts.paymentApprovedChecking(), { parse_mode: "HTML" });
      try {
        await onApprovedUser({ telegramUserId: from.id });
      } catch (err) {
        const msg = err?.message || "Falha ao gerar o convite.";
        await tg.sendMessage(
          chatId,
          [
            "<b>Pago confirmado, mas não consegui gerar o convite agora.</b>",
            "",
            escapeHtml(msg),
            "",
            "Tenta de novo em 1 minuto. Se persistir, chama o suporte."
          ].join("\n"),
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    const statusLabel = escapeHtml(result.status || "desconhecido");
    await tg.sendMessage(
      chatId,
      config.telegram.texts.notApproved(statusLabel),
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: config.telegram.buttons.checkPaid, callback_data: config.telegram.steps.checkPayment }],
            [{ text: config.telegram.buttons.copyPixCode, callback_data: config.telegram.steps.copyPix }]
          ]
        }
      }
    );
  }

  async function handleCopyPixCallback(callbackQuery) {
    const from = callbackQuery.from;
    const chatId = callbackQuery.message?.chat?.id || from.id;
    const chatType = callbackQuery.message?.chat?.type || "private";
    if (chatType !== "private") {
      await tg.answerCallbackQuery(callbackQuery.id, { text: "Abra uma conversa privada comigo." });
      return;
    }

    const pending = await storage.getPendingPayment(from.id);
    const code = pending?.qrCode ? String(pending.qrCode) : "";
    if (!code) {
      await tg.answerCallbackQuery(callbackQuery.id, { text: "Nao achei um Pix pendente. Gere um novo." });
      return;
    }

    await tg.answerCallbackQuery(callbackQuery.id, { text: "Enviei o codigo pra voce copiar \u{1F4CB}" });
    await tg.sendMessage(
      chatId,
      ["<b>Copia e cola (Pix):</b>", `<pre>${escapeHtml(code)}</pre>`].join("\n"),
      { parse_mode: "HTML" }
    );
  }

  async function handleRemoveCommand(message) {
    if (!isPrivateChat(message)) return;
    const text = message.text || "";
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
      await tg.sendMessage(message.chat.id, "Uso: /remover <telegram_user_id>", { parse_mode: "HTML" });
      return;
    }
    const adminId = process.env.ADMIN_TELEGRAM_ID ? Number(process.env.ADMIN_TELEGRAM_ID) : null;
    if (adminId && message.from?.id !== adminId) {
      await tg.sendMessage(message.chat.id, "Sem permissão.", { parse_mode: "HTML" });
      return;
    }

    const targetUserId = Number(parts[1]);
    if (!Number.isFinite(targetUserId)) {
      await tg.sendMessage(message.chat.id, "ID inválido.", { parse_mode: "HTML" });
      return;
    }

    await tg.removeUserFromGroup({ groupChatId: normalizedGroupChatId, telegramUserId: targetUserId });
    await tg.sendMessage(message.chat.id, `Usuário removido do grupo: ${targetUserId}`);
  }

  async function handleIdCommand(message) {
    if (!isPrivateChat(message)) return;
    const chatId = message.chat.id;
    const fromId = message.from?.id || null;
    const username = message.from?.username ? `@${message.from.username}` : null;
    const chatType = message.chat?.type || null;
    await tg.sendMessage(
      chatId,
      [
        "<b>IDs detectados:</b>",
        `- user_id: <code>${escapeHtml(fromId)}</code>`,
        username ? `- username: ${username}` : null,
        `- chat_id: <code>${escapeHtml(chatId)}</code>`,
        chatType ? `- chat_type: ${chatType}` : null
      ].filter(Boolean).join("\n"),
      { parse_mode: "HTML" }
    );
  }

  async function handleReportCommand(message) {
    if (!isPrivateChat(message)) return;
    const requesterId = Number(message.from?.id);
    const adminId = adminTelegramId ? Number(adminTelegramId) : null;
    if (!adminId || requesterId !== adminId) {
      await tg.sendMessage(message.chat.id, "Sem permissao.", { parse_mode: "HTML" });
      return;
    }
    if (!getAnalyticsReportText) {
      await tg.sendMessage(message.chat.id, "Relatorio indisponivel no momento.", { parse_mode: "HTML" });
      return;
    }

    const text = await getAnalyticsReportText();
    await tg.sendMessage(message.chat.id, text, { parse_mode: "HTML" });
  }

  async function handleUpdate(update) {
    if (update.message) {
      const msg = update.message;
      if (!isPrivateChat(msg)) return;
      const text = msg.text || "";
      if (text.startsWith("/start")) return handleStart(msg);
      if (msg.from?.id) {
        await storage.upsertUser(msg.from.id, {
          botBlockedAt: null,
          botBlockedContext: null,
          startReminderStage: null,
          startReminderBaseAt: null,
          startReminderNextAt: null
        });
      }
      if (text.startsWith("/id")) return handleIdCommand(msg);
      if (text.startsWith("/relatorio")) return handleReportCommand(msg);
      if (text.startsWith("/remover")) return handleRemoveCommand(msg);
      const telegramUserId = msg.from?.id;
      if (telegramUserId) {
        const user = await storage.getUser(telegramUserId);
        if (user?.awaitingCpf) {
          const cpf = normalizeCpfDigits(text);
          if (!cpf || !isValidCpf(cpf)) {
            await tg.sendMessage(
              msg.chat.id,
              "CPF inválido. Envie novamente <b>apenas números</b> (11 dígitos).",
              { parse_mode: "HTML" }
            );
            return;
          }
          await storage.upsertUser(telegramUserId, {
            payerDocument: cpf,
            cpf,
            awaitingCpf: false
          });
          const forceNew = Boolean(user?.pendingPixForceNew);
          const offer = getOfferById(user?.pendingVipOfferId) || vipOffers[0] || null;
          await sendPixFlow({ chatId: msg.chat.id, from: msg.from, forceNew, offer });
          return;
        }
      }
      return;
    }

    if (update.callback_query) {
      const cq = update.callback_query;
      if (cq.from?.id) {
        await storage.upsertUser(cq.from.id, {
          botBlockedAt: null,
          botBlockedContext: null,
          startReminderStage: null,
          startReminderBaseAt: null,
          startReminderNextAt: null
        });
      }
      if (cq.data === config.telegram.steps.enterVip) return handlePayCallback(cq, { forceNew: false, offer: vipOffers[0] || null });
      const callbackOffer = getOfferByCallbackData(cq.data);
      if (callbackOffer) return handlePayCallback(cq, { forceNew: false, offer: callbackOffer });
      if (cq.data === config.telegram.steps.payPix) return handlePayCallback(cq, { forceNew: false });
      if (cq.data === config.telegram.steps.payPixNew) return handlePayCallback(cq, { forceNew: true, offer: null });
      if (cq.data === config.telegram.steps.copyPix) return handleCopyPixCallback(cq);
      if (cq.data === config.telegram.steps.checkPayment) return handleCheckPaymentCallback(cq);
      if (cq.data === config.telegram.steps.preview) return handlePreviewCallback(cq);
      if (cq.data === config.telegram.steps.benefits) return handlePreviewCallback(cq);
      if (cq.data === config.telegram.steps.privacy) return handlePrivacyCallback(cq);
      if (cq.data === config.telegram.steps.videoCall) return handleVideoCallCallback(cq);
      await tg.answerCallbackQuery(cq.id, { text: "Ação desconhecida." });
    }
  }

  async function pollLoop() {
    if (running) return;
    running = true;

    while (running) {
      try {
        const updates = await tg.getUpdates({
          offset: lastUpdateId ? lastUpdateId + 1 : undefined,
          timeoutSeconds: 30
        });

        for (const update of updates) {
          lastUpdateId = Math.max(lastUpdateId, update.update_id || 0);
          await handleUpdate(update);
        }
      } catch (err) {
        const msg = err?.message || String(err);
        console.error("[telegram] poll error:", msg);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  async function sendVipInvite({ telegramUserId, inviteLink }) {
    const chatId = telegramUserId;
    const text = config.telegram.texts.vipInvite(escapeHtml(inviteLink));

    await trySendPhoto(
      chatId,
      vipPreviewPath,
      "<b>VIP liberado</b>\nSeu link exclusivo chegou.",
      { parse_mode: "HTML" }
    );

    await tg.sendMessage(chatId, text, { parse_mode: "HTML" });
  }

  async function createVipInviteLink() {
    const invite = await tg.createOneTimeInviteLink({
      groupChatId: normalizedGroupChatId,
      expireSeconds: 600
    });
    return invite?.invite_link;
  }

  return {
    pollLoop,
    sendVipInvite,
    createVipInviteLink,
    sendMessage: (chatId, text, options) => tg.sendMessage(chatId, text, options),
    removeUserFromGroup: (telegramUserId) => tg.removeUserFromGroup({ groupChatId, telegramUserId })
  };
}

module.exports = { createTelegramClient, createTelegramBot };
