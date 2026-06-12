'use strict';
const { generateObject } = require('ai');
const { createOpenAI } = require('@ai-sdk/openai');

function createOpenAIAdapter({ apiKey, model = 'gpt-4o-mini' }) {
  const provider = createOpenAI({ apiKey });
  return {
    name: 'openai',
    async generate(prompt, schema) {
      const { object } = await generateObject({ model: provider(model), schema, prompt });
      return object;
    },
  };
}
module.exports = { createOpenAIAdapter };
