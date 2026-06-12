'use strict';
const { z } = require('zod');

// One schema for every prediction mode's LLM "read". The model NEVER returns
// numbers we rely on — only a stance, a calibrated confidence, prose, risks, sources.
const ReadSchema = z.object({
  stance: z.enum(['bullish', 'neutral', 'bearish']),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  keyRisks: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
});

module.exports = { ReadSchema };
