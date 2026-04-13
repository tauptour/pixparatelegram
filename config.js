const path = require("node:path");

const steps = {
  enterVip: "enter_vip",
  payPix: "pay_pix",
  payPixNew: "pay_pix_new",
  checkPayment: "check_payment",
  preview: "preview",
  benefits: "benefits",
  privacy: "privacy",
  videoCall: "video_call"
};

const buttons = {
  startEnterVip: "Quero entrar no VIP 🔥",
  startVideoCall: "Chamada de Video 📸",
  startPreview: "Previa 😈",

  payPix: "Quero entrar no VIP 🔥",
  payPixCard: "💳 Pagar via Pix",
  rules: "🔒 Regras",
  checkPaid: "✅ Já paguei",
  newPix: "🔥 Gerar outro Pix",
  support: "� Suporte",
  subscribe: "Assinar agora 🔥"
};

const texts = {
  start: () =>
    [
      "<b>Bem-vindo(a) ao meu VIP</b> 🔥😈",
      "",
      "Receba muita putaria todos dias, Quero te deixar de pau duro! 🔥💦",
      "Deseja conhecer o melhor de mim? 💋"
    ].join("\n"),

  pixIntroCaption: () => "<b>Pix prontinho</b> 😈",

  pixMessage: ({ amountBrl, qrCode }) =>
    [
      "<b>Pix gerado</b> 🔥",
      "",
      `<b>Valor:</b> ${amountBrl}`,
      "",
      "<b>Copia e cola:</b>",
      `<pre>${qrCode}</pre>`,
      "",
      "Pagou? clica em <b>“Já paguei”</b> ❤️"
    ].filter(Boolean).join("\n"),

  previewCaption: () => ["<b>Prévia</b> �🔥", "", "Olha só um gostinho do que te espera…"].join("\n"),

  previewCta: () => ["Gostou? então vem pro VIP 😈❤️"].join("\n"),

  privacy: () =>
    [
      "<b>Regras</b> 🔒",
      "",
      "• Tudo no <b>privado</b>",
      "• Link <b>único</b> e expira rápido",
      "• Pix pelo Mercado Pago"
    ].join("\n"),

  videoCall: () =>
    [
      "<b>Chamada de vídeo</b> ��🔥",
      "",
      "Escolhe um pacote e me chama no WhatsApp 😈"
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

const videoCall = {
  whatsappPhone: "5599999999999",
  offers: [
    { label: "📸 10 min — R$ 50", minutes: 10, price: 50 },
    { label: "📸 20 min — R$ 90", minutes: 20, price: 90 },
    { label: "📸 30 min — R$ 120", minutes: 30, price: 120 }
  ],
  whatsappText: ({ minutes, price }) =>
    `Quero chamada de video ${minutes}min (R$ ${price}). Vim pelo Telegram 😈🔥`
};

module.exports = {
  telegram: {
    media: {
      startVideoPath: path.join(__dirname, "img", "start.mp4"),
      vipPreviewPath: path.join(__dirname, "img", "vip_preview.png"),
      pixPreviewPath: path.join(__dirname, "img", "pix_preview.jpg"),
      videoCallPhotoPath: path.join(__dirname, "img", "chamada.jpg"),
      previewPhotoPaths: [
        path.join(__dirname, "img", "previa_1.jpg"),
        path.join(__dirname, "img", "previa_2.jpg"),
        path.join(__dirname, "img", "previa_3.jpg")
      ]
    },
    steps,
    buttons,
    texts,
    videoCall
  }
};
