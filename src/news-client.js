'use strict';
// Standalone news-headline client for the analyst Stage-A bundle. Finnhub company-news
// when a key is set, else keyless Yahoo Finance search. Injected into analyst-service so
// the service never calls the app's own HTTP route. Shape mirrors src/rest-routes.js news.
const FINNHUB_REST = 'https://finnhub.io/api/v1';

async function fromYahoo(symbol, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=10&quotesCount=0`;
  const r = await doFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return [];
  const j = await r.json();
  const news = Array.isArray(j && j.news) ? j.news : [];
  return news.filter((n) => n && n.title).slice(0, 8).map((n) => ({
    headline: n.title, source: n.publisher || '', url: n.link || '', datetime: n.providerPublishTime || 0,
  }));
}

async function fromFinnhub(symbol, key, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
  const ymd = (d) => d.toISOString().slice(0, 10);
  const url = `${FINNHUB_REST}/company-news?symbol=${encodeURIComponent(symbol)}&from=${ymd(from)}&to=${ymd(to)}&token=${encodeURIComponent(key)}`;
  const r = await doFetch(url);
  if (!r.ok) return [];
  const data = await r.json();
  if (!Array.isArray(data)) return [];
  return data.filter((n) => n && n.headline).sort((a, b) => b.datetime - a.datetime).slice(0, 8)
    .map((n) => ({ headline: n.headline, source: n.source || '', url: n.url || '', datetime: n.datetime || 0 }));
}

function createNewsClient({ finnhubKey, fetchImpl } = {}) {
  async function fetchNews(symbol) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return [];
    try {
      if (finnhubKey) {
        const f = await fromFinnhub(sym, finnhubKey, fetchImpl);
        if (f.length) return f;
      }
      return await fromYahoo(sym, fetchImpl);
    } catch (_) {
      return []; // news is optional context — never fail the pipeline
    }
  }
  return { fetchNews };
}

module.exports = { createNewsClient };
