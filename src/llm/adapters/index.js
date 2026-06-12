'use strict';
const { createOpenAIAdapter } = require('./openai');
const { createAnthropicAdapter } = require('./anthropic');
const { createGoogleAdapter } = require('./google');
const { createPerplexityAdapter } = require('./perplexity');

// Only build an adapter when its key is present, so the ensemble auto-sizes to configured providers.
function buildAdapters(config) {
  const a = [];
  if (config.OPENAI_API_KEY) a.push(createOpenAIAdapter({ apiKey: config.OPENAI_API_KEY }));
  if (config.ANTHROPIC_API_KEY) a.push(createAnthropicAdapter({ apiKey: config.ANTHROPIC_API_KEY }));
  if (config.GEMINI_API_KEY) a.push(createGoogleAdapter({ apiKey: config.GEMINI_API_KEY }));
  if (config.PERPLEXITY_API_KEY) a.push(createPerplexityAdapter({ apiKey: config.PERPLEXITY_API_KEY }));
  return a;
}
module.exports = { buildAdapters, createOpenAIAdapter, createAnthropicAdapter, createGoogleAdapter, createPerplexityAdapter };
