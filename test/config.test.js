'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Finding 1 (part 2): ANTHROPIC_MODEL must exist beside GEMINI_MODEL with the
// same default-if-unset pattern, so the Claude failover model is never
// hardcoded in service code.

function freshConfig() {
  delete require.cache[require.resolve('../src/config')];
  return require('../src/config');
}

test('ANTHROPIC_MODEL defaults to a current Claude model when unset', () => {
  delete process.env.ANTHROPIC_MODEL;
  const config = freshConfig();
  assert.equal(config.ANTHROPIC_MODEL, 'claude-sonnet-5');
});

test('ANTHROPIC_MODEL is read from the environment when set', () => {
  process.env.ANTHROPIC_MODEL = 'claude-opus-5';
  try {
    const config = freshConfig();
    assert.equal(config.ANTHROPIC_MODEL, 'claude-opus-5');
  } finally {
    delete process.env.ANTHROPIC_MODEL;
    freshConfig(); // leave the module cache in the default state for later test files
  }
});
