const path = require("node:path");
const crypto = require("node:crypto");
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });

const express = require("express");

const { createStorage } = require("./storage");
const { createPixPayment, getPaymentById } = require("./payment");
const { createTelegramBot } = require("./telegram");
const { createWebhookRouter } = require("./webhook");
const config = require("./config");

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

function getBotVersion() {
  const candidates = [
    process.env.RAILWAY_GIT_COMMIT_SHA,
    process.env.GITHUB_SHA,
    process.env.COMMIT_SHA,
    process.env.SOURCE_VERSION,
    process.env.BOT_VERSION
  ].filter(Boolean);
  const raw = candidates[0] ? String(candidates[0]).trim() : "dev";
  return raw.length > 12 ? raw.slice(0, 12) : raw;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatBrl(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "R$ 0,00";
  return `R$ ${n.toFixed(2).replace(".", ",")}`;
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

  return calc(9) === nums[9] && calc(10) === nums[10];
}

function normalizeTelegramUsername(raw) {
  const value = String(raw || "").trim().replace(/^@/, "");
  return value || null;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function getLocalDateKey(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function parseReportTime(rawHour, rawMinute) {
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  return {
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 23,
    minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 55
  };
}

function getEnvAny(names, { required } = { required: true }) {
  for (const name of names) {
    const v = getEnv(name, { required: false });
    if (v) return v;
  }
  if (required) throw new Error(`Variável de ambiente ausente: ${names.join(" ou ")}`);
  return null;
}

async function main() {
  const WEBHOOK_ONLY = isTruthyEnv(getEnv("WEBHOOK_ONLY", { required: false })) || isTruthyEnv(getEnv("ONLY_WEBHOOK", { required: false }));

  const PORT = Number(getEnv("PORT", { required: false }) || 3000);
  const MISTICPAY_CLIENT_ID = getEnvAny(["MISTICPAY_CLIENT_ID", "MISTICPAY_CI"]);
  const MISTICPAY_CLIENT_SECRET = getEnvAny(["MISTICPAY_CLIENT_SECRET", "MISTICPAY_CS"]);
  const WEBHOOK_URL = normalizeWebhookUrl(getEnv("WEBHOOK_URL", { required: false }));
  const STORAGE_FILE = getEnv("STORAGE_FILE", { required: false });
  const STORAGE_DIR = getEnv("STORAGE_DIR", { required: false });
  const VIP_PRICE = parseVipPrice(getEnv("VIP_PRICE", { required: false }));

  const TELEGRAM_TOKEN = getEnv("TELEGRAM_TOKEN", { required: false });
  const GROUP_CHAT_ID = getEnv("GROUP_CHAT_ID", { required: false });
  const TELEGRAM_BOT_USERNAME = normalizeTelegramUsername(getEnv("TELEGRAM_BOT_USERNAME", { required: false }));
  const storageFilePath = STORAGE_FILE || (STORAGE_DIR ? path.join(STORAGE_DIR, "data.json") : undefined);

  if (TELEGRAM_TOKEN && !looksLikeTelegramToken(TELEGRAM_TOKEN)) {
    throw new Error("TELEGRAM_TOKEN inválido. Verifique se você colou apenas o token do bot, sem SUPPORT_USERNAME ou outros textos.");
  }

  const storage = createStorage(storageFilePath ? { filePath: storageFilePath } : undefined);
  await storage.ensureLoaded();

  console.log("[build] version:", getBotVersion());

  const ADMIN_TELEGRAM_ID = getEnv("ADMIN_TELEGRAM_ID", { required: false });
  const ANALYTICS_TELEGRAM_ID = getEnv("ANALYTICS_TELEGRAM_ID", { required: false }) || ADMIN_TELEGRAM_ID;
  const { hour: analyticsHour, minute: analyticsMinute } = parseReportTime(
    getEnv("ANALYTICS_REPORT_HOUR", { required: false }),
    getEnv("ANALYTICS_REPORT_MINUTE", { required: false })
  );
  const vipOffers = Array.isArray(config.telegram?.vipOffers) ? config.telegram.vipOffers : [];
  const WEB_CHECKOUT_EXPIRY_MS = 10 * 60 * 1000;
  const webCheckoutConfig = {
    pageTitle: "Julia Hoffmann | Canal Privado",
    badge: "",
    headline: "Mundinho da Julia 💛😈",
    description:
      "Escolha seu plano, gere o Pix e acompanhe o pagamento por aqui. Depois da aprovacao, o acesso ao canal privado de conteudos adultos e liberado no Telegram.",
    formTitle: "Escolha seu acesso",
    formDescription:
      "Selecione a opcao desejada para entrar no canal privado da Julia Hoffmann, preencha os dados e gere o QR Code em poucos segundos.",
    paymentTitle: "Pagamento",
    paymentPendingText: "Assim que o Pix for gerado, ele aparece aqui para copia ou leitura do QR Code.",
    approvedTitle: "Pagamento aprovado",
    approvedDescription: "Agora abra o bot no Telegram para concluir a liberacao do acesso ao canal privado.",
    deliveryTitle: "Entrega do acesso",
    deliveryDescription: "O link do canal privado da Julia Hoffmann e enviado somente no Telegram logo depois da confirmacao.",
    telegramButtonLabel: "Abrir Telegram",
    ...config.telegram?.webCheckout
  };

  function getOfferById(offerId) {
    return vipOffers.find((offer) => String(offer?.id || "") === String(offerId || "")) || null;
  }

  function getOfferCallbackData(offer) {
    if (!offer?.id) return null;
    return offer.step || `offer:${offer.id}`;
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

  function buildTelegramClaimUrl(claimToken) {
    if (!TELEGRAM_BOT_USERNAME || !claimToken) return null;
    return `https://t.me/${TELEGRAM_BOT_USERNAME}?start=claim_${encodeURIComponent(String(claimToken))}`;
  }

  function hasApprovedPaymentEvidence(payment) {
    return Boolean(payment?.approvedAt || payment?.status === "approved");
  }

  function getWebCheckoutAgeMs(checkout) {
    const createdAtMs = Date.parse(checkout?.createdAt || "") || 0;
    if (!createdAtMs) return 0;
    return Date.now() - createdAtMs;
  }

  function getWebCheckoutStatusView(checkout, payment) {
    if (!checkout) return "not_found";
    if (checkout.claimedAt) return "claimed";
    if (hasApprovedPaymentEvidence(payment)) return "approved";
    if (checkout.expiredAt || checkout.status === "expired") return "expired";
    if (getWebCheckoutAgeMs(checkout) >= WEB_CHECKOUT_EXPIRY_MS) return "expired";
    if (checkout.status && !["approved", "claimed", "expired"].includes(checkout.status)) {
      return checkout.status;
    }
    return "pending";
  }

  async function syncWebCheckoutState(checkout, payment) {
    if (!checkout) return { checkout: null, payment, status: "not_found" };

    let currentCheckout = checkout;
    const paymentApproved = hasApprovedPaymentEvidence(payment);
    const computedStatus = getWebCheckoutStatusView(currentCheckout, payment);

    if (computedStatus === "expired" && !paymentApproved && currentCheckout.status !== "expired") {
      currentCheckout = await storage.markWebCheckoutExpired(currentCheckout.checkoutId, {
        inviteLink: null
      });
    }

    if (computedStatus === "approved" && paymentApproved && currentCheckout.status !== "approved") {
      currentCheckout = await storage.markWebCheckoutApproved(currentCheckout.checkoutId, {
        paymentId: currentCheckout.paymentId
      });
    }

    return {
      checkout: currentCheckout,
      payment,
      status: getWebCheckoutStatusView(currentCheckout, payment)
    };
  }

  async function getGatewayPaymentSnapshot(paymentId) {
    if (!paymentId) return null;
    try {
      return await getPaymentById({
        clientId: MISTICPAY_CLIENT_ID,
        clientSecret: MISTICPAY_CLIENT_SECRET,
        paymentId
      });
    } catch (error) {
      const message = error?.message || String(error);
      console.error("[web-checkout] gateway status error:", paymentId, message);
      return null;
    }
  }

  async function createWebCheckout({ payerName, payerDocument, offer }) {
    const checkoutId = crypto.randomUUID();
    const claimToken = crypto.randomUUID().replaceAll("-", "");
    const selectedOffer = offer || vipOffers[0] || null;

    const payment = await createPixPayment({
      clientId: MISTICPAY_CLIENT_ID,
      clientSecret: MISTICPAY_CLIENT_SECRET,
      amount: selectedOffer?.amount || VIP_PRICE,
      description: selectedOffer?.description || "Acesso ao Grupo VIP Telegram",
      telegramUserId: `web_${checkoutId}`,
      telegramUsername: null,
      payerName,
      payerDocument,
      webhookUrl: WEBHOOK_URL
    });

    await storage.upsertPayment(payment.paymentId, {
      paymentId: payment.paymentId,
      status: payment.status,
      createdAt: payment.createdAt,
      amount: payment.amount,
      offerId: selectedOffer?.id || null,
      description: selectedOffer?.description || "Acesso ao Grupo VIP Telegram",
      qrCode: payment.qrCode,
      qrCodeBase64: payment.qrCodeBase64,
      ticketUrl: payment.ticketUrl,
      checkoutId,
      channel: "web"
    });

    await storage.upsertWebCheckout(checkoutId, {
      checkoutId,
      claimToken,
      paymentId: payment.paymentId,
      offerId: selectedOffer?.id || null,
      amount: payment.amount,
      payerName,
      payerDocument,
      createdAt: payment.createdAt,
      status: payment.status || "pending"
    });

    return { checkoutId, claimToken, payment, offer: selectedOffer };
  }

  function renderWebCheckoutPage() {
    const faviconHref = `data:image/svg+xml,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" font-size="52">💛</text></svg>'
    )}`;
    const offersJson = JSON.stringify(
      vipOffers.map((offer) => ({
        id: offer.id,
        label: offer.label,
        amount: offer.amount,
        description: offer.description
      }))
    );
    const botUsernameText = TELEGRAM_BOT_USERNAME ? `@${TELEGRAM_BOT_USERNAME}` : "seu bot no Telegram";
    const bannerImageUrl = "/checkout/banner";
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(webCheckoutConfig.pageTitle)}</title>
  <link rel="icon" href="${faviconHref}" />
  <style>
    * { box-sizing:border-box; }
    body {
      margin:0;
      font-family: Arial, sans-serif;
      color:#141414;
      background:
        radial-gradient(circle at top, #fff8dc 0, #f8f3e3 32%, #f3eedf 100%);
      min-height:100vh;
      padding:18px;
    }
    .wrap {
      max-width:560px;
      margin:0 auto;
    }
    .hero {
      position:relative;
      overflow:hidden;
      border:1px solid #efe8ce;
      border-radius:12px;
      padding:22px;
      margin-bottom:16px;
      background:linear-gradient(180deg, #fffdf7, #fff9ea);
      box-shadow:0 10px 28px rgba(63, 49, 11, 0.06);
    }
    .hero::before {
      content:"";
      position:absolute;
      left:0;
      top:0;
      width:100%;
      height:4px;
      background:linear-gradient(90deg, #ffd54a, #f0bf00);
    }
    .hero-banner {
      position:relative;
      overflow:hidden;
      border-radius:10px;
      margin-bottom:20px;
      background:#f1ead0;
      aspect-ratio: 16 / 9;
      border:1px solid #efe1a9;
    }
    .hero-banner img {
      width:100%;
      height:100%;
      object-fit:cover;
      display:block;
      transform:scale(1.04);
      filter:blur(18px) saturate(0.95);
      transition:filter 0.25s ease, transform 0.25s ease;
    }
    .hero-banner.revealed img {
      filter:none;
      transform:scale(1);
    }
    .hero-banner::after {
      content:"";
      position:absolute;
      inset:0;
      background:linear-gradient(180deg, rgba(17,17,17,0.10), rgba(17,17,17,0.18));
      pointer-events:none;
    }
    .hero-eye {
      position:absolute;
      left:50%;
      top:50%;
      transform:translate(-50%, -50%);
      width:68px;
      height:68px;
      border:none;
      border-radius:999px;
      background:rgba(255,255,255,0.92);
      color:#1d1d1d;
      font-size:28px;
      line-height:1;
      box-shadow:0 10px 26px rgba(0,0,0,0.14);
      z-index:2;
      cursor:pointer;
    }
    .hero-eye-label {
      position:absolute;
      left:50%;
      bottom:14px;
      transform:translateX(-50%);
      z-index:2;
      padding:7px 12px;
      border-radius:10px;
      background:rgba(255,255,255,0.92);
      color:#2a2a2a;
      font-size:12px;
      font-weight:700;
      white-space:nowrap;
      box-shadow:0 8px 20px rgba(0,0,0,0.10);
    }
    .hero h1 {
      margin:0 0 8px;
      font-size:32px;
      line-height:1.02;
      letter-spacing:-0.9px;
      color:#181818;
    }
    .hero p {
      margin:0;
      color:#555555;
      font-size:15px;
      line-height:1.6;
    }
    .grid {
      display:grid;
      grid-template-columns:1fr;
      gap:16px;
      align-items:start;
    }
    .card {
      background:#ffffff;
      border:1px solid #ece4c6;
      border-radius:12px;
      padding:22px;
      box-shadow:0 10px 30px rgba(67, 53, 14, 0.05);
      transition:opacity 0.18s ease, transform 0.18s ease, border-color 0.18s ease;
    }
    .card h2 {
      margin-bottom:8px;
      font-size:22px;
      letter-spacing:-0.4px;
    }
    .card.is-complete {
      opacity:0.88;
      border-color:#e5d591;
    }
    .card h2, .card h3, .card p { margin-top:0; }
    .offers {
      display:grid;
      gap:10px;
      margin:18px 0 20px;
    }
    .offer {
      position:relative;
      border:1px solid #e8e0c6;
      border-radius:10px;
      padding:18px;
      cursor:pointer;
      background:#ffffff;
      transition:transform 0.15s ease, border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
    }
    .offer:hover {
      transform:translateY(-1px);
      border-color:#d8bc42;
    }
    .offer.active {
      border-color:#e3c230;
      background:linear-gradient(180deg, #fffdf2, #fff7d8);
      box-shadow:0 8px 22px rgba(204, 169, 14, 0.10);
    }
    .offer-title {
      display:flex;
      justify-content:space-between;
      gap:16px;
      align-items:center;
      font-weight:700;
      margin-bottom:6px;
    }
    .offer-price {
      color:#8a6f00;
      white-space:nowrap;
    }
    .offer-desc {
      color:#5f5f5f;
      font-size:14px;
      line-height:1.5;
    }
    label {
      display:block;
      font-size:13px;
      margin:14px 0 8px;
      color:#575757;
      font-weight:700;
      letter-spacing:0.3px;
      text-transform:uppercase;
    }
    input, button {
      width:100%;
      border-radius:10px;
      padding:15px 16px;
      font-size:16px;
      box-sizing:border-box;
    }
    input {
      border:1px solid #ddd2a8;
      background:#fffefa;
      color:#171717;
      outline:none;
    }
    input:focus {
      border-color:#d8b300;
      box-shadow:0 0 0 4px rgba(232, 194, 40, 0.18);
    }
    button {
      border:none;
      cursor:pointer;
      font-weight:700;
      letter-spacing:0.2px;
      background:linear-gradient(180deg, #ffd43e, #efbf00);
      color:#1f1b07;
      box-shadow:0 10px 22px rgba(212, 170, 0, 0.16);
    }
    #createBtn {
      margin-top:12px;
    }
    button.secondary {
      margin-top:12px;
      background:#fffefa;
      color:#2b2b2b;
      box-shadow:none;
      border:1px solid #ddd2a8;
    }
    .muted {
      color:#666666;
      font-size:14px;
      line-height:1.6;
    }
    .hidden { display:none; }
    [hidden] { display:none !important; }
    .status-card {
      min-height:0;
    }
    .status-card.is-visible {
      display:flex;
      animation:fadeUp 0.25s ease;
      flex-direction:column;
    }
    @keyframes fadeUp {
      from { opacity:0; transform:translateY(10px); }
      to { opacity:1; transform:translateY(0); }
    }
    .status-box {
      margin-top:14px;
      padding:16px;
      border-radius:10px;
      border:1px solid #efe5ba;
      background:#fffefa;
    }
    .status-line {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      margin-bottom:14px;
    }
    .status-badge {
      display:inline-flex;
      align-items:center;
      padding:8px 12px;
      border-radius:10px;
      font-size:12px;
      font-weight:700;
      text-transform:uppercase;
      letter-spacing:0.5px;
      background:#fff1b2;
      color:#7b6200;
    }
    .status-badge.approved, .status-badge.claimed {
      background:#e6f5dd;
      color:#2c6a27;
    }
    .status-badge.expired {
      background:#fde5e2;
      color:#a33d32;
    }
    pre {
      margin:0;
      white-space:pre-wrap;
      word-break:break-word;
      background:#fffdf6;
      padding:14px;
      border-radius:10px;
      border:1px solid #ece2bd;
      color:#313131;
      line-height:1.6;
    }
    img.qr {
      width:250px;
      max-width:100%;
      display:block;
      margin:14px auto;
      border-radius:10px;
      padding:12px;
      background:#fff;
      box-shadow:0 10px 24px rgba(84, 69, 25, 0.10);
      border:1px solid #efe3b5;
    }
    a.action {
      display:inline-block;
      margin-top:12px;
      background:#191919;
      color:#ffffff;
      text-decoration:none;
      padding:14px 18px;
      border-radius:10px;
      font-weight:700;
      text-align:center;
    }
    .steps {
      display:grid;
      gap:12px;
      margin-top:18px;
    }
    .step {
      padding:14px 16px;
      border-radius:10px;
      background:#fffefa;
      border:1px solid #efe5ba;
    }
    .step strong {
      display:block;
      margin-bottom:6px;
      color:#5b4900;
    }
    .footer-note {
      margin-top:auto;
      padding-top:18px;
      color:#777777;
      font-size:12px;
      line-height:1.6;
    }
    .popup-backdrop {
      position:fixed;
      inset:0;
      background:rgba(15, 15, 15, 0.52);
      display:flex;
      align-items:center;
      justify-content:center;
      padding:18px;
      z-index:50;
    }
    .popup-backdrop.hidden {
      display:none;
    }
    .popup-card {
      width:100%;
      max-width:420px;
      background:#ffffff;
      border:1px solid #ece4c6;
      border-radius:12px;
      padding:22px;
      box-shadow:0 18px 50px rgba(0, 0, 0, 0.18);
    }
    .popup-card h3 {
      margin:0 0 10px;
      font-size:24px;
      letter-spacing:-0.5px;
      color:#151515;
    }
    .popup-card p {
      margin:0 0 16px;
      color:#505050;
      line-height:1.6;
    }
    .popup-actions {
      display:grid;
      gap:10px;
    }
    .popup-link {
      display:block;
      width:100%;
      text-align:center;
      text-decoration:none;
      border-radius:10px;
      padding:14px 18px;
      background:linear-gradient(180deg, #ffd43e, #efbf00);
      color:#1f1b07;
      font-weight:700;
      box-shadow:0 10px 22px rgba(212, 170, 0, 0.16);
    }
    .popup-close {
      width:100%;
      border:1px solid #ddd2a8;
      border-radius:10px;
      background:#fffefa;
      color:#2b2b2b;
      box-shadow:none;
    }
    .social-proof {
      margin-top:18px;
      background:#ffffff;
      border:1px solid #ece4c6;
      border-radius:12px;
      padding:22px;
      box-shadow:0 10px 30px rgba(67, 53, 14, 0.05);
    }
    .social-proof-header {
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      gap:12px;
      margin-bottom:16px;
    }
    .social-proof h3 {
      margin:0 0 6px;
      font-size:22px;
      letter-spacing:-0.4px;
    }
    .testimonial-slider {
      position:relative;
      overflow:hidden;
      border-radius:10px;
      border:1px solid #eee3b7;
      background:linear-gradient(180deg, #fffdf6, #fff8e4);
      min-height:220px;
    }
    .testimonial-track {
      display:flex;
      transition:transform 0.35s ease;
      will-change:transform;
    }
    .testimonial-slide {
      min-width:100%;
      padding:22px;
    }
    .testimonial-top {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      margin-bottom:16px;
    }
    .testimonial-name {
      font-weight:700;
      color:#1f1f1f;
    }
    .testimonial-badge {
      display:inline-flex;
      align-items:center;
      padding:7px 10px;
      border-radius:10px;
      background:#fff1b2;
      color:#6f5700;
      font-size:11px;
      font-weight:700;
      text-transform:uppercase;
      letter-spacing:0.4px;
    }
    .testimonial-text {
      margin:0;
      color:#383838;
      font-size:15px;
      line-height:1.7;
    }
    .testimonial-controls {
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      margin-top:14px;
    }
    .testimonial-nav {
      display:flex;
      gap:8px;
    }
    .testimonial-btn {
      width:42px;
      min-width:42px;
      min-height:42px;
      border:none;
      border-radius:10px;
      background:#191919;
      color:#ffffff;
      box-shadow:none;
      padding:0;
      flex:0 0 auto;
    }
    .testimonial-dots {
      display:flex;
      gap:8px;
      align-items:center;
      justify-content:flex-end;
      flex:1;
    }
    .testimonial-dot {
      width:8px;
      height:8px;
      min-width:8px;
      min-height:8px;
      border:none;
      padding:0;
      box-shadow:none;
      cursor:pointer;
      flex:0 0 auto;
      border-radius:999px;
      background:#d8cfab;
      opacity:0.8;
      transition:transform 0.2s ease, background 0.2s ease, opacity 0.2s ease;
    }
    .testimonial-dot.active {
      width:22px;
      background:#d4ab00;
      opacity:1;
    }
    @media (max-width: 860px) {
      body { padding:12px; }
      .hero h1 { font-size:28px; }
      .card, .hero { padding:18px; border-radius:10px; }
      .social-proof { padding:18px; border-radius:10px; }
      .offer-title { align-items:flex-start; flex-direction:column; gap:6px; }
      input, button, a.action { min-height:52px; }
      .testimonial-slide { padding:18px; }
      .social-proof-header,
      .testimonial-top,
      .testimonial-controls {
        flex-direction:column;
        align-items:flex-start;
      }
      .testimonial-dots { justify-content:flex-start; }
      .hero-eye {
        width:60px;
        height:60px;
        font-size:24px;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div id="heroBanner" class="hero-banner">
        <img src="${bannerImageUrl}" alt="Banner VIP" />
        <button id="heroEye" class="hero-eye" type="button" aria-label="Revelar imagem">👁</button>
        <div id="heroEyeLabel" class="hero-eye-label">Toque para revelar</div>
      </div>
      <h1>${escapeHtml(webCheckoutConfig.headline)}</h1>
      <p>${escapeHtml(webCheckoutConfig.description)}</p>
    </div>
    <div class="grid">
      <div id="formCard" class="card">
        <h2>${escapeHtml(webCheckoutConfig.formTitle)}</h2>
        <p class="muted">${escapeHtml(webCheckoutConfig.formDescription)}</p>
        <div id="offers" class="offers"></div>
        <label for="payerName">Nome</label>
        <input id="payerName" placeholder="Digite seu nome" />
        <label for="payerDocument">CPF</label>
        <input id="payerDocument" placeholder="Somente numeros" maxlength="14" />
        <button id="createBtn">Continuar para pagamento</button>
        <p id="formError" class="muted"></p>
      </div>
      <div id="statusCard" class="card status-card hidden">
        <h2>${escapeHtml(webCheckoutConfig.paymentTitle)}</h2>
        <div class="status-box">
          <div class="status-line">
            <strong>Status do pedido</strong>
            <span id="statusBadge" class="status-badge">Aguardando</span>
          </div>
          <p id="statusText" class="muted">${escapeHtml(webCheckoutConfig.paymentPendingText)}</p>
        </div>
        <img id="qrImage" class="qr hidden" alt="QR Code Pix" />
        <pre id="pixCode">O codigo Pix vai aparecer aqui.</pre>
        <button id="copyBtn" class="secondary" type="button">Copiar codigo Pix</button>
        <div id="approvedBox" class="hidden">
          <div class="steps">
            <div class="step">
              <strong>${escapeHtml(webCheckoutConfig.approvedTitle)}</strong>
              ${escapeHtml(webCheckoutConfig.approvedDescription).replace("o bot no Telegram", botUsernameText)}
            </div>
            <div class="step">
              <strong>${escapeHtml(webCheckoutConfig.deliveryTitle)}</strong>
              ${escapeHtml(webCheckoutConfig.deliveryDescription)}
            </div>
          </div>
          <a id="telegramAction" class="action hidden" target="_blank" rel="noopener noreferrer">${escapeHtml(webCheckoutConfig.telegramButtonLabel)}</a>
          <pre id="telegramCommand" class="hidden"></pre>
        </div>
        <div class="footer-note">
          Este pagamento fica ativo por alguns minutos. Se expirar, gere um novo Pix.
        </div>
      </div>
    </div>
    <div class="social-proof">
      <div class="social-proof-header">
        <div>
          <h3>Alguns Comentários 🤭</h3>
          <p class="muted">Olha o que meus assinantes dizem sobre meu mundinho!</p>
        </div>
      </div>
      <div class="testimonial-slider">
        <div id="testimonialTrack" class="testimonial-track"></div>
      </div>
      <div class="testimonial-controls">
        <div class="testimonial-nav">
          <button id="testimonialPrev" class="testimonial-btn" type="button" aria-label="Comentario anterior">‹</button>
          <button id="testimonialNext" class="testimonial-btn" type="button" aria-label="Proximo comentario">›</button>
        </div>
        <div id="testimonialDots" class="testimonial-dots"></div>
      </div>
    </div>
    <div id="approvalPopup" class="popup-backdrop hidden" hidden aria-hidden="true">
      <div class="popup-card">
        <h3>Pagamento aprovado</h3>
        <p>Seu link privado de uso unico foi liberado. Toque no botao abaixo para entrar agora no grupo privado.</p>
        <div class="popup-actions">
          <a id="approvalPopupLink" class="popup-link" target="_blank" rel="noopener noreferrer">Entrar com link privado</a>
          <button id="approvalPopupClose" class="popup-close" type="button">Fechar</button>
        </div>
      </div>
    </div>
  </div>
  <script>
    const offers = ${offersJson};
    const testimonialItems = [
      {
        name: "Lucas, 24",
        badge: "Assinante VIP",
        text: "Achei que seria so mais um canal, mas a energia aqui e muito acima. Cada previa provoca, prende a atencao e deixa aquela vontade absurda de ver a proxima postagem."
      },
      {
        name: "Rafael, 31",
        badge: "Assinante VIP",
        text: "O clima e pesado no melhor sentido. Tem provocacao, ousadia e uma tensao constante que faz o canal parecer muito mais viciante do que qualquer conteudo comum."
      },
      {
        name: "Mateus, 27",
        badge: "Assinante VIP",
        text: "Foi o tipo de conteudo que me pegou de surpresa. Nao economiza no impacto, tem atitude e entrega exatamente aquela sensacao de acesso proibido que chama atencao de verdade."
      }
    ];
    let selectedOfferId = offers[0] ? offers[0].id : null;
    const offersEl = document.getElementById("offers");
    const statusCard = document.getElementById("statusCard");
    const statusText = document.getElementById("statusText");
    const qrImage = document.getElementById("qrImage");
    const pixCode = document.getElementById("pixCode");
    const telegramAction = document.getElementById("telegramAction");
    const telegramCommand = document.getElementById("telegramCommand");
    const approvedBox = document.getElementById("approvedBox");
    const formError = document.getElementById("formError");
    const statusBadge = document.getElementById("statusBadge");
    const formCard = document.getElementById("formCard");
    const createBtn = document.getElementById("createBtn");
    const payerNameInput = document.getElementById("payerName");
    const payerDocumentInput = document.getElementById("payerDocument");
    const heroBanner = document.getElementById("heroBanner");
    const heroEye = document.getElementById("heroEye");
    const heroEyeLabel = document.getElementById("heroEyeLabel");
    const testimonialTrack = document.getElementById("testimonialTrack");
    const testimonialDots = document.getElementById("testimonialDots");
    const testimonialPrev = document.getElementById("testimonialPrev");
    const testimonialNext = document.getElementById("testimonialNext");
    const approvalPopup = document.getElementById("approvalPopup");
    const approvalPopupLink = document.getElementById("approvalPopupLink");
    const approvalPopupClose = document.getElementById("approvalPopupClose");
    let testimonialIndex = 0;
    let testimonialTimer = null;
    let copyFeedbackTimer = null;
    let approvalPopupShownFor = null;
    let currentCheckoutId = null;
    let checkoutPollTimer = null;
    let checkoutRequestNonce = 0;

    function setStage(stage) {
      if (stage >= 2) {
        statusCard.classList.remove("hidden");
        statusCard.classList.add("is-visible");
        formCard.classList.add("is-complete");
      } else {
        statusCard.classList.add("hidden");
        statusCard.classList.remove("is-visible");
        formCard.classList.remove("is-complete");
      }
    }

    function scrollToStatusCard() {
      requestAnimationFrame(() => {
        statusCard.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    function showApprovalPopup(url, label, checkoutId) {
      if (!url) return;
      if (approvalPopupShownFor === checkoutId) return;
      approvalPopupShownFor = checkoutId;
      approvalPopupLink.href = url;
      approvalPopupLink.textContent = label || "Entrar com link privado";
      approvalPopup.hidden = false;
      approvalPopup.setAttribute("aria-hidden", "false");
      approvalPopup.classList.remove("hidden");
    }

    function hideApprovalPopup() {
      approvalPopup.hidden = true;
      approvalPopup.setAttribute("aria-hidden", "true");
      approvalPopup.classList.add("hidden");
    }

    function resetApprovalUi() {
      hideApprovalPopup();
      approvalPopupShownFor = null;
      approvedBox.classList.add("hidden");
      telegramAction.classList.add("hidden");
      telegramAction.removeAttribute("href");
      telegramAction.textContent = "${escapeHtml(webCheckoutConfig.telegramButtonLabel)}";
      telegramCommand.classList.add("hidden");
      telegramCommand.textContent = "";
    }

    function stopCheckoutPolling() {
      if (checkoutPollTimer) {
        clearTimeout(checkoutPollTimer);
        checkoutPollTimer = null;
      }
    }

    function setCheckoutUrl(checkoutId) {
      const url = checkoutId ? "/checkout?id=" + encodeURIComponent(checkoutId) : "/checkout";
      history.replaceState({}, "", url);
    }

    function getOfferPrice(amount) {
      const n = Number(amount || 0);
      return "R$ " + n.toFixed(2).replace(".", ",");
    }

    function normalizeDigits(value) {
      return String(value || "").replace(/\\D/g, "");
    }

    function isFormReady() {
      const payerName = payerNameInput.value.trim();
      const payerDocument = normalizeDigits(payerDocumentInput.value);
      return Boolean(payerName) && payerDocument.length === 11;
    }

    function renderOffers() {
      offersEl.innerHTML = "";
      offers.forEach((offer) => {
        const el = document.createElement("div");
        el.className = "offer" + (offer.id === selectedOfferId ? " active" : "");
        el.innerHTML =
          "<div class='offer-title'><span>" + offer.label + "</span><span class='offer-price'>" + getOfferPrice(offer.amount) + "</span></div>" +
          "<div class='offer-desc'>" + offer.description + "</div>";
        el.onclick = () => { selectedOfferId = offer.id; renderOffers(); };
        offersEl.appendChild(el);
      });
    }

    function updateTestimonialSlider(index) {
      if (!testimonialItems.length) return;
      testimonialIndex = (index + testimonialItems.length) % testimonialItems.length;
      testimonialTrack.style.transform = "translateX(-" + (testimonialIndex * 100) + "%)";
      Array.from(testimonialDots.children).forEach((dot, dotIndex) => {
        dot.className = "testimonial-dot" + (dotIndex === testimonialIndex ? " active" : "");
      });
    }

    function restartTestimonialTimer() {
      if (testimonialTimer) clearInterval(testimonialTimer);
      testimonialTimer = setInterval(() => {
        updateTestimonialSlider(testimonialIndex + 1);
      }, 4500);
    }

    function renderTestimonials() {
      testimonialTrack.innerHTML = "";
      testimonialDots.innerHTML = "";
      testimonialItems.forEach((item, index) => {
        const slide = document.createElement("div");
        slide.className = "testimonial-slide";
        slide.innerHTML =
          "<div class='testimonial-top'>" +
            "<div class='testimonial-name'>" + item.name + "</div>" +
            "<span class='testimonial-badge'>" + item.badge + "</span>" +
          "</div>" +
          "<p class='testimonial-text'>" + item.text + "</p>";
        testimonialTrack.appendChild(slide);

        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "testimonial-dot" + (index === 0 ? " active" : "");
        dot.setAttribute("aria-label", "Ir para comentario " + (index + 1));
        dot.onclick = () => {
          updateTestimonialSlider(index);
          restartTestimonialTimer();
        };
        testimonialDots.appendChild(dot);
      });
      updateTestimonialSlider(0);
      restartTestimonialTimer();
    }

    async function loadCheckout(checkoutId) {
      currentCheckoutId = checkoutId;
      stopCheckoutPolling();
      const requestNonce = ++checkoutRequestNonce;
      const res = await fetch("/api/web-checkout/" + encodeURIComponent(checkoutId));
      const data = await res.json();
      if (requestNonce !== checkoutRequestNonce || currentCheckoutId !== checkoutId) return;
      if (!res.ok || !data.ok) {
        resetApprovalUi();
        setStage(2);
        statusText.textContent = data.error || "Nao consegui carregar o checkout.";
        return;
      }
      setStage(2);
      scrollToStatusCard();
      statusText.textContent = data.statusLabel;
      statusBadge.textContent = data.status;
      statusBadge.className = "status-badge " + data.status;
      pixCode.textContent = data.qrCode || "Codigo indisponivel.";
      if (data.qrCodeBase64) {
        qrImage.src = "data:image/png;base64," + data.qrCodeBase64;
        qrImage.classList.remove("hidden");
      } else {
        qrImage.removeAttribute("src");
        qrImage.classList.add("hidden");
      }
      if (data.status === "approved" || data.status === "claimed") {
        approvedBox.classList.remove("hidden");
        if (data.privateInviteUrl) {
          telegramAction.href = data.privateInviteUrl;
          telegramAction.textContent = data.accessLabel || "Entrar com link privado";
          telegramAction.classList.remove("hidden");
          telegramCommand.classList.add("hidden");
        } else {
          telegramAction.classList.add("hidden");
          telegramCommand.classList.add("hidden");
          telegramCommand.textContent = "";
        }
      if (data.status === "approved" && data.gatewayStatus === "approved" && data.privateInviteUrl) {
          showApprovalPopup(
            data.privateInviteUrl,
            data.accessLabel || "Entrar com link privado",
            data.checkoutId
          );
        }
      } else {
        resetApprovalUi();
      }
      if (data.status === "expired" || data.status === "not_found") {
        currentCheckoutId = null;
        stopCheckoutPolling();
        setCheckoutUrl(null);
        approvalPopupShownFor = null;
      }
      if (data.status === "pending") {
        checkoutPollTimer = setTimeout(() => {
          loadCheckout(checkoutId);
        }, 5000);
      }
    }

    document.getElementById("copyBtn").onclick = async () => {
      const copyBtn = document.getElementById("copyBtn");
      try {
        await navigator.clipboard.writeText(pixCode.textContent);
        copyBtn.textContent = "Codigo Pix copiado";
        if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
        copyFeedbackTimer = setTimeout(() => {
          copyBtn.textContent = "Copiar codigo Pix";
        }, 2200);
      } catch {
        copyBtn.textContent = "Nao foi possivel copiar";
        if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
        copyFeedbackTimer = setTimeout(() => {
          copyBtn.textContent = "Copiar codigo Pix";
        }, 2200);
      }
    };

    heroEye.onclick = () => {
      const revealed = heroBanner.classList.toggle("revealed");
      heroEyeLabel.textContent = revealed ? "Imagem revelada" : "Toque para revelar";
    };

    approvalPopupClose.onclick = () => {
      hideApprovalPopup();
    };

    approvalPopup.onclick = (event) => {
      if (event.target === approvalPopup) hideApprovalPopup();
    };

    testimonialPrev.onclick = () => {
      updateTestimonialSlider(testimonialIndex - 1);
      restartTestimonialTimer();
    };

    testimonialNext.onclick = () => {
      updateTestimonialSlider(testimonialIndex + 1);
      restartTestimonialTimer();
    };

    createBtn.onclick = async () => {
      formError.textContent = "";
      if (!isFormReady()) {
        setStage(1);
        formError.textContent = "Preencha nome e CPF para continuar.";
        return;
      }

      setStage(2);
      stopCheckoutPolling();
      currentCheckoutId = null;
      setCheckoutUrl(null);
      resetApprovalUi();
      scrollToStatusCard();
      statusBadge.textContent = "aguardando";
      statusBadge.className = "status-badge";
      statusText.textContent = "Gerando seu Pix agora...";
      pixCode.textContent = "Aguarde enquanto o codigo Pix e preparado.";
      qrImage.classList.add("hidden");
      qrImage.removeAttribute("src");
      createBtn.disabled = true;
      createBtn.textContent = "Gerando pagamento...";
      const payerName = payerNameInput.value.trim();
      const payerDocument = payerDocumentInput.value.trim();
      const res = await fetch("/api/web-checkout/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerId: selectedOfferId, payerName, payerDocument })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setStage(1);
        formError.textContent = data.error || "Nao consegui gerar o Pix.";
        createBtn.disabled = false;
        createBtn.textContent = "Continuar para pagamento";
        return;
      }
      currentCheckoutId = data.checkoutId;
      setCheckoutUrl(data.checkoutId);
      await loadCheckout(data.checkoutId);
      createBtn.disabled = false;
      createBtn.textContent = "Atualizar pagamento";
    };

    renderOffers();
    renderTestimonials();
    hideApprovalPopup();
    const existingId = new URLSearchParams(location.search).get("id");
    setStage(existingId ? 2 : 1);
    if (existingId) {
      currentCheckoutId = existingId;
      loadCheckout(existingId);
    } else {
      resetApprovalUi();
    }
  </script>
</body>
</html>`;
  }

  function buildDailyAnalyticsText(stats) {
    return [
      "<b>Relatorio do dia</b>",
      "",
      `Data: <code>${stats.dateKey}</code>`,
      `Novos usuarios: <b>${stats.newUsersToday}</b>`,
      `Usuarios que deram /start hoje: <b>${stats.startsToday}</b>`,
      `Pagamentos aprovados hoje: <b>${stats.paidToday}</b>`,
      `Convites enviados hoje: <b>${stats.invitesToday}</b>`,
      `Pix pendentes agora: <b>${stats.pendingNow}</b>`,
      `Base total de usuarios: <b>${stats.totalUsers}</b>`
    ].join("\n");
  }

  async function sendDailyAnalyticsIfNeeded() {
    if (!ANALYTICS_TELEGRAM_ID || !bot?.sendMessage) return;
    const now = new Date();
    if (now.getHours() !== analyticsHour || now.getMinutes() !== analyticsMinute) return;
    const dateKey = getLocalDateKey(now);
    const alreadySent = await storage.hasAnalyticsReportBeenSent(dateKey);
    if (alreadySent) return;

    const stats = await storage.getDailyAnalytics(dateKey);
    await bot.sendMessage(ANALYTICS_TELEGRAM_ID, buildDailyAnalyticsText(stats), { parse_mode: "HTML" });
    await storage.markAnalyticsReportSent(dateKey, ANALYTICS_TELEGRAM_ID);
  }

  async function getAnalyticsReportText() {
    const dateKey = getLocalDateKey(new Date());
    const stats = await storage.getDailyAnalytics(dateKey);
    return buildDailyAnalyticsText(stats);
  }

  async function processPendingPixExpiryTick() {
    if (!botEnabled || !bot?.sendMessage) return;
    const maxAgeMs = 10 * 60 * 1000;
    const users = await storage.listUsersWithExpiredPendingPayments({
      maxAgeMs,
      limit: 50,
      includeAlreadyNotified: true
    });
    if (!users.length) return;

    for (const user of users) {
      const telegramUserId = Number(user?.telegramUserId);
      if (!Number.isFinite(telegramUserId)) continue;
      const alreadyNotified = Boolean(user?.pendingPaymentExpiredNotifiedAt);

      try {
        if (!alreadyNotified) {
          await bot.sendMessage(telegramUserId, config.telegram.texts.pixExpiredMessage(), {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: buildVipOfferKeyboardRows()
            }
          });
        }
      } catch (err) {
        const msg = err?.message || String(err);
        console.error("[pix-expiry] send error:", telegramUserId, msg);
      } finally {
        if (!alreadyNotified) {
          await storage.upsertUser(telegramUserId, { pendingPaymentExpiredNotifiedAt: new Date().toISOString() });
        }
        await storage.clearPendingPayment(telegramUserId, {
          deletePayment: true,
          clearOffer: true
        });
      }
    }
  }

  async function processStartRemindersTick() {
    if (!botEnabled || !bot?.sendMessage) return;
    const reminders = Array.isArray(config.telegram?.texts?.startReminderMessages)
      ? config.telegram.texts.startReminderMessages
      : [];
    if (reminders.length === 0) return;

    const scheduleMs = [60_000, 180_000, 300_000];
    const users = await storage.listUsersPendingStartReminders(50);
    for (const user of users) {
      const telegramUserId = Number(user?.telegramUserId);
      if (!Number.isFinite(telegramUserId)) continue;
      const stage = Number(user?.startReminderStage ?? 0);
      const baseAtMs = Date.parse(user?.startReminderBaseAt || "") || 0;
      if (!baseAtMs) {
        await storage.upsertUser(telegramUserId, { startReminderStage: null, startReminderBaseAt: null, startReminderNextAt: null });
        continue;
      }
      const msg = reminders[stage];
      if (!msg) {
        await storage.upsertUser(telegramUserId, { startReminderStage: null, startReminderBaseAt: null, startReminderNextAt: null });
        continue;
      }
      try {
        await bot.sendMessage(telegramUserId, msg, { parse_mode: "HTML" });
      } catch (err) {
        const e = err?.message || String(err);
        const wasBlocked =
          err?.status === 403 ||
          /bot was blocked by the user/i.test(e) ||
          /forbidden/i.test(e);
        if (wasBlocked) {
          await storage.markUserBlocked(telegramUserId, "start_reminder");
          console.log("[start-reminders] user blocked bot:", telegramUserId);
          continue;
        }
        console.error("[start-reminders] send error:", telegramUserId, e);
      }

      const nextStage = stage + 1;
      if (nextStage >= reminders.length || !scheduleMs[nextStage]) {
        await storage.upsertUser(telegramUserId, { startReminderStage: null, startReminderBaseAt: null, startReminderNextAt: null });
      } else {
        await storage.upsertUser(telegramUserId, {
          startReminderStage: nextStage,
          startReminderNextAt: new Date(baseAtMs + scheduleMs[nextStage]).toISOString()
        });
      }
    }
  }

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

  async function createOrReusePayment({ telegramUserId, telegramUsername, offer }) {
    const forceNew = false;
    const user = await storage.getUser(telegramUserId);
    return createOrReusePaymentInternal({
      telegramUserId,
      telegramUsername,
      payerName: user?.payerName || user?.firstName || telegramUsername || null,
      payerDocument: user?.payerDocument || user?.cpf || null,
      offer,
      forceNew
    });
  }

  async function createOrReusePaymentInternal({
    telegramUserId,
    telegramUsername,
    payerName,
    payerDocument,
    offer,
    forceNew
  }) {
    const existing = await storage.getPendingPayment(telegramUserId);
    if (existing && !forceNew) {
      const createdAtMs = Date.parse(existing.createdAt || "") || 0;
      const ageMs = Date.now() - createdAtMs;
      const isFresh = ageMs >= 0 && ageMs <= 10 * 60 * 1000;
      const sameOffer = String(existing.offerId || "") === String(offer?.id || "");
      if (isFresh && sameOffer && existing.status && existing.status !== "approved") return existing;
    }

    if (!payerDocument) {
      throw new Error("CPF do pagador ausente. Envie seu CPF (apenas números) para gerar o Pix.");
    }

    const payment = await createPixPayment({
      clientId: MISTICPAY_CLIENT_ID,
      clientSecret: MISTICPAY_CLIENT_SECRET,
      amount: offer?.amount || VIP_PRICE,
      description: offer?.description || "Acesso ao Grupo VIP Telegram",
      telegramUserId,
      telegramUsername,
      payerName,
      payerDocument,
      webhookUrl: WEBHOOK_URL
    });

    await storage.setPendingPayment(telegramUserId, {
      paymentId: payment.paymentId,
      status: payment.status,
      createdAt: payment.createdAt,
      amount: offer?.amount || VIP_PRICE,
      offerId: offer?.id || null,
      description: offer?.description || "Acesso ao Grupo VIP Telegram",
      qrCode: payment.qrCode,
      qrCodeBase64: payment.qrCodeBase64,
      ticketUrl: payment.ticketUrl
    });

    return payment;
  }

  async function createPaymentForceNew({ telegramUserId, telegramUsername, offer }) {
    const user = await storage.getUser(telegramUserId);
    return createOrReusePaymentInternal({
      telegramUserId,
      telegramUsername,
      payerName: user?.payerName || user?.firstName || telegramUsername || null,
      payerDocument: user?.payerDocument || user?.cpf || null,
      offer,
      forceNew: true
    });
  }

  async function checkPaymentStatus({ telegramUserId }) {
    const user = await storage.getUser(telegramUserId);
    const paymentId = user?.pendingPaymentId ? String(user.pendingPaymentId) : null;
    if (!paymentId) return null;
    const payment = await getPaymentById({
      clientId: MISTICPAY_CLIENT_ID,
      clientSecret: MISTICPAY_CLIENT_SECRET,
      paymentId
    });
    return { paymentId, status: payment?.status || null, payment };
  }

  async function processApprovedPayment({ paymentId, payment, storedPayment }) {
    const paymentRecord = storedPayment || await storage.getPayment(paymentId);
    if (!paymentRecord?.paymentId) return;
    const { alreadyProcessed } = await storage.markPaymentApproved(paymentId, "misticpay", payment?.raw || payment);
    if (alreadyProcessed) return;

    if (paymentRecord?.checkoutId) {
      let inviteLink = null;
      if (botEnabled) {
        try {
          inviteLink = await bot.createVipInviteLink();
        } catch (error) {
          console.error("[web-checkout] invite link error:", error?.message || error);
        }
      }
      await storage.markWebCheckoutApproved(paymentRecord.checkoutId, {
        status: "approved",
        paymentId: String(paymentId),
        inviteLink: inviteLink || null
      });
      await storage.logPaymentApproved({
        paymentId: String(paymentId),
        checkoutId: String(paymentRecord.checkoutId),
        amount: payment?.value ?? paymentRecord?.amount ?? null,
        provider: "misticpay_web"
      });
      return;
    }

    const telegramUserId = paymentRecord?.telegramUserId ? Number(paymentRecord.telegramUserId) : NaN;
    if (!Number.isFinite(telegramUserId)) return;

    await storage.markUserPaid(telegramUserId, paymentId);
    await storage.clearPendingPayment(telegramUserId);

    const inviteLink = await bot.createVipInviteLink();
    await bot.sendVipInvite({ telegramUserId, inviteLink });
    await storage.markInviteSent(telegramUserId, inviteLink);

    await storage.logPaymentApproved({
      paymentId: String(paymentId),
      telegramUserId: String(telegramUserId),
      amount: payment?.value ?? paymentRecord?.amount ?? null,
      provider: "misticpay"
    });
  }

  async function redeemWebCheckoutClaim({
    claimToken,
    telegramUserId,
    telegramUsername,
    firstName,
    lastName
  }) {
    const checkout = await storage.getWebCheckoutByClaimToken(claimToken);
    if (!checkout) return { status: "invalid" };

    const status = getWebCheckoutStatusView(checkout);
    if (status === "pending") return { status: "pending" };
    if (status === "expired") return { status: "expired" };

    const alreadyClaimedBySameUser = checkout.claimedAt && String(checkout.claimTelegramUserId || "") === String(telegramUserId);
    if (checkout.claimedAt && !alreadyClaimedBySameUser) {
      return { status: "claimed_by_other" };
    }

    await storage.upsertUser(telegramUserId, {
      telegramUsername: telegramUsername || null,
      firstName: firstName || null,
      lastName: lastName || null,
      payerName: checkout.payerName || firstName || telegramUsername || null,
      payerDocument: checkout.payerDocument || null,
      cpf: checkout.payerDocument || null,
      botBlockedAt: null,
      botBlockedContext: null
    });

    await storage.upsertPayment(checkout.paymentId, {
      telegramUserId: String(telegramUserId),
      webClaimedAt: new Date().toISOString()
    });

    await storage.markUserPaid(telegramUserId, checkout.paymentId);
    await storage.markWebCheckoutClaimed(checkout.checkoutId, {
      claimTelegramUserId: String(telegramUserId),
      claimTelegramUsername: telegramUsername || null
    });

    const user = await storage.getUser(telegramUserId);
    if (!user?.inviteSent) {
      await onApprovedUser({ telegramUserId });
    }

    return { status: "ok", checkout };
  }

  const botEnabled = Boolean(TELEGRAM_TOKEN && GROUP_CHAT_ID);

  let bot = {
    pollLoop: async () => {},
    createVipInviteLink: async () => null,
    sendVipInvite: async () => {},
    removeUserFromGroup: async () => {}
  };

  if (botEnabled) {
    if (!String(GROUP_CHAT_ID).startsWith("-")) {
      console.log(
        `[server] Aviso: GROUP_CHAT_ID parece incorreto (${GROUP_CHAT_ID}). Para supergrupos, normalmente é algo como -100xxxxxxxxxx.`
      );
    }

    bot = createTelegramBot({
      token: TELEGRAM_TOKEN,
      groupChatId: GROUP_CHAT_ID,
      vipPrice: VIP_PRICE,
      adminTelegramId: ADMIN_TELEGRAM_ID,
      storage,
      createOrReusePayment,
      createPaymentForceNew,
      checkPaymentStatus,
      getAnalyticsReportText,
      onApprovedUser,
      redeemWebCheckoutClaim
    });
  } else if (!WEBHOOK_ONLY) {
    console.log(
      "[server] TELEGRAM_TOKEN/GROUP_CHAT_ID ausentes: bot não inicia. Preencha no .env para gerar Pix pelo Telegram."
    );
  }

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/health", (req, res) => res.json({ ok: true }));
  app.get("/checkout/banner", (req, res) => {
    res.sendFile(config.telegram.media.startPhotoPath);
  });
  app.get("/checkout", (req, res) => {
    res.type("html").send(renderWebCheckoutPage());
  });
  app.post("/api/web-checkout/create", async (req, res) => {
    try {
      if (!botEnabled) {
        return res.status(400).json({ ok: false, error: "Checkout web exige o bot do Telegram configurado." });
      }

      const offer = getOfferById(req.body?.offerId) || vipOffers[0] || null;
      const payerName = String(req.body?.payerName || "").trim();
      const payerDocument = normalizeCpfDigits(req.body?.payerDocument);

      if (!payerName) {
        return res.status(400).json({ ok: false, error: "Informe seu nome." });
      }
      if (!payerDocument || !isValidCpf(payerDocument)) {
        return res.status(400).json({ ok: false, error: "Informe um CPF valido." });
      }

      const checkout = await createWebCheckout({ payerName, payerDocument, offer });
      if (checkout.payment?.status === "approved") {
        const storedPayment = await storage.getPayment(checkout.payment.paymentId);
        await processApprovedPayment({
          paymentId: checkout.payment.paymentId,
          payment: checkout.payment,
          storedPayment
        });
      }
      return res.json({
        ok: true,
        checkoutId: checkout.checkoutId,
        paymentId: checkout.payment.paymentId
      });
    } catch (err) {
      const msg = err?.message || String(err);
      return res.status(500).json({ ok: false, error: msg });
    }
  });
  app.get("/api/web-checkout/:checkoutId", async (req, res) => {
    const checkout = await storage.getWebCheckout(req.params.checkoutId);
    if (!checkout) {
      return res.status(404).json({ ok: false, error: "Checkout nao encontrado." });
    }

    let storedPayment = await storage.getPayment(checkout.paymentId);
    const gatewayPayment = await getGatewayPaymentSnapshot(checkout.paymentId);
    const gatewayStatus = gatewayPayment?.status || null;

    if (gatewayStatus && gatewayStatus !== storedPayment?.status) {
      storedPayment = await storage.upsertPayment(checkout.paymentId, {
        status: gatewayStatus,
        providerPayment: gatewayPayment?.raw || storedPayment?.providerPayment || null,
        lastGatewayStatusAt: new Date().toISOString()
      });
    }

    if (gatewayStatus === "approved") {
      await processApprovedPayment({
        paymentId: checkout.paymentId,
        payment: gatewayPayment,
        storedPayment
      });
      storedPayment = await storage.getPayment(checkout.paymentId);
    }

    const paymentForStatus = gatewayStatus
      ? {
          ...storedPayment,
          status: gatewayStatus,
          approvedAt: gatewayStatus === "approved" ? (storedPayment?.approvedAt || new Date().toISOString()) : null
        }
      : storedPayment;
    const { checkout: syncedCheckout, payment, status } = await syncWebCheckoutState(checkout, paymentForStatus);
    const safeCheckout = syncedCheckout || checkout;
    const exposePaymentPayload = status === "pending";
    const telegramClaimUrl = status === "approved" ? buildTelegramClaimUrl(checkout.claimToken) : null;
    const telegramCommand = status === "approved" ? `/start claim_${checkout.claimToken}` : null;
    const privateInviteUrl = status === "approved" ? (safeCheckout.inviteLink || null) : null;
    const accessLabel = "Entrar com link privado";
    const statusLabelMap = {
      pending: "Pix aguardando pagamento para liberar o canal privado da Julia Hoffmann.",
      approved: safeCheckout.inviteLink
        ? "Pagamento aprovado. Seu link privado de uso unico para entrar no grupo ja esta liberado."
        : "Pagamento aprovado, mas o link privado ainda esta sendo preparado.",
      claimed: safeCheckout.inviteLink
        ? "O link privado dessa compra ja foi emitido para acesso ao grupo."
        : "Acesso ao canal privado da Julia Hoffmann ja resgatado no Telegram.",
      expired: "Esse Pix expirou. Gere um novo checkout para acessar o canal privado da Julia Hoffmann.",
      not_found: "Checkout nao encontrado."
    };

    return res.json({
      ok: true,
      checkoutId: safeCheckout.checkoutId,
      status,
      statusLabel: statusLabelMap[status] || "Aguardando atualizacao.",
      amountBrl: formatBrl(safeCheckout.amount),
      qrCode: exposePaymentPayload ? payment?.qrCode || "" : "",
      qrCodeBase64: exposePaymentPayload ? payment?.qrCodeBase64 || "" : "",
      gatewayStatus,
      privateInviteUrl,
      accessLabel,
      telegramClaimUrl,
      telegramCommand
    });
  });
  app.use(
    createWebhookRouter({
      misticPayClientId: MISTICPAY_CLIENT_ID,
      misticPayClientSecret: MISTICPAY_CLIENT_SECRET,
      storage,
      onPaymentApproved: processApprovedPayment
    })
  );

  app.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}`);
    if (storageFilePath) {
      console.log(`[storage] ${storageFilePath}`);
    }
    if (!WEBHOOK_URL) {
      console.log(
        "[server] WEBHOOK_URL ausente ou inválido. Sem webhook público, a confirmação automática depende do verificador interno."
      );
    }
    if (WEBHOOK_ONLY) {
      console.log("[server] WEBHOOK_ONLY ativo: bot não inicia polling (/start não vai funcionar), apenas webhook/health.");
    }
  });

  if (!WEBHOOK_ONLY) {
    bot.pollLoop();

    let checking = false;
    setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const pending = await storage.listPendingPayments(10);
        for (const p of pending) {
          const paymentId = p?.paymentId ? String(p.paymentId) : null;
          if (!paymentId) continue;

          try {
            const payment = await getPaymentById({
              clientId: MISTICPAY_CLIENT_ID,
              clientSecret: MISTICPAY_CLIENT_SECRET,
              paymentId
            });

            const status = payment?.status || null;
            await storage.upsertPayment(paymentId, {
              status,
              lastCheckedAt: new Date().toISOString()
            });

            if (status === "approved") {
              await processApprovedPayment({ paymentId, payment, storedPayment: p });
            }
          } catch (err) {
            const msg = err?.message || String(err);
            const notFound =
              err?.status === 404 ||
              /n[aã]o foi encontrada/i.test(msg) ||
              /not found/i.test(msg) ||
              /transactionid/i.test(msg);

            if (notFound) {
              await storage.upsertPayment(paymentId, {
                status: "not_found",
                clearedAt: new Date().toISOString(),
                lastCheckedAt: new Date().toISOString()
              });
              if (p?.telegramUserId) {
                await storage.clearPendingPayment(p.telegramUserId, { clearOffer: true, clearExpiryFlags: true });
              }
              continue;
            }

            console.error("[payments] check error:", paymentId, msg);
          }
        }
      } catch (err) {
        const msg = err?.message || String(err);
        console.error("[payments] auto-check error:", msg);
      } finally {
        checking = false;
      }
    }, 20_000);

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

    setInterval(async () => {
      try {
        await sendDailyAnalyticsIfNeeded();
      } catch (err) {
        const msg = err?.message || String(err);
        console.error("[analytics] send error:", msg);
      }
    }, 60_000);

    setInterval(async () => {
      try {
        await processStartRemindersTick();
      } catch (err) {
        const msg = err?.message || String(err);
        console.error("[start-reminders] tick error:", msg);
      }
    }, 20_000);

    setInterval(async () => {
      try {
        await processPendingPixExpiryTick();
      } catch (err) {
        const msg = err?.message || String(err);
        console.error("[pix-expiry] tick error:", msg);
      }
    }, 20_000);
  }
}

main().catch((err) => {
  console.error("[fatal]", err?.message || err);
  process.exit(1);
});
