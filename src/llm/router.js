'use strict';

// Fan one prompt out to every configured adapter in parallel. A failing provider is
// captured (never sinks the others). Adapters share the { name, generate(prompt, schema) } shape.
function createRouter({ adapters = [] } = {}) {
  async function ensemble(prompt, schema) {
    const settled = await Promise.allSettled(adapters.map((a) => a.generate(prompt, schema)));
    return settled.map((s, i) => (s.status === 'fulfilled'
      ? { name: adapters[i].name, ok: true, result: s.value }
      : { name: adapters[i].name, ok: false, error: String((s.reason && s.reason.message) || s.reason) }));
  }
  return { ensemble, size: adapters.length };
}

module.exports = { createRouter };
