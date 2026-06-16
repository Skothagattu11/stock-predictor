'use strict';
const express = require('express');

function createPredictRouter({ service }) {
  const router = express.Router();

  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      // Forward upstream client errors (notably 422 "forming — not enough
      // session data yet" at market open) so the UI shows the right message
      // instead of a misleading "sidecar unreachable". Everything else (network
      // failure, 5xx, unconfigured URL) is a genuine 503.
      const upstream = e && Number.isInteger(e.status) ? e.status : null;
      const status = upstream && upstream >= 400 && upstream < 500 ? upstream : 503;
      res.status(status).json({ error: 'prediction service unavailable', detail: e.message });
    }
  };

  router.get('/intraday/:symbol', wrap((req) => service.intraday(req.params.symbol.toUpperCase())));
  router.get('/outlook/:symbol', wrap((req) => service.outlook(req.params.symbol.toUpperCase())));
  router.get('/macro', wrap(() => service.macro()));
  router.get('/fundamentals/:symbol', wrap((req) => service.fundamentals(req.params.symbol.toUpperCase())));
  router.get('/implied-move/:symbol', wrap((req) => service.impliedMove(req.params.symbol.toUpperCase())));

  router.get('/position/:symbol', wrap((req) => {
    const q = req.query;
    const num = (v) => (v === undefined ? undefined : Number(v));
    return service.position(req.params.symbol.toUpperCase(), {
      current_price: num(q.current_price), cost_basis: num(q.cost_basis),
      shares: num(q.shares), portfolio_value: num(q.portfolio_value),
      intraday_bias: q.intraday_bias, outlook_stance: q.outlook_stance,
    });
  }));

  router.post('/portfolio', wrap((req) => service.portfolio(req.body.holdings || [])));
  router.get('/setups/:symbol', wrap((req) => service.setups(req.params.symbol.toUpperCase(), req.query.interval)));
  router.get('/discover', wrap(() => service.discover()));
  router.get('/calibration/stats', wrap(() => service.calibrationStats()));

  return router;
}

module.exports = { createPredictRouter };
