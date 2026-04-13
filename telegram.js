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
  storage,
  createOrReusePayment,
  createPaymentForceNew,
  checkPaymentStatus,
  onApprovedUser
}) {
  const tg = createTelegramClient({ token });
  const normalizedGroupChatId = normalizeGroupChatId(groupChatId);
  const vipPreviewPath = config.telegram.media.vipPreviewPath;
  const pixPreviewPath = config.telegram.media.pixPreviewPath;
  const startVideoPath = config.telegram.media.startVideoPath;
  const videoCallPhotoPath = config.telegram.media.videoCallPhotoPath;
  const previewPhotoPaths = config.telegram.media.previewPhotoPaths;

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

  async function handleStart(message) {
    if (!isPrivateChat(message)) return;
    const chatId = message.chat.id;
    const text = config.telegram.texts.start();

    const reply_markup = {
      inline_keyboard: [
        [{ text: config.telegram.buttons.startEnterVip, callback_data: config.telegram.steps.enterVip }],
        [{ text: config.telegram.buttons.startVideoCall, callback_data: config.telegram.steps.videoCall }],
        [{ text: config.telegram.buttons.startPreview, callback_data: config.telegram.steps.preview }]
      ]
    };

    const sentVideo = await trySendVideo(chatId, startVideoPath, text, {
      parse_mode: "HTML",
      supports_streaming: true,
      reply_markup
    });
    if (sentVideo) return;

    const sent = await trySendPhoto(chatId, vipPreviewPath, text, {
      parse_mode: "HTML",
      reply_markup
    });
    if (sent) return;

    await tg.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup
    });
  }

  async function handlePayCallback(callbackQuery, { forceNew } = { forceNew: false }) {
    const from = callbackQuery.from;
    const chatId = callbackQuery.message?.chat?.id || from.id;
    const chatType = callbackQuery.message?.chat?.type || "private";
    const telegramUserId = from.id;
    const username = from.username || null;

    if (chatType !== "private") {
      await tg.answerCallbackQuery(callbackQuery.id, { text: "Abra uma conversa privada comigo para pagar." });
      return;
    }

    await tg.answerCallbackQuery(callbackQuery.id, { text: "Gerando Pix... 🔥" });

    try {
      const user = await storage.upsertUser(telegramUserId, {
        telegramUsername: username,
        firstName: from.first_name || null,
        lastName: from.last_name || null
      });

      if (user.paid) {
        await tg.sendMessage(chatId, "<b>Pagamento já confirmado.</b>\nGerando seu link de acesso...", {
          parse_mode: "HTML"
        });
        await onApprovedUser({ telegramUserId });
        return;
      }

      const payment = forceNew && createPaymentForceNew
        ? await createPaymentForceNew({ telegramUserId, telegramUsername: username })
        : await createOrReusePayment({ telegramUserId, telegramUsername: username });

      await trySendPhoto(
        chatId,
        pixPreviewPath,
        config.telegram.texts.pixIntroCaption(),
        { parse_mode: "HTML" }
      );

      await trySendQrPhoto(chatId, payment.qrCodeBase64, "QR Code Pix", { parse_mode: "HTML" });

      const text = config.telegram.texts.pixMessage({
        amountBrl: escapeHtml(formatBrl(vipPrice || 29.9)),
        qrCode: escapeHtml(payment.qrCode || "(não retornado pela API)"),
        ticketUrl: payment.ticketUrl ? escapeHtml(payment.ticketUrl) : null
      });

      const supportUser = process.env.SUPPORT_USERNAME ? String(process.env.SUPPORT_USERNAME).trim() : null;
      const supportUrl = supportUser ? `https://t.me/${supportUser.replace(/^@/, "")}` : null;

      await tg.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: config.telegram.buttons.checkPaid, callback_data: config.telegram.steps.checkPayment }],
            [{ text: config.telegram.buttons.newPix, callback_data: config.telegram.steps.payPixNew }],
            supportUrl ? [{ text: config.telegram.buttons.support, url: supportUrl }] : []
          ].filter((row) => row.length > 0)
        }
      });
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
          "Revise as variáveis do Mercado Pago e o WEBHOOK_URL. Depois tente novamente."
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
        inline_keyboard: [[{ text: config.telegram.buttons.subscribe, callback_data: config.telegram.steps.enterVip }]]
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
          [{ text: config.telegram.buttons.startEnterVip, callback_data: config.telegram.steps.enterVip }],
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
        reply_markup: { inline_keyboard: [[{ text: config.telegram.buttons.startEnterVip, callback_data: config.telegram.steps.enterVip }]] }
      });
      return;
    }

    if (result.status === "approved") {
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
            [{ text: config.telegram.buttons.newPix, callback_data: config.telegram.steps.payPixNew }]
          ]
        }
      }
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

  async function handleUpdate(update) {
    if (update.message) {
      const msg = update.message;
      if (!isPrivateChat(msg)) return;
      const text = msg.text || "";
      if (text.startsWith("/start")) return handleStart(msg);
      if (text.startsWith("/id")) return handleIdCommand(msg);
      if (text.startsWith("/remover")) return handleRemoveCommand(msg);
      return;
    }

    if (update.callback_query) {
      const cq = update.callback_query;
      if (cq.data === config.telegram.steps.enterVip) return handlePayCallback(cq, { forceNew: false });
      if (cq.data === config.telegram.steps.payPix) return handlePayCallback(cq, { forceNew: false });
      if (cq.data === config.telegram.steps.payPixNew) return handlePayCallback(cq, { forceNew: true });
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
