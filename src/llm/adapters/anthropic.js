'use strict';
const { generateObject } = require('ai');
const { createAnthropic } = require('@ai-sdk/anthropic');

// `fetch` is an optional pass-through to @ai-sdk/anthropic's own documented
// testing hook (ProviderSettings.fetch) — unit tests use it to run this
// adapter fully offline. Production callers never pass it.
function createAnthropicAdapter({ apiKey, model = 'claude-sonnet-5', fetch }) {
  const provider = createAnthropic({ apiKey, fetch });
  return {
    name: 'anthropic',
    // `input` is either a prompt string (every existing caller) or a single
    // user message with content parts (the agent's multimodal path) — same
    // contract google.js already accepts. Passing an object straight through
    // as `prompt` is what used to make the AI SDK reject a screenshot parse
    // with "Invalid prompt: prompt or messages must be defined".
    async generate(input, schema) {
      const call = typeof input === 'string'
        ? { model: provider(model), schema, prompt: input }
        : { model: provider(model), schema, messages: [input] };
      const { object } = await generateObject(call);
      return object;
    },
  };
}
module.exports = { createAnthropicAdapter };
