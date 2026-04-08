const fs = require("node:fs/promises");
const path = require("node:path");

function createStorage(options = {}) {
  const filePath = options.filePath || path.join(__dirname, "data.json");

  let state = {
    users: {},
    payments: {},
    paymentLogs: []
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
        paymentLogs: Array.isArray(parsed?.paymentLogs) ? parsed.paymentLogs : []
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

  async function clearPendingPayment(telegramUserId) {
    await ensureLoaded();
    const user = await getUser(telegramUserId);
    if (!user?.pendingPaymentId) return;
    const paymentId = String(user.pendingPaymentId);
    await upsertUser(telegramUserId, {
      pendingPaymentId: null,
      pendingPaymentCreatedAt: null
    });
    if (state.payments[paymentId]) {
      state.payments[paymentId].clearedAt = new Date().toISOString();
    }
    await persist();
  }

  async function markPaymentApproved(paymentId, mpPayment) {
    await ensureLoaded();
    const key = String(paymentId);
    const existing = state.payments[key] || null;
    if (existing?.approvedAt) return { alreadyProcessed: true, payment: existing };

    state.payments[key] = {
      ...existing,
      paymentId: key,
      status: "approved",
      approvedAt: new Date().toISOString(),
      mercadoPago: mpPayment || existing?.mercadoPago || null
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

  return {
    ensureLoaded,
    getUser,
    upsertUser,
    markUserPaid,
    setPendingPayment,
    getPendingPayment,
    clearPendingPayment,
    markPaymentApproved,
    logPaymentApproved,
    markInviteSent
  };
}

module.exports = { createStorage };

