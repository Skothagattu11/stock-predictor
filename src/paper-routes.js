'use strict';
const express = require('express');

// Paper-trading proxy. State is live (positions/cash), so nothing is cached.
function createPaperRouter({ sidecar }) {
  const router = express.Router();
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      const up = e && Number.isInteger(e.status) ? e.status : null;
      res.status(up && up >= 400 && up < 500 ? up : 503)
        .json({ error: 'paper service unavailable', detail: e.message });
    }
  };
  router.get('/portfolio', wrap(() => sidecar.paperPortfolio()));
  router.get('/history', wrap(() => sidecar.paperHistory()));
  router.get('/settings', wrap(() => sidecar.paperSettings()));
  router.post('/settings', wrap((req) => sidecar.paperSetSettings(req.body || {})));
  router.post('/order', wrap((req) => sidecar.paperOrder(req.body || {})));
  router.post('/close/:id', wrap((req) => sidecar.paperClose(req.params.id)));
  router.post('/reset', wrap(() => sidecar.paperReset()));
  return router;
}
module.exports = { createPaperRouter };
