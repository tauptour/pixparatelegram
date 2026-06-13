const fs = require("node:fs/promises");
const path = require("node:path");

function createStorage(options = {}) {
  const filePath = options.filePath || path.join(__dirname, "data.json");
  const pendingPaymentMaxAgeMs = 10 * 60 * 1000;

  let state = {
    users: {},
    payments: {},
    paymentLogs: [],
    analyticsReports: {},
    webCheckouts: {}
  };

  let writeChain = Promise.resolve();
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      state = {
        users: parsed?.users && typeof parsed.users === "object" ? parsed.users : {},
        payments: parsed?.payments && typeof parsed.payments === "object" ? parsed.payments : {},
        paymentLogs: Array.isArray(parsed?.paymentLogs) ? parsed.paymentLogs : [],
        analyticsReports: parsed?.analyticsReports && typeof parsed.analyticsReports === "object" ? parsed.analyticsReports : {},
        webCheckouts: parsed?.webCheckouts && typeof parsed.webCheckouts === "object" ? parsed.webCheckouts : {}
      };
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      await persist();
    }
    loaded = true;
  }

  async function persist() {
    writeChain = writeChain.then(async () => {
      const json = JSON.stringify(state, null, 2);
      await fs.writeFile(filePath, json, "utf8");
    });
    return writeChain;
  }

  async function getUser(telegramUserId) {
    await ensureLoaded();
    return state.users[String(telegramUserId)] || null;
  }

  async function upsertUser(telegramUserId, partial) {
    await ensureLoaded();
    const key = String(telegramUserId);
    state.users[key] = {
      telegramUserId: key,
      paid: false,
      inviteSent: false,
      ...state.users[key],
      ...partial
    };
    await persist();
    return state.users[key];
  }

  async function markUserPaid(telegramUserId, paymentId) {
    await ensureLoaded();
    const user = await upsertUser(telegramUserId, {
      paid: true,
      paidAt: new Date().toISOString(),
      lastApprovedPaymentId: String(paymentId)
    });
    return user;
  }

  async function setPendingPayment(telegramUserId, payment) {
    await ensureLoaded();
    const key = String(telegramUserId);
    const previousPendingPaymentId = state.users[key]?.pendingPaymentId
      ? String(state.users[key].pendingPaymentId)
      : null;
    const nextPendingPaymentId = payment?.paymentId ? String(payment.paymentId) : null;

    if (previousPendingPaymentId && nextPendingPaymentId && previousPendingPaymentId !== nextPendingPaymentId) {
      if (state.payments[previousPendingPaymentId]) {
        state.payments[previousPendingPaymentId].clearedAt = new Date().toISOString();
      }
    }

    const user = await upsertUser(telegramUserId, {
      pendingPaymentId: String(payment.paymentId),
      pendingPaymentCreatedAt: payment.createdAt
    });
    state.payments[String(payment.paymentId)] = {
      ...payment,
      telegramUserId: String(telegramUserId)
    };
    await persist();
    return user;
  }

  async function getPendingPayment(telegramUserId) {
    await ensureLoaded();
    const user = await getUser(telegramUserId);
    if (!user?.pendingPaymentId) return null;
    return state.payments[String(user.pendingPaymentId)] || null;
  }

  async function clearPendingPayment(telegramUserId, options = {}) {
    await ensureLoaded();
    const user = await getUser(telegramUserId);
    if (!user?.pendingPaymentId) return;
    const paymentId = String(user.pendingPaymentId);
    await upsertUser(telegramUserId, {
      pendingPaymentId: null,
      pendingPaymentCreatedAt: null,
      pendingPaymentExpiredNotifiedAt: options.clearExpiryFlags ? null : user.pendingPaymentExpiredNotifiedAt,
      pendingVipOfferId: options.clearOffer ? null : user.pendingVipOfferId
    });
    if (state.payments[paymentId]) {
      if (options.deletePayment) {
        delete state.payments[paymentId];
      } else {
        state.payments[paymentId].clearedAt = new Date().toISOString();
      }
    }
    await persist();
  }

  async function getPayment(paymentId) {
    await ensureLoaded();
    return state.payments[String(paymentId)] || null;
  }

  async function upsertPayment(paymentId, partial) {
    await ensureLoaded();
    const key = String(paymentId);
    state.payments[key] = {
      ...state.payments[key],
      paymentId: key,
      ...partial
    };
    await persist();
    return state.payments[key];
  }

  async function getWebCheckout(checkoutId) {
    await ensureLoaded();
    return state.webCheckouts[String(checkoutId)] || null;
  }

  async function upsertWebCheckout(checkoutId, partial) {
    await ensureLoaded();
    const key = String(checkoutId);
    state.webCheckouts[key] = {
      checkoutId: key,
      ...state.webCheckouts[key],
      ...partial
    };
    await persist();
    return state.webCheckouts[key];
  }

  async function getWebCheckoutByClaimToken(claimToken) {
    await ensureLoaded();
    const token = String(claimToken || "").trim();
    if (!token) return null;
    for (const checkout of Object.values(state.webCheckouts || {})) {
      if (!checkout) continue;
      if (String(checkout.claimToken || "") !== token) continue;
      return checkout;
    }
    return null;
  }

  async function markWebCheckoutApproved(checkoutId, partial = {}) {
    await ensureLoaded();
    return upsertWebCheckout(checkoutId, {
      status: "approved",
      approvedAt: new Date().toISOString(),
      ...partial
    });
  }

  async function markWebCheckoutExpired(checkoutId, partial = {}) {
    await ensureLoaded();
    return upsertWebCheckout(checkoutId, {
      status: "expired",
      expiredAt: new Date().toISOString(),
      ...partial
    });
  }

  async function markWebCheckoutClaimed(checkoutId, partial = {}) {
    await ensureLoaded();
    return upsertWebCheckout(checkoutId, {
      claimedAt: new Date().toISOString(),
      ...partial
    });
  }

  async function listPendingPayments(limit = 50) {
    await ensureLoaded();
    const out = [];
    const nowMs = Date.now();
    for (const payment of Object.values(state.payments || {})) {
      if (!payment) continue;
      if (!payment.paymentId) continue;
      if (payment.approvedAt) continue;
      if (payment.clearedAt) continue;
      if (payment.status === "approved") continue;
      const createdAtMs = Date.parse(payment.createdAt || "") || 0;
      if (!createdAtMs) continue;
      const ageMs = nowMs - createdAtMs;
      if (ageMs >= pendingPaymentMaxAgeMs) continue;
      out.push(payment);
      if (out.length >= limit) break;
    }
    return out;
  }

  async function markPaymentApproved(paymentId, provider, providerPayment) {
    await ensureLoaded();
    const key = String(paymentId);
    const existing = state.payments[key] || null;
    if (existing?.approvedAt) return { alreadyProcessed: true, payment: existing };

    state.payments[key] = {
      ...existing,
      paymentId: key,
      status: "approved",
      approvedAt: new Date().toISOString(),
      provider: provider || existing?.provider || null,
      providerPayment: providerPayment || existing?.providerPayment || null,
      mercadoPago: provider === "mercadopago" ? (providerPayment || existing?.mercadoPago || null) : existing?.mercadoPago || null,
      misticPay: provider === "misticpay" ? (providerPayment || existing?.misticPay || null) : existing?.misticPay || null
    };

    await persist();
    return { alreadyProcessed: false, payment: state.payments[key] };
  }

  async function logPaymentApproved(entry) {
    await ensureLoaded();
    state.paymentLogs.push({
      at: new Date().toISOString(),
      ...entry
    });
    await persist();
  }

  async function markInviteSent(telegramUserId, inviteLink) {
    await ensureLoaded();
    await upsertUser(telegramUserId, {
      inviteSent: true,
      inviteSentAt: new Date().toISOString(),
      lastInviteLink: inviteLink
    });
  }

  async function markUserBlocked(telegramUserId, context = null) {
    await ensureLoaded();
    return upsertUser(telegramUserId, {
      botBlockedAt: new Date().toISOString(),
      botBlockedContext: context ? String(context) : null,
      startReminderStage: null,
      startReminderBaseAt: null,
      startReminderNextAt: null
    });
  }

  async function listUsersNeedingInvite(limit = 100) {
    await ensureLoaded();
    const out = [];
    for (const user of Object.values(state.users || {})) {
      if (!user) continue;
      if (!user.paid) continue;
      if (user.inviteSent) continue;
      out.push(user);
      if (out.length >= limit) break;
    }
    return out;
  }

  async function listUsersPendingStartReminders(limit = 100) {
    await ensureLoaded();
    const nowMs = Date.now();
    const out = [];
    for (const user of Object.values(state.users || {})) {
      if (!user) continue;
      if (!user.telegramUserId) continue;
      if (user.paid) continue;
      if (user.botBlockedAt) continue;
      if (user.pendingPaymentId) {
        const createdAtMs = Date.parse(user.pendingPaymentCreatedAt || "") || 0;
        const isFresh = createdAtMs ? nowMs - createdAtMs < pendingPaymentMaxAgeMs : false;
        if (isFresh) continue;
      }
      const nextAtMs = Date.parse(user.startReminderNextAt || "") || 0;
      if (!nextAtMs) continue;
      if (nextAtMs > nowMs) continue;
      out.push(user);
      if (out.length >= limit) break;
    }
    return out;
  }

  async function listUsersWithExpiredPendingPayments({ maxAgeMs, limit = 100, includeAlreadyNotified = false }) {
    await ensureLoaded();
    const nowMs = Date.now();
    const out = [];
    for (const user of Object.values(state.users || {})) {
      if (!user) continue;
      if (!user.telegramUserId) continue;
      if (user.paid) continue;
      if (!user.pendingPaymentId) continue;
      const createdAtMs = Date.parse(user.pendingPaymentCreatedAt || "") || 0;
      const ageMs = createdAtMs ? nowMs - createdAtMs : maxAgeMs;
      if (!(ageMs >= maxAgeMs)) continue;
      if (!includeAlreadyNotified && user.pendingPaymentExpiredNotifiedAt) continue;
      out.push(user);
      if (out.length >= limit) break;
    }
    return out;
  }

  function isSameDay(isoString, dateKey) {
    if (!isoString || !dateKey) return false;
    return String(isoString).slice(0, 10) === String(dateKey);
  }

  async function getDailyAnalytics(dateKey) {
    await ensureLoaded();
    const users = Object.values(state.users || {});
    const payments = Object.values(state.payments || {});
    const paymentLogs = Array.isArray(state.paymentLogs) ? state.paymentLogs : [];

    const startsToday = users.filter((user) => isSameDay(user?.lastStartAt, dateKey)).length;
    const newUsersToday = users.filter((user) => isSameDay(user?.startedAt, dateKey)).length;
    const paidToday = paymentLogs.filter((log) => isSameDay(log?.at, dateKey)).length;
    const invitesToday = users.filter((user) => isSameDay(user?.inviteSentAt, dateKey)).length;
    const pendingNow = payments.filter((payment) => {
      if (!payment?.paymentId) return false;
      if (payment.approvedAt) return false;
      if (payment.clearedAt) return false;
      if (payment.status === "approved") return false;
      return true;
    }).length;

    return {
      dateKey: String(dateKey),
      totalUsers: users.length,
      newUsersToday,
      startsToday,
      paidToday,
      invitesToday,
      pendingNow
    };
  }

  async function hasAnalyticsReportBeenSent(dateKey) {
    await ensureLoaded();
    return Boolean(state.analyticsReports?.[String(dateKey)]?.sentAt);
  }

  async function markAnalyticsReportSent(dateKey, destination) {
    await ensureLoaded();
    state.analyticsReports[String(dateKey)] = {
      dateKey: String(dateKey),
      sentAt: new Date().toISOString(),
      destination: destination ? String(destination) : null
    };
    await persist();
    return state.analyticsReports[String(dateKey)];
  }

  return {
    ensureLoaded,
    getUser,
    upsertUser,
    markUserPaid,
    setPendingPayment,
    getPayment,
    upsertPayment,
    getWebCheckout,
    upsertWebCheckout,
    getWebCheckoutByClaimToken,
    markWebCheckoutApproved,
    markWebCheckoutExpired,
    markWebCheckoutClaimed,
    listPendingPayments,
    getPendingPayment,
    clearPendingPayment,
    markPaymentApproved,
    logPaymentApproved,
    markInviteSent,
    markUserBlocked,
    listUsersNeedingInvite,
    listUsersPendingStartReminders,
    listUsersWithExpiredPendingPayments,
    getDailyAnalytics,
    hasAnalyticsReportBeenSent,
    markAnalyticsReportSent
  };
}

module.exports = { createStorage };
