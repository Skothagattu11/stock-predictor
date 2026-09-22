'use strict';
const { generateObject } = require('ai');
const { createGoogleGenerativeAI } = require('@ai-sdk/google');

function createGoogleAdapter({ apiKey, model = 'gemini-3.6-flash' }) {
  const provider = createGoogleGenerativeAI({ apiKey });
  return {
    name: 'gemini',
    // `input` is either a prompt string (every existing caller) or a single
    // user message with content parts (the agent's multimodal path).
    async generate(input, schema) {
      const call = typeof input === 'string'
        ? { model: provider(model), schema, prompt: input }
        : { model: provider(model), schema, messages: [input] };
      const { object } = await generateObject(call);
      return object;
    },
  };
}
module.exports = { createGoogleAdapter };
