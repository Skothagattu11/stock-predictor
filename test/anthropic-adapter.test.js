'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { z } = require('zod');
const { createAnthropicAdapter } = require('../src/llm/adapters/anthropic');

// Finding 1: buildParts (src/agent-parts.js) promotes a parse call to a
// `{role:'user', content:[...]}` message object whenever an image or audio
// part is present. anthropic.js's generate(prompt, schema) used to pass its
// argument straight through as `{ prompt }` regardless of shape — the AI SDK
// rejects an object there as an invalid prompt. So a screenshot parse that
// fell through to the Claude failover threw, retried, threw again, and
// surfaced as a generic failure, even though the docs promise the fallback
// "just works" for images.
//
// These tests run fully offline: createAnthropicAdapter accepts an optional
// `fetch` override (the AI SDK's own documented testing hook — see
// @ai-sdk/anthropic's ProviderSettings.fetch) so no real network call or API
// key is needed, and the schema-validation bug this finding is about fires
// (or doesn't) before any fetch would happen anyway.

function fakeFetch(recorder) {
  return async (url, init) => {
    recorder.url = url;
    recorder.body = JSON.parse(init.body);
    const body = JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: recorder.body.model,
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'json', input: { x: 'ok' } }],
      stop_reason: 'tool_use', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const schema = z.object({ x: z.string() });
const multimodal = { role: 'user', content: [
  { type: 'text', text: 'what changed?' },
  { type: 'image', image: 'ZmFrZQ==', mediaType: 'image/png' },
] };

test('generate() accepts a multimodal message object (the screenshot fallback path)', async () => {
  const recorder = {};
  const adapter = createAnthropicAdapter({ apiKey: 'sk-ant-test', fetch: fakeFetch(recorder) });
  const object = await adapter.generate(multimodal, schema);
  assert.deepEqual(object, { x: 'ok' });
  // Sent as `messages`, not squeezed into `prompt` (which is what the SDK
  // rejects an object for).
  assert.ok(Array.isArray(recorder.body.messages), 'request body must carry messages, not a raw object under prompt');
});

test('generate() still accepts a plain string prompt (existing text path)', async () => {
  const recorder = {};
  const adapter = createAnthropicAdapter({ apiKey: 'sk-ant-test', fetch: fakeFetch(recorder) });
  const object = await adapter.generate('describe the change', schema);
  assert.deepEqual(object, { x: 'ok' });
});

test('the model id sent on the wire is whatever was configured, never a hardcoded string', async () => {
  const recorder = {};
  const adapter = createAnthropicAdapter({ apiKey: 'sk-ant-test', model: 'claude-totally-custom-model', fetch: fakeFetch(recorder) });
  await adapter.generate('hi', schema);
  assert.equal(recorder.body.model, 'claude-totally-custom-model');
});
