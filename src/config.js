'use strict';

// Loads environment configuration. FINNHUB_API_KEY empty => simulated mode.
require('dotenv').config();

const FINNHUB_API_KEY = (process.env.FINNHUB_API_KEY || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const QUANT_SIDECAR_URL = (process.env.QUANT_SIDECAR_URL || '').trim();

module.exports = {
  FINNHUB_API_KEY,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  PORT,
  QUANT_SIDECAR_URL,
  hasKey: Boolean(FINNHUB_API_KEY),
  hasGemini: Boolean(GEMINI_API_KEY),
};
