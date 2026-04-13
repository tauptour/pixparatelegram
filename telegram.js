const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

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
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${key}"\r\n\r\n`));
      chunks.push(Buffer.from(String(value)));
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
    answerCallbackQuery,
    getUpdates,
    createOneTimeInviteLink,
    removeUserFromGroup
  };
}

function createTelegramBot({
  token,
  groupChatId,
  storage,
  createOrReusePayment,
  createPaymentForceNew,
  checkPaymentStatus,
  onApprovedUser
}) {
  const tg = createTelegramClient({ token });
  const normalizedGroupChatId = normalizeGroupChatId(groupChatId);
  const vipPreviewPath = path.join(__dirname, "img", "vip_preview.png");
  const pixPreviewPath = path.join(__dirname, "img", "pix_preview.jpg");

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

  async function trySendPhoto(chatId, filePath, caption, options) {
    try {
      await fs.access(filePath);
      await tg.sendPhotoFromFile(chatId, filePath, caption, options);
      return true;
    } catch {
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
    const text = [
      "<b>Bem-vindo(a) ao VIP</b>",
      "",
      "Aqui o clima é mais quente, com conteúdo exclusivo e acesso liberado assim que o Pix aprovar.",
      "",
      "<b>Aviso:</b> conteúdo +18.",
      "",
      "Pronto(a) pra entrar? Toque em <b>“Pagar via Pix”</b> e eu te mando o QR e o copia-e-cola."
    ].join("\n");

    const sent = await trySendPhoto(chatId, vipPreviewPath, text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Pagar via Pix", callback_data: "pay_pix" }],
          [{ text: "Quero uma prévia", callback_data: "benefits" }],
          [{ text: "Privacidade e regras", callback_data: "privacy" }]
        ]
      }
    });
    if (sent) return;

    await tg.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Pagar via Pix", callback_data: "pay_pix" }],
          [{ text: "Quero uma prévia", callback_data: "benefits" }],
          [{ text: "Privacidade e regras", callback_data: "privacy" }]
        ]
      }
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

    await tg.answerCallbackQuery(callbackQuery.id, { text: "Gerando Pix..." });

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
        "<b>Pagamento Pix</b>\nUse o QR ou o copia-e-cola abaixo.",
        { parse_mode: "HTML" }
      );

      await trySendQrPhoto(chatId, payment.qrCodeBase64, "QR Code Pix", { parse_mode: "HTML" });

      const text = [
        "<b>Pix gerado</b>",
        "",
        "<b>Valor:</b> R$ 29,90",
        payment.ticketUrl ? `<b>Link do QR (Mercado Pago):</b> ${escapeHtml(payment.ticketUrl)}` : null,
        "",
        "<b>Código copia e cola (Pix):</b>",
        `<pre>${escapeHtml(payment.qrCode || "(não retornado pela API)")}</pre>`,
        `<b>ID do pagamento:</b> <code>${escapeHtml(payment.paymentId)}</code>`,
        "",
        "Depois que pagar, toque em <b>“Já paguei (checar)”</b> pra eu confirmar na hora.",
        "Se preferir, eu também libero automaticamente quando o Mercado Pago aprovar."
      ].filter(Boolean);

      const supportUser = process.env.SUPPORT_USERNAME ? String(process.env.SUPPORT_USERNAME).trim() : null;
      const supportUrl = supportUser ? `https://t.me/${supportUser.replace(/^@/, "")}` : null;

      await tg.sendMessage(chatId, text.join("\n"), {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Já paguei (checar)", callback_data: "check_payment" }],
            [{ text: "Gerar outro Pix", callback_data: "pay_pix_new" }],
            supportUrl ? [{ text: "Suporte", url: supportUrl }] : []
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

  async function handleBenefitsCallback(callbackQuery) {
    const chatId = callbackQuery.message?.chat?.id || callbackQuery.from.id;
    const chatType = callbackQuery.message?.chat?.type || "private";
    if (chatType !== "private") {
      await tg.answerCallbackQuery(callbackQuery.id, { text: "Abra uma conversa privada comigo." });
      return;
    }
    await tg.answerCallbackQuery(callbackQuery.id, { text: "Abrindo..." });

    const text = [
      "<b>Uma prévia do VIP</b>",
      "",
      "Escolha o tom que você prefere e eu te mostro como vai ser por aqui.",
      "",
      "<b>Lembrete:</b> tudo é enviado apenas no privado."
    ].join("\n");

    const sent = await trySendPhoto(chatId, vipPreviewPath, text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Mais discreto", callback_data: "vibe_soft" }],
          [{ text: "Mais quente", callback_data: "vibe_hot" }],
          [{ text: "Pagar via Pix", callback_data: "pay_pix" }]
        ]
      }
    });
    if (sent) return;

    await tg.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Mais discreto", callback_data: "vibe_soft" }],
          [{ text: "Mais quente", callback_data: "vibe_hot" }],
          [{ text: "Pagar via Pix", callback_data: "pay_pix" }]
        ]
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

    const text = [
      "<b>Privacidade e regras</b>",
      "",
      "• Eu não respondo no grupo. Tudo acontece aqui no privado.",
      "• O link do VIP é <b>único</b> (1 uso) e expira rápido.",
      "• Pagamento via Pix pelo Mercado Pago.",
      "",
      "Quando quiser, é só gerar o Pix."
    ].join("\n");

    await tg.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Pagar via Pix", callback_data: "pay_pix" }],
          [{ text: "Quero uma prévia", callback_data: "benefits" }]
        ]
      }
    });
  }

  async function handleVibeCallback(callbackQuery, vibe) {
    const chatId = callbackQuery.message?.chat?.id || callbackQuery.from.id;
    const chatType = callbackQuery.message?.chat?.type || "private";
    if (chatType !== "private") {
      await tg.answerCallbackQuery(callbackQuery.id, { text: "Abra uma conversa privada comigo." });
      return;
    }
    await tg.answerCallbackQuery(callbackQuery.id, { text: "Entendi." });

    const copy =
      vibe === "hot"
        ? [
            "<b>Mais quente</b>",
            "",
            "• Conteúdo +18 com uma pegada mais intensa",
            "• Acesso liberado assim que o Pix aprovar",
            "• Atualizações frequentes"
          ]
        : [
            "<b>Mais discreto</b>",
            "",
            "• Conteúdo +18 com um tom mais leve e elegante",
            "• Acesso liberado assim que o Pix aprovar",
            "• Sem exposição: tudo no privado"
          ];

    await tg.sendMessage(chatId, copy.join("\n"), {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "Pagar via Pix", callback_data: "pay_pix" }]]
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
        reply_markup: { inline_keyboard: [[{ text: "🔥 Pagar via Pix", callback_data: "pay_pix" }]] }
      });
      return;
    }

    if (result.status === "approved") {
      await tg.sendMessage(chatId, "<b>Pagamento aprovado</b>\nLiberando seu acesso agora...", { parse_mode: "HTML" });
      await onApprovedUser({ telegramUserId: from.id });
      return;
    }

    const statusLabel = escapeHtml(result.status || "desconhecido");
    await tg.sendMessage(
      chatId,
      [
        "<b>Ainda não aprovado</b>",
        "",
        `Status atual: <code>${statusLabel}</code>`,
        "",
        "Se você acabou de pagar, pode levar alguns instantes.",
        "Toque em <b>“Já paguei (checar)”</b> novamente em 1-2 minutos."
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Já paguei (checar)", callback_data: "check_payment" }],
            [{ text: "Gerar outro Pix", callback_data: "pay_pix_new" }]
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
      if (cq.data === "pay_pix") return handlePayCallback(cq, { forceNew: false });
      if (cq.data === "pay_pix_new") return handlePayCallback(cq, { forceNew: true });
      if (cq.data === "check_payment") return handleCheckPaymentCallback(cq);
      if (cq.data === "benefits") return handleBenefitsCallback(cq);
      if (cq.data === "privacy") return handlePrivacyCallback(cq);
      if (cq.data === "vibe_soft") return handleVibeCallback(cq, "soft");
      if (cq.data === "vibe_hot") return handleVibeCallback(cq, "hot");
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
    const text = [
      "<b>Pagamento aprovado!</b>",
      "",
      "Seu acesso está liberado. Aqui vai o link exclusivo para entrar no VIP:",
      escapeHtml(inviteLink),
      "",
      "<b>Observações:</b>",
      "- Link válido por 10 minutos",
      "- Apenas 1 uso"
    ].join("\n");

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
    removeUserFromGroup: (telegramUserId) => tg.removeUserFromGroup({ groupChatId, telegramUserId })
  };
}

module.exports = { createTelegramClient, createTelegramBot };
