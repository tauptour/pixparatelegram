const path = require("node:path");

const steps = {
  payPix: "pay_pix",
  payPixNew: "pay_pix_new",
  checkPayment: "check_payment",
  benefits: "benefits",
  privacy: "privacy",
  vibeSoft: "vibe_soft",
  vibeHot: "vibe_hot"
};

const buttons = {
  payPix: "🔥 Pagar via Pix",
  payPixCard: "💳 Pagar via Pix",
  preview: "😈 Quero uma prévia",
  rules: "🔒 Regras",
  checkPaid: "✅ Já paguei",
  newPix: "🔥 Gerar outro Pix",
};

const texts = {
  start: () =>
    [
      "<b>Bem-vindo(a) ao VIP</b> 🔥😈",
      "",
      "Acesso liberado assim que o Pix aprovar. ❤️"
    ].join("\n"),

  pixIntroCaption: () => "<b>Pix prontinho</b> 😈",

  pixMessage: ({ amountBrl, qrCode, ticketUrl }) =>
    [
      "<b>Pix gerado</b> 🔥",
      "",
      `<b>Valor:</b> ${amountBrl}`,
      "",
      "<b>Copia e cola:</b>",
      `<pre>${qrCode}</pre>`,
      ticketUrl ? `<b>Link do QR:</b> ${ticketUrl}` : null,
      "",
      "Pagou? clica em <b>“Já paguei”</b> ❤️"
    ].filter(Boolean).join("\n"),

  benefits: () => ["<b>Uma prévia do VIP</b> 👀🔥", "", "Escolhe o clima 😈"].join("\n"),

  privacy: () =>
    [
      "<b>Regras</b> 🔒",
      "",
      "• Tudo no <b>privado</b>",
      "• Link <b>único</b> e expira rápido",
      "• Pix pelo Mercado Pago"
    ].join("\n"),

  vibeHot: () =>
    [
      "<b>Mais quente</b> 🔥",
      "",
      "• Conteúdo +18 com uma pegada mais intensa",
      "• Acesso liberado assim que o Pix aprovar",
      "• Atualizações frequentes… pra te deixar querendo mais"
    ].join("\n"),

  vibeSoft: () =>
    [
      "<b>Mais discreto</b> 🤫",
      "",
      "• Conteúdo +18 com um tom mais leve e elegante",
      "• Acesso liberado assim que o Pix aprovar",
      "• Sem exposição: tudo no privado"
    ].join("\n"),

  paymentApprovedChecking: () => "<b>Pagamento aprovado</b> ✅\nCalma… tô liberando seu acesso agora. 🔥",

  notApproved: (statusLabel) =>
    [
      "<b>Ainda não aprovado</b> ⏳",
      "",
      `Status atual: <code>${statusLabel}</code>`,
      "",
      "Se você acabou de pagar, pode levar alguns instantes…",
      "Toca em <b>“Já paguei”</b> de novo em 1-2 minutos."
    ].join("\n"),

  vipInvite: (inviteLinkEscaped) =>
    [
      "<b>Pagamento aprovado!</b> 🔥",
      "",
      "Seu link exclusivo tá aqui 😈❤️",
      inviteLinkEscaped,
      "",
      "<b>Observações:</b>",
      "- Link válido por 10 minutos",
      "- Apenas 1 uso"
    ].join("\n")
};

module.exports = {
  telegram: {
    media: {
      startVideoPath: path.join(__dirname, "img", "start.mp4"),
      vipPreviewPath: path.join(__dirname, "img", "vip_preview.png"),
      pixPreviewPath: path.join(__dirname, "img", "pix_preview.jpg")
    },
    steps,
    buttons,
    texts
  }
};

