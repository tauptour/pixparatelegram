const path = require("node:path");

const steps = {
  enterVip: "enter_vip",
  vipPremiumChat: "vip_premium_chat",
  vipPremiumLifetime: "vip_premium_lifetime",
  payPix: "pay_pix",
  payPixNew: "pay_pix_new",
  copyPix: "copy_pix",
  checkPayment: "check_payment",
  preview: "preview",
  benefits: "benefits",
  privacy: "privacy",
  videoCall: "video_call"
};

// Edite aqui os planos do bot e do checkout web.
const vipOffers = [
  {
    id: "vip_premium_chat",
    step: steps.vipPremiumChat,
    label: "ASSINATURA + CHAT COMIGO (25,00)/mês",
    amount: 25,
    description: "ASSINATURA MÊS + CHAT COMIGO"
  },
  {
    id: "vip_premium_lifetime",
    step: steps.vipPremiumLifetime,
    label: "ASSINATURA (19,00)/mês",
    amount: 19,
    description: "ASSINATURA MÊS"
  }
];

// Edite aqui os textos da pagina web da Julia.
const webCheckout = {
  pageTitle: "Mundinho da Julia | +18",
  badge: "",
  headline: "Mundinho da Julia 💛",
  description:
    "Oie, Bem vindo ao meu mundinho! 💛 Veio do Instagram né? Lá você sabe que não pode me ver peladinha... Mas aqui você consegue ver tudinho e muito mais do que eu tenho pra entregar 😏🔥",
  formTitle: "Escolha sua Assinatura!",
  formDescription:
    "Selecione a opcao desejada para entrar no meu mundinho privado, preencha os dados e gere o QR Code em poucos segundos.",
  paymentTitle: "Pagamento",
  paymentPendingText: "Assim que o Pix for gerado, ele aparece aqui para copia ou leitura do QR Code.",
  approvedTitle: "Pagamento aprovado",
  approvedDescription: "Agora abra o bot no Telegram para concluir a liberacao do acesso ao canal privado.",
  deliveryTitle: "Entrega do acesso",
  deliveryDescription: "O link do canal privado da Julia Hoffmann e enviado somente no Telegram logo depois da confirmacao.",
  telegramButtonLabel: "Abrir Telegram"
};

const buttons = {
  startEnterVip: vipOffers[0].label,
  startEnterVipBasic: vipOffers[1].label,
  startVideoCall: "Chamada de Video \u{1F4F8}",
  startPreview: "Previa \u{1F608}",

  payPix: "Quero entrar no VIP \u{1F525}",
  payPixCard: "\u{1F4B3} Pagar via Pix",
  rules: "\u{1F512} Regras",
  checkPaid: "\u2705 Já Paguei",
  copyPixCode: "Copiar Codigo",
  support: "Suporte",
  subscribe: "Assinar agora \u{1F525}"
};

const texts = {
  start: () =>
    [
      "Oie, Bem vindo ao meu mundinho! \u{1F49B}",
      "",
      "Veio do Instagram né? Lá você sabe que não pode me ver peladinha...",
      "",
      "Mas aqui você consegue ver tudinho e muito mais do que eu tenho pra entregar \u{1F608}\u{1F60F}\u{1F525}"
    ].join("\n"),

  startReminderMessages: [
    [
      "Oii... vim aqui pessoalmente te chamar \u{1F608}",
      "",
      "Escolhe um dos planos e vem me conhecer melhor \u{1F49B}\u{1F525}"
    ].join("\n"),
    [
      "To aqui pensando em voce... \u{1F60F}",
      "",
      "Clica em um plano e eu libero tudo assim que confirmar \u{1F525}"
    ].join("\n"),
    [
      "Ultimo recadinho \u{1F608}",
      "",
      "Nao some... escolhe um plano pra eu te receber no VIP \u{1F49B}"
    ].join("\n")
  ],

  pixIntroCaption: () => "<b>Pix prontinho</b> \u{1F608}",

  pixMessage: ({ amountBrl, qrCode }) =>
    [
      `<b>Valor:</b> ${amountBrl}`,
      "",
      "<b>Copia e cola:</b>",
      `<pre>${qrCode}</pre>`,
      "",
      'Pagou? clica em <b>"Ja Paguei"</b> \u2764\uFE0F'
    ].filter(Boolean).join("\n"),

  pixReminderMessages: [
    [
      "Amor, você nem imagina o tanto de tesão que eu to \u{1F525}",
      "",
      "Passo o dia todo molhadinha e sozinha, pronta pra te mostrar tudinho \u2764\uFE0F"
    ].join("\n"),
    [
      "Você não vai aproveitar amor? Pra ver o meu lado mais safadinha e delicada? \u{1F608}",
      "",
      "Assim que o Pix cair eu ja preparo seu acesso. Nao me deixa esperando..."
    ].join("\n"),
    [
      "Vou te dar uma ultima chance para ter os meus conteudos mais explicitos que vc vai ter visto na vida! \u{1F525}",
      "",
      "Eu tenho certeza que vc vai gozar com muita força e bem gostoso! <b>\"Ja paguei\"</b> pra eu conferir."
    ].join("\n")
  ],

  pixExpiredMessage: () =>
    [
      "Ei... seu Pix expirou \u23F1\u{1F525}",
      "",
      "Quer que eu gere outro agora? \u{1F608}\u2764\uFE0F"
    ].join("\n"),

  previewCaption: () => ["<b>Previa</b> \u{1F608}\u{1F525}", "", "Olha so um gostinho do que te espera..."].join("\n"),

  previewCta: () => ["Gostou? entao vem pro VIP \u{1F608}\u2764\uFE0F"].join("\n"),

  privacy: () =>
    [
      "<b>Regras</b> \u{1F512}",
      "",
      "- Tudo no <b>privado</b>",
      "- Link <b>unico</b> e expira rapido",
      "- Pix via MisticPay"
    ].join("\n"),

  videoCall: () =>
    [
      "<b>Chamada de video</b> \u{1F4F8}\u{1F525}",
      "",
      "Escolhe um pacote e me chama no WhatsApp \u{1F608}"
    ].join("\n"),

  paymentApprovedChecking: () => "<b>Pagamento aprovado</b> \u2705\nCalma... to liberando seu acesso agora. \u{1F525}",

  notApproved: (statusLabel) =>
    [
      "<b>Ainda nao aprovado</b> \u23F3",
      "",
      `Status atual: <code>${statusLabel}</code>`,
      "",
      "Se voce acabou de pagar, pode levar alguns instantes...",
      'Toca em <b>"Ja paguei"</b> de novo em 1-2 minutos.'
    ].join("\n"),

  vipInvite: (inviteLinkEscaped) =>
    [
      "<b>Pagamento aprovado!</b> \u{1F525}",
      "",
      "Seu link exclusivo ta aqui \u{1F608}\u2764\uFE0F",
      inviteLinkEscaped,
      "",
      "<b>Observacoes:</b>",
      "- Link valido por 10 minutos",
      "- Apenas 1 uso"
    ].join("\n")
};

const videoCall = {
  whatsappPhone: "5599999999999",
  offers: [
    { label: "\u{1F4F8} 10 min - R$ 50", minutes: 10, price: 50 },
    { label: "\u{1F4F8} 20 min - R$ 90", minutes: 20, price: 90 },
    { label: "\u{1F4F8} 30 min - R$ 120", minutes: 30, price: 120 }
  ],
  whatsappText: ({ minutes, price }) =>
    `Quero chamada de video ${minutes}min (R$ ${price}). Vim pelo Telegram \u{1F608}\u{1F525}`
};

module.exports = {
  telegram: {
    media: {
      startPhotoPath: path.join(__dirname, "img", "Foto1.jpeg"),
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
    vipOffers,
    webCheckout,
    buttons,
    texts,
    videoCall
  }
};
