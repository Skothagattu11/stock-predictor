'use strict';
const { generateObject } = require('ai');
const { createPerplexity } = require('@ai-sdk/perplexity');

function createPerplexityAdapter({ apiKey, model = 'sonar' }) {
  const provider = createPerplexity({ apiKey });
  return {
    name: 'perplexity',
    async generate(prompt, schema) {
      const { object } = await generateObject({ model: provider(model), schema, prompt });
      return object;
    },
  };
}
module.exports = { createPerplexityAdapter };
