'use strict';
const express = require('express');

function createAlertsRouter({ alertsService, resendEnabled }) {
  const router = express.Router();
  router.get('/status', (req, res) =>
    res.json({ email_enabled: Boolean(resendEnabled), subscriptions: alertsService.list().length }));
  router.post('/subscribe', (req, res) => {
    try {
      alertsService.subscribe(req.body || {});
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  router.post('/unsubscribe', (req, res) => {
    const b = req.body || {};
    if (b.email && b.symbol) alertsService.unsubscribe(b.email, b.symbol);
    res.json({ ok: true });
  });
  return router;
}

module.exports = { createAlertsRouter };
