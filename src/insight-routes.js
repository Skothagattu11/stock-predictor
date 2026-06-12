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
      res.status(503).json({ error: 'insight unavailable', detail: e.message });
    }
  });
  return router;
}
module.exports = { createInsightRouter };
