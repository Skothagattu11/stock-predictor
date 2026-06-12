'use strict';
const { generateObject } = require('ai');
const { createGoogleGenerativeAI } = require('@ai-sdk/google');

function createGoogleAdapter({ apiKey, model = 'gemini-2.5-flash' }) {
  const provider = createGoogleGenerativeAI({ apiKey });
  return {
    name: 'gemini',
    async generate(prompt, schema) {
      const { object } = await generateObject({ model: provider(model), schema, prompt });
      return object;
    },
  };
}
module.exports = { createGoogleAdapter };
