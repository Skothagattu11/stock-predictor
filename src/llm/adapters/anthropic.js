'use strict';
const { generateObject } = require('ai');
const { createAnthropic } = require('@ai-sdk/anthropic');

function createAnthropicAdapter({ apiKey, model = 'claude-3-5-haiku-latest' }) {
  const provider = createAnthropic({ apiKey });
  return {
    name: 'anthropic',
    async generate(prompt, schema) {
      const { object } = await generateObject({ model: provider(model), schema, prompt });
      return object;
    },
  };
}
module.exports = { createAnthropicAdapter };
