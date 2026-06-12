'use strict';
const express = require('express');

function createInsightRouter({ insightService }) {
  const router = express.Router();
  router.get('/:mode/:symbol', async (req, res) => {
    const mode = req.params.mode;
    if (!['intraday', 'outlook'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be intraday or outlook' });
    }
    try {
      res.json(await insightService.insight(mode, req.params.symbol.toUpperCase()));
    } catch (e) {
      // Surface an upstream 4xx (e.g. 422 = not enough session data yet) as itself,
      // so the UI can distinguish "still forming" from "service down".
      const m = /-> (\d{3})/.exec(e.message || '');
      const code = m && m[1][0] === '4' ? parseInt(m[1], 10) : 503;
      res.status(code).json({ error: 'insight unavailable', detail: e.message });
    }
  });
  return router;
}
module.exports = { createInsightRouter };
