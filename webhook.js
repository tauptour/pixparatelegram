const express = require("express");
const { getPaymentById } = require("./payment");

function extractPaymentId(req) {
  const bodyId =
    req.body?.data?.id ||
    req.body?.id ||
    req.body?.payment_id ||
    req.body?.resource?.split?.("/").pop?.();

  const queryId = req.query?.data_id || req.query?.id;
  return bodyId || queryId || null;
}

function createWebhookRouter({ mercadoPagoAccessToken, storage, bot }) {
  const router = express.Router();

  router.post("/webhook", async (req, res) => {
    try {
      const paymentId = extractPaymentId(req);
      if (!paymentId) return res.status(200).json({ ok: true });

      const mpPayment = await getPaymentById({
        accessToken: mercadoPagoAccessToken,
        paymentId
      });

      const status = mpPayment?.status;
      if (status !== "approved") return res.status(200).json({ ok: true, status });

      const telegramUserIdRaw = mpPayment?.metadata?.telegram_user_id;
      const telegramUserId = telegramUserIdRaw ? Number(telegramUserIdRaw) : NaN;
      if (!Number.isFinite(telegramUserId)) {
        return res.status(200).json({ ok: true, ignored: true, reason: "no_telegram_user_id" });
      }

      const { alreadyProcessed } = await storage.markPaymentApproved(paymentId, mpPayment);
      if (alreadyProcessed) return res.status(200).json({ ok: true, alreadyProcessed: true });

      await storage.markUserPaid(telegramUserId, paymentId);
      await storage.clearPendingPayment(telegramUserId);

      const inviteLink = await bot.createVipInviteLink();
      await bot.sendVipInvite({ telegramUserId, inviteLink });

      await storage.markInviteSent(telegramUserId, inviteLink);
      await storage.logPaymentApproved({
        paymentId: String(paymentId),
        telegramUserId: String(telegramUserId),
        amount: mpPayment?.transaction_amount ?? null
      });

      console.log("[webhook] approved:", { paymentId: String(paymentId), telegramUserId });
      return res.status(200).json({ ok: true });
    } catch (err) {
      const message = err?.message || String(err);
      console.error("[webhook] error:", message);
      return res.status(200).json({ ok: true });
    }
  });

  return router;
}

module.exports = { createWebhookRouter };

