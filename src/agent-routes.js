'use strict';

const express = require('express');
const { requireAuth } = require('./auth-middleware');
const { getSupabase } = require('./supabase');
const { createManagerActions } = require('./manager-actions');
const { createAgentService } = require('./agent-service');
const { buildParts } = require('./agent-parts');
const { createGoogleAdapter, createAnthropicAdapter } = require('./llm/adapters');
const { searchSymbols } = require('./yahoo-client');
const config = require('./config');

// Gemini is primary; Claude is the fallback when Gemini errors. Both come from
// the existing adapter layer, so model ids stay in config.
function pickAdapters() {
  const list = [];
  if (config.GEMINI_API_KEY) {
    list.push(createGoogleAdapter({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL }));
  }
  if (config.ANTHROPIC_API_KEY) {
    list.push(createAnthropicAdapter({ apiKey: config.ANTHROPIC_API_KEY }));
  }
  return list;
}

// Try each adapter in order; the first that answers wins. If every adapter
// fails, parse() below catches it, retries once, and — even if the retry
// also fails — swallows the error into a normal 200 result with an `errors`
// array rather than rethrowing. So a failure here never reaches the route
// handler as an exception.
function failoverAdapter(adapters) {
  return {
    name: 'agent-failover',
    async generate(input, schema) {
      let last;
      for (const a of adapters) {
        try { return await a.generate(input, schema); }
        catch (err) { last = err; }
      }
      throw last || new Error('No LLM provider configured');
    },
  };
}

function createAgentRouter() {
  const router = express.Router();

  // Auth first: requireAuth only reads the Authorization header, so checking
  // it before the body parser rejects unauthenticated callers with 401
  // before the server buffers/parses up to 12mb of JSON on their behalf.
  // Images and audio arrive as base64 data URLs, so this router needs a
  // larger body limit than the app-wide 64kb. Scoped here only.
  router.use(requireAuth);
  router.use(express.json({ limit: '12mb' }));

  // Config (and therefore which providers are configured) is fixed for the
  // life of the process, so build the adapters once per router instead of
  // reconstructing SDK client objects on every request.
  const adapters = pickAdapters();
  const adapter = failoverAdapter(adapters);

  function serviceFor() {
    const sb = getSupabase();
    return createAgentService({
      sb,
      adapter,
      actions: createManagerActions({ sb }),
      searchSymbols,
      buildParts,
    });
  }

  router.post('/parse', async (req, res) => {
    const { text, image, audio, context } = req.body || {};
    if (!text && !image && !audio) return res.status(400).json({ error: 'Nothing to read — send text, an image, or audio.' });
    if (!getSupabase()) return res.status(503).json({ error: 'Service not configured' });
    if (!adapters.length) return res.status(503).json({ error: 'No LLM provider configured' });

    try {
      const out = await serviceFor().parse({ managerId: req.user.id, text, image, audio, context });
      return res.json(out);
    } catch (err) {
      // parse() itself never throws for a model failure — it catches, retries
      // once, and returns a normal result with an `errors` array. Anything
      // that reaches here is an infrastructure failure or a bug, not a model
      // outage, so it's always a plain server error.
      console.error('[agent] parse failed:', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/execute', async (req, res) => {
    const { proposalId, rows } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows approved' });
    if (!getSupabase()) return res.status(503).json({ error: 'Service not configured' });

    try {
      const out = await serviceFor().execute({ managerId: req.user.id, proposalId, rows });
      return res.json(out);
    } catch (err) {
      console.error('[agent] execute failed:', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}

module.exports = { createAgentRouter };
