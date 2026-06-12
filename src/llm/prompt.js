'use strict';

// Build a compact, fact-pinned prompt from the quant prediction. The model is told to
// reason over (never restate as new facts) the numbers provided, and to cite sources.
function buildPrompt(mode, symbol, quant) {
  const facts = JSON.stringify(quant);
  return [
    `You are a market analyst. A deterministic quant engine produced this ${mode} read for ${symbol}:`,
    facts,
    'Give a concise stance (bullish/neutral/bearish), a calibrated confidence (0-1), a 2-3 sentence',
    'rationale, key risks, and sources. Do NOT invent prices or figures — reason only over the numbers',
    'above. If you reference a number, use the ones provided.',
  ].join('\n');
}

module.exports = { buildPrompt };
