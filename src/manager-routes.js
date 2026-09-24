'use strict';

const express = require('express');
const { requireAuth } = require('./auth-middleware');
const { getSupabase } = require('./supabase');

function createManagerRouter() {
  const router = express.Router();
  const { createManagerActions } = require('./manager-actions');

  // Map an action result onto the HTTP response.
  function send(res, result, okStatus = 200) {
    if (!result.ok) return res.status(result.code).json({ error: result.error });
    return res.status(okStatus).json(result.data);
  }
  const actionsFor = () => createManagerActions({ sb: getSupabase() });

  // ── Auth: sign in (proxy to Supabase so anon key stays server-side) ─────
  router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Auth not configured' });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });
    return res.json({ access_token: data.session.access_token, user: { id: data.user.id, email: data.user.email } });
  });

  router.post('/auth/signup', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Auth not configured' });

    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return res.status(400).json({ error: error.message });

    // Auto sign-in after registration
    const { data: session, error: signinErr } = await supabase.auth.signInWithPassword({ email, password });
    if (signinErr) return res.json({ message: 'Account created. Please sign in.' });
    return res.json({ access_token: session.session.access_token, user: { id: session.user.id, email: session.user.email } });
  });

  // ── Public share view (no auth) ──────────────────────────────────────────

  router.get('/share/:token/view', async (req, res) => {
    const sb = getSupabase();
    if (!sb) return res.status(503).json({ error: 'Service not configured' });

    const { data: token } = await sb.from('share_tokens')
      .select('*, client_portfolios(*, portfolio_positions(*))')
      .eq('token', req.params.token)
      .single();

    if (!token) return res.status(404).json({ error: 'Share link not found' });
    if (!token.is_active) return res.status(410).json({ error: 'This share link has been revoked' });
    if (token.expires_at && new Date(token.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This share link has expired' });
    }

    const portfolio = token.client_portfolios;
    const positions = portfolio.portfolio_positions || [];

    const symbols = [...new Set(positions.map((p) => p.symbol))];
    const priceMap = {};
    await Promise.all(
      symbols.map(async (sym) => {
        try {
          const r = await fetch(`http://localhost:${process.env.PORT || 3000}/api/quote/${sym}`);
          if (r.ok) {
            const q = await r.json();
            priceMap[sym] = { price: q.c || 0, day_change_pct: q.pc ? ((q.c - q.pc) / q.pc) * 100 : 0 };
          } else {
            priceMap[sym] = { price: 0, day_change_pct: 0 };
          }
        } catch (_) {
          priceMap[sym] = { price: 0, day_change_pct: 0 };
        }
      })
    );

    // Compute values internally for allocation math, then strip all dollar fields
    const rawHoldings = positions.map((p) => {
      const { price, day_change_pct } = priceMap[p.symbol] || { price: p.entry_price, day_change_pct: 0 };
      const gain_pct = p.entry_price ? ((price - p.entry_price) / p.entry_price) * 100 : 0;
      const mkt_value = p.shares ? p.shares * price : null;
      return { symbol: p.symbol, gain_pct, day_change_pct, mkt_value };
    }).sort((a, b) => b.gain_pct - a.gain_pct);

    const totalValue = rawHoldings.reduce((s, h) => s + (h.mkt_value || 0), 0);
    const avgGain = rawHoldings.length ? rawHoldings.reduce((s, h) => s + h.gain_pct, 0) / rawHoldings.length : 0;
    const avgDay = rawHoldings.length ? rawHoldings.reduce((s, h) => s + h.day_change_pct, 0) / rawHoldings.length : 0;

    // Public-safe holdings: percentages only, no dollar amounts or position sizes
    const holdings = rawHoldings.map((h) => ({
      symbol: h.symbol,
      gain_pct: h.gain_pct,
      day_change_pct: h.day_change_pct,
      allocation_pct: totalValue > 0 && h.mkt_value ? (h.mkt_value / totalValue) * 100 : null,
    }));

    sb.from('share_tokens').update({ view_count: token.view_count + 1 }).eq('token', req.params.token).then(() => {});

    return res.json({
      portfolio: { name: portfolio.name, color: portfolio.color, strategy: portfolio.strategy },
      summary: { stock_count: holdings.length, avg_gain_pct: avgGain, avg_day_change_pct: avgDay },
      holdings,
      view_count: token.view_count + 1,
      generated_at: new Date().toISOString(),
    });
  });

  // ── All routes below require auth ────────────────────────────────────────
  router.use(requireAuth);

  // ── Clients ──────────────────────────────────────────────────────────────

  router.get('/clients', async (req, res) => {
    const sb = getSupabase();
    const { data, error } = await sb.from('manager_clients')
      .select('*')
      .eq('manager_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  });

  router.post('/clients', async (req, res) =>
    send(res, await actionsFor().createClient(req.user.id, req.body || {}), 201));

  router.get('/clients/:id', async (req, res) => {
    const sb = getSupabase();
    const { data, error } = await sb.from('manager_clients')
      .select('*, client_portfolios(*)')
      .eq('id', req.params.id)
      .eq('manager_id', req.user.id)
      .single();
    if (error) return res.status(404).json({ error: 'Client not found' });
    return res.json(data);
  });

  router.put('/clients/:id', async (req, res) =>
    send(res, await actionsFor().updateClient(req.user.id, { ...req.body, clientId: req.params.id })));

  router.delete('/clients/:id', async (req, res) =>
    send(res, await actionsFor().deleteClient(req.user.id, { clientId: req.params.id })));

  // ── Portfolios ────────────────────────────────────────────────────────────

  router.get('/clients/:clientId/portfolios', async (req, res) => {
    const sb = getSupabase();
    // Verify client belongs to manager
    const { data: client } = await sb.from('manager_clients')
      .select('id').eq('id', req.params.clientId).eq('manager_id', req.user.id).single();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { data, error } = await sb.from('client_portfolios')
      .select('*, portfolio_positions(*)')
      .eq('client_id', req.params.clientId)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  });

  router.post('/clients/:clientId/portfolios', async (req, res) =>
    send(res, await actionsFor().createPortfolio(req.user.id, { ...req.body, clientId: req.params.clientId }), 201));

  router.get('/portfolios/:id', async (req, res) => {
    const sb = getSupabase();
    const { data: portfolio, error } = await sb.from('client_portfolios')
      .select('*, portfolio_positions(*), manager_clients!inner(manager_id)')
      .eq('id', req.params.id)
      .eq('manager_clients.manager_id', req.user.id)
      .single();
    if (error || !portfolio) return res.status(404).json({ error: 'Portfolio not found' });
    return res.json(portfolio);
  });

  router.delete('/portfolios/:id', async (req, res) => {
    const sb = getSupabase();
    // Verify ownership
    const { data: portfolio } = await sb.from('client_portfolios')
      .select('id, manager_clients!inner(manager_id)')
      .eq('id', req.params.id)
      .eq('manager_clients.manager_id', req.user.id)
      .single();
    if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

    const { error } = await sb.from('client_portfolios').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  });

  // ── Positions ─────────────────────────────────────────────────────────────

  router.post('/portfolios/:portfolioId/positions', async (req, res) =>
    send(res, await actionsFor().addPosition(req.user.id, { ...req.body, portfolioId: req.params.portfolioId }), 201));

  router.put('/positions/:id', async (req, res) =>
    send(res, await actionsFor().updatePosition(req.user.id, { ...req.body, positionId: req.params.id })));

  router.delete('/positions/:id', async (req, res) => {
    const managerId = req.user.id;
    const a = actionsFor();
    if (req.body && req.body.delete_only) {
      return send(res, await a.deletePosition(managerId, { positionId: req.params.id }));
    }
    return send(res, await a.sellPosition(managerId, {
      positionId: req.params.id, sell_price: req.body && req.body.sell_price, note: req.body && req.body.note,
    }));
  });

  // ── Position history ──────────────────────────────────────────────────────

  router.get('/portfolios/:portfolioId/history', async (req, res) => {
    const sb = getSupabase();
    const { data: pf } = await sb.from('client_portfolios')
      .select('id, manager_clients!inner(manager_id)')
      .eq('id', req.params.portfolioId)
      .eq('manager_clients.manager_id', req.user.id)
      .single();
    if (!pf) return res.status(404).json({ error: 'Portfolio not found' });

    const { data, error } = await sb.from('position_history')
      .select('*')
      .eq('portfolio_id', req.params.portfolioId)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  });

  // ── Share tokens ──────────────────────────────────────────────────────────

  router.get('/portfolios/:portfolioId/share', async (req, res) => {
    const sb = getSupabase();
    const { data: pf } = await sb.from('client_portfolios')
      .select('id, manager_clients!inner(manager_id)')
      .eq('id', req.params.portfolioId)
      .eq('manager_clients.manager_id', req.user.id)
      .single();
    if (!pf) return res.status(404).json({ error: 'Portfolio not found' });

    // Get existing or create new token
    let { data: token } = await sb.from('share_tokens')
      .select('*').eq('portfolio_id', req.params.portfolioId).single();

    if (!token) {
      const { data: created, error } = await sb.from('share_tokens').insert({
        portfolio_id: req.params.portfolioId,
      }).select().single();
      if (error) return res.status(500).json({ error: error.message });
      token = created;
    }

    // Derive base URL from the actual request so share links work behind any
    // proxy, ngrok tunnel, or deployment — not just localhost.
    const baseUrl = process.env.APP_URL && !process.env.APP_URL.includes('localhost')
      ? process.env.APP_URL.replace(/\/$/, '')
      : `${req.protocol}://${req.get('host')}`;
    return res.json({ ...token, share_url: `${baseUrl}/share.html?token=${token.token}` });
  });

  router.put('/portfolios/:portfolioId/share', async (req, res) => {
    const sb = getSupabase();
    const { data: pf } = await sb.from('client_portfolios')
      .select('id, manager_clients!inner(manager_id)')
      .eq('id', req.params.portfolioId)
      .eq('manager_clients.manager_id', req.user.id)
      .single();
    if (!pf) return res.status(404).json({ error: 'Portfolio not found' });

    const updates = {};
    if (req.body.is_active !== undefined) updates.is_active = Boolean(req.body.is_active);
    if (req.body.expires_at !== undefined) updates.expires_at = req.body.expires_at;

    const { data, error } = await sb.from('share_tokens')
      .update(updates)
      .eq('portfolio_id', req.params.portfolioId)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  });

  router.delete('/portfolios/:portfolioId/share', async (req, res) => {
    const sb = getSupabase();
    const { data: pf } = await sb.from('client_portfolios')
      .select('id, manager_clients!inner(manager_id)')
      .eq('id', req.params.portfolioId)
      .eq('manager_clients.manager_id', req.user.id)
      .single();
    if (!pf) return res.status(404).json({ error: 'Portfolio not found' });

    const { error } = await sb.from('share_tokens')
      .update({ is_active: false })
      .eq('portfolio_id', req.params.portfolioId);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, message: 'Share link revoked' });
  });

  return router;
}

module.exports = { createManagerRouter };
