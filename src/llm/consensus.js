'use strict';

const AGREEMENT_FLOOR = 0.6;   // below this, surface as "models split / low conviction"

function buildConsensus(votes) {
  if (!votes.length) return { stance: 'neutral', agreement: 0, divergence: true, votes: [] };

  const weight = (v) => (typeof v.confidence === 'number' ? v.confidence : 1);
  const tally = {};
  for (const v of votes) tally[v.stance] = (tally[v.stance] || 0) + weight(v);

  const stance = Object.keys(tally).reduce((a, b) => (tally[b] > tally[a] ? b : a));
  const total = votes.reduce((s, v) => s + weight(v), 0);
  const agree = votes.filter((v) => v.stance === stance).reduce((s, v) => s + weight(v), 0);
  const agreement = total ? agree / total : 0;

  return {
    stance,
    agreement: Math.round(agreement * 1000) / 1000,
    divergence: agreement < AGREEMENT_FLOOR,
    votes,
  };
}

module.exports = { buildConsensus, AGREEMENT_FLOOR };
