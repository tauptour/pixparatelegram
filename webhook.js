const express = require("express");
const { getPaymentById } = require("./payment");

function extractPaymentId(req) {
  const bodyId =
    req.body?.data?.transactionId ||
    req.body?.data?.id ||
    req.body?.transactionId ||
    req.body?.transaction?.transactionId ||
    req.body?.transaction?.id ||
    req.body?.id ||
    req.body?.payment_id ||
    req.body?.resource?.split?.("/").pop?.();

  const queryId = req.query?.transactionId || req.query?.data_id || req.query?.id;
  return bodyId || queryId || null;
}

function createWebhookRouter({ misticPayClientId, misticPayClientSecret, storage, onPaymentApproved }) {
  const router = express.Router();

  router.post("/webhook", async (req, res) => {
    try {
      const paymentId = extractPaymentId(req);
      if (!paymentId) return res.status(200).json({ ok: true });

      const payment = await getPaymentById({
        clientId: misticPayClientId,
        clientSecret: misticPayClientSecret,
        paymentId
      });

      const status = payment?.status;
      if (status !== "approved") return res.status(200).json({ ok: true, status });

      const storedPayment = await storage.getPayment(paymentId);
      if (!storedPayment) {
        return res.status(200).json({ ok: true, ignored: true, reason: "payment_not_stored" });
      }

      await onPaymentApproved({ paymentId, payment, storedPayment });
      console.log("[webhook] approved:", { paymentId: String(paymentId), channel: storedPayment?.channel || "telegram" });
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
