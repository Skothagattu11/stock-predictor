'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateReport } = require('../../src/analyst-service');
const { LlmNarrativeSchema } = require('../../src/analyst-schema');

function validMergedReport() {
  return {
    overview: { sector: 'Tech', mktCap: 1e12, thesis: 'AI leader' },
    financials: { revenue: 90e9, eps: 1.5, margins: 0.75, fcf: 60e9, trend: 'improving', beatMiss: 'beat' },
    strengthsRisks: { strengths: ['CUDA moat'], risks: ['China ban'] },
    valuation: { ratios: { pe: 35 }, vsSector: 'premium', vsHistory: 'mid-range', assessment: 'fair' },
    technical: { setup: 'bullish', indicators: {}, keyLevels: {}, available: true },
    recommendation: { verdict: 'BUY', primaryDrivers: ['growth', 'moat'], invalidationConditions: ['margin <70%'], confidenceJustification: 'both signals aligned' },
  };
}

// --- validateReport (final merged report, Doc 2 lines 747-774) --------------
test('validateReport: accepts a valid 6-section report', () => {
  assert.doesNotThrow(() => validateReport(validMergedReport()));
});

test('validateReport: throws on a missing section', () => {
  const bad = validMergedReport();
  delete bad.valuation;
  assert.throws(() => validateReport(bad), /missing/i);
});

test('validateReport: throws on an invalid verdict', () => {
  const bad = validMergedReport();
  bad.recommendation.verdict = 'STRONG BUY';
  assert.throws(() => validateReport(bad), /verdict/i);
});

// --- LlmNarrativeSchema (LLM output = narrative only) -----------------------
function validNarrative() {
  return {
    overview: { thesis: 'AI leader' },
    financials: { trend: 'improving', beatMiss: 'beat' },
    strengthsRisks: { strengths: ['moat'], risks: ['ban'] },
    valuation: { vsSector: 'premium', vsHistory: 'mid', assessment: 'fair' },
    technical: { setup: 'bullish' },
    recommendation: { verdict: 'BUY', primaryDrivers: ['growth'], invalidationConditions: ['x'], confidenceJustification: 'ok' },
  };
}

test('LlmNarrativeSchema: valid narrative passes', () => {
  assert.equal(LlmNarrativeSchema.safeParse(validNarrative()).success, true);
});

test('LlmNarrativeSchema: rejects an invalid verdict enum', () => {
  const bad = validNarrative();
  bad.recommendation.verdict = 'MAYBE';
  assert.equal(LlmNarrativeSchema.safeParse(bad).success, false);
});

test('LlmNarrativeSchema: narrative carries NO numeric fields (numbers are Stage-A only)', () => {
  const parsed = LlmNarrativeSchema.parse(validNarrative());
  assert.equal('mktCap' in parsed.overview, false);
  assert.equal('revenue' in parsed.financials, false);
  assert.equal('ratios' in parsed.valuation, false);
});

test('LlmNarrativeSchema: primaryDrivers is required (missing fails)', () => {
  const bad = validNarrative();
  delete bad.recommendation.primaryDrivers;
  assert.equal(LlmNarrativeSchema.safeParse(bad).success, false);
});
