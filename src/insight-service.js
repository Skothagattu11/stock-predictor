'use strict';
const { buildConsensus } = require('./llm/consensus');
const { buildPrompt } = require('./llm/prompt');
const { ReadSchema } = require('./llm/schemas');

function quantStance(mode, q) {
  if (mode === 'intraday') {
    const b = (q.bias || '').toLowerCase();
    return b === 'bullish' ? 'bullish' : b === 'bearish' ? 'bearish' : 'neutral';
  }
  // outlook
  const s = (q.stance || '').toLowerCase();
  return s === 'constructive' ? 'bullish' : s === 'cautious' ? 'bearish' : 'neutral';
}

function quantConfidence(mode, q) {
  if (mode === 'intraday' && typeof q.probability_up === 'number') {
    return Math.abs(q.probability_up - 0.5) * 2;     // 0.5 => 0 conviction, 1.0 => full
  }
  return typeof q.confidence === 'number' ? q.confidence : 0.5;
}

function createInsightService({ predictService, router }) {
  async function insight(mode, symbol) {
    const quant = await predictService[mode](symbol);
    const quantVote = { name: 'quant', stance: quantStance(mode, quant), confidence: quantConfidence(mode, quant) };

    let models = [];
    if (router.size > 0) {
      const raw = await router.ensemble(buildPrompt(mode, symbol, quant), ReadSchema);
      models = raw.filter((r) => r.ok).map((r) => ({ name: r.name, ...r.result }));
    }

    const votes = [quantVote, ...models.map((m) => ({ name: m.name, stance: m.stance, confidence: m.confidence }))];
    return { mode, symbol, quant, models, consensus: buildConsensus(votes) };
  }
  return { insight };
}

module.exports = { createInsightService, quantStance, quantConfidence };
