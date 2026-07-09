'use strict';
const { z } = require('zod');

// LLM output schema for the AI Equity Analyst — NARRATIVE FIELDS ONLY.
//
// Contract (agreed, strict / least-assumptive):
//   - The LLM returns only qualitative/judgment fields + the recommendation verdict.
//   - All numeric/structured fields (mktCap, revenue, eps, margins, fcf, valuation
//     ratios, technical indicators, key levels) are merged in from Stage-A data by
//     analyst-service.js and are NEVER produced by the model. This matches the repo
//     principle in src/llm/schemas.js ("the model NEVER returns numbers we rely on").
//   - verdict is LLM-owned by default (choice A). analyst-service applies the one
//     documented override: confidence < 50 => HOLD (Doc 1: "Mixed signals — default
//     to HOLD").
//
// The final, doc-shaped 6-section report is assembled and checked by
// validateReport() in analyst-service.js.

const LlmNarrativeSchema = z.object({
  overview: z.object({
    thesis: z.string(),
  }),
  financials: z.object({
    trend: z.string(),
    beatMiss: z.string(),
  }),
  strengthsRisks: z.object({
    // No .default()/.optional()/.min(): OpenAI & Anthropic strict structured-output
    // require EVERY property to be listed in `required`. Optional/defaulted fields are
    // rejected ("'required' ... missing 'strengths'"). The model must always return
    // these arrays (empty allowed); non-emptiness is requested in the prompt.
    strengths: z.array(z.string()),
    risks: z.array(z.string()),
  }),
  valuation: z.object({
    vsSector: z.string(),
    vsHistory: z.string(),
    assessment: z.string(),
  }),
  technical: z.object({
    setup: z.string(),
  }),
  recommendation: z.object({
    verdict: z.enum(['BUY', 'HOLD', 'SELL']),
    primaryDrivers: z.array(z.string()),
    invalidationConditions: z.array(z.string()),
    confidenceJustification: z.string(),
  }),
});

const DISCLAIMER = 'For research purposes; not personalized investment advice.';

// Comparison-mode ranking (M5): a second LLM pass ranks the per-ticker results.
const ComparisonRankSchema = z.object({
  ranked: z.array(z.string()).min(1),   // tickers, best → worst
  rationale: z.string(),
});

module.exports = { LlmNarrativeSchema, ComparisonRankSchema, DISCLAIMER };
