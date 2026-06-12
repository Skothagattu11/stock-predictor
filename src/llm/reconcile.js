'use strict';

// Advisory guard: extract price/percent-looking numbers from LLM prose and flag any
// that don't match a quant fact (within tolerance). Bare small integers (days, counts)
// are ignored to avoid false positives. The LLM should reference, not invent, figures.
const TOKEN = /\$\s?\d+(?:\.\d+)?|\d+(?:\.\d+)?\s?%|\d+\.\d+/g;

function reconcileNumbers(text, facts, tol = 0.01) {
  const found = (text.match(TOKEN) || []).map((t) => parseFloat(t.replace(/[$%\s]/g, '')));
  const unverified = found.filter((n) =>
    !facts.some((f) => f !== 0 && Math.abs(n - f) / Math.abs(f) <= tol) && !facts.includes(n));
  return { clean: unverified.length === 0, unverified };
}

module.exports = { reconcileNumbers };
