'use strict';

// Loads environment configuration. FINNHUB_API_KEY empty => simulated mode.
require('dotenv').config();

const FINNHUB_API_KEY = (process.env.FINNHUB_API_KEY || '').trim();
const PORT = parseInt(process.env.PORT, 10) || 3000;

module.exports = {
  FINNHUB_API_KEY,
  PORT,
  hasKey: Boolean(FINNHUB_API_KEY),
};
