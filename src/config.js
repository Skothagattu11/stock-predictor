'use strict';

// Loads environment configuration. FINNHUB_API_KEY empty => simulated mode.
require('dotenv').config();

const FINNHUB_API_KEY = (process.env.FINNHUB_API_KEY || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const QUANT_SIDECAR_URL = (process.env.QUANT_SIDECAR_URL || '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const PERPLEXITY_API_KEY = (process.env.PERPLEXITY_API_KEY || '').trim();
const FMP_API_KEY = (process.env.FMP_API_KEY || '').trim();
const TV_WEBHOOK_SECRET = (process.env.TV_WEBHOOK_SECRET || '').trim();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const ALERT_FROM_EMAIL = (process.env.ALERT_FROM_EMAIL || 'alerts@resend.dev').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const APP_URL = (process.env.APP_URL || '').trim();

module.exports = {
  FINNHUB_API_KEY,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  PORT,
  QUANT_SIDECAR_URL,
  OPENAI_API_KEY,
  ANTHROPIC_API_KEY,
  PERPLEXITY_API_KEY,
  FMP_API_KEY,
  TV_WEBHOOK_SECRET,
  RESEND_API_KEY,
  ALERT_FROM_EMAIL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  APP_URL,
  hasKey: Boolean(FINNHUB_API_KEY),
  hasGemini: Boolean(GEMINI_API_KEY),
  hasSupabase: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
};
