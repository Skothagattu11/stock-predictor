'use strict';

const express = require('express');
const { requireAuth } = require('./auth-middleware');
const { getSupabase } = require('./supabase');

function createManagerRouter() {
  const router = express.Router();

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

  router.post('/clients', async (req, res) => {
    const sb = getSupabase();
    const { full_name, email, phone, risk_profile, investment_goal, notes } = req.body || {};
    if (!full_name) return res.status(400).json({ error: 'full_name required' });

    const { data, error } = await sb.from('manager_clients').insert({
      manager_id: req.user.id,
      full_name,
      email: email || null,
      phone: phone || null,
      risk_profile: risk_profile || 'moderate',
      investment_goal: investment_goal || null,
      notes: notes || null,
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  });

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

  router.put('/clients/:id', async (req, res) => {
    const sb = getSupabase();
    const allowed = ['full_name', 'email', 'phone', 'risk_profile', 'investment_goal', 'notes', 'is_active'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];

    const { data, error } = await sb.from('manager_clients')
      .update(updates)
      .eq('id', req.params.id)
      .eq('manager_id', req.user.id)
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data);
  });

  router.delete('/clients/:id', async (req, res) => {
    const sb = getSupabase();
    const { error } = await sb.from('manager_clients')
      .delete()
      .eq('id', req.params.id)
      .eq('manager_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  });

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

  router.post('/clients/:clientId/portfolios', async (req, res) => {
    const sb = getSupabase();
    const { data: client } = await sb.from('manager_clients')
      .select('id').eq('id', req.params.clientId).eq('manager_id', req.user.id).single();
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const { name, color, strategy } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });

    const { data, error } = await sb.from('client_portfolios').insert({
      client_id: req.params.clientId,
      name,
      color: color || '#5b8cff',
      strategy: strategy || null,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  });

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

  router.post('/portfolios/:portfolioId/positions', async (req, res) => {
    const sb = getSupabase();
    // Verify portfolio ownership
    const { data: pf } = await sb.from('client_portfolios')
      .select('id, manager_clients!inner(manager_id)')
      .eq('id', req.params.portfolioId)
      .eq('manager_clients.manager_id', req.user.id)
      .single();
    if (!pf) return res.status(404).json({ error: 'Portfolio not found' });

    const { symbol, shares, avg_cost, entry_price, target_sell_price, stop_loss_price, note } = req.body || {};
    if (!symbol || !entry_price) return res.status(400).json({ error: 'symbol and entry_price required' });

    const { data: pos, error } = await sb.from('portfolio_positions').insert({
      portfolio_id: req.params.portfolioId,
      symbol: symbol.toUpperCase(),
      shares: shares ? Number(shares) : null,
      avg_cost: avg_cost ? Number(avg_cost) : null,
      entry_price: Number(entry_price),
      target_sell_price: target_sell_price ? Number(target_sell_price) : null,
      stop_loss_price: stop_loss_price ? Number(stop_loss_price) : null,
      note: note || null,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });

    // Write BUY history event
    await sb.from('position_history').insert({
      position_id: pos.id,
      portfolio_id: req.params.portfolioId,
      symbol: pos.symbol,
      event_type: 'BUY',
      price: pos.entry_price,
      shares: pos.shares,
      total_value: pos.shares ? pos.shares * pos.entry_price : null,
      note: note || null,
    });

    return res.status(201).json(pos);
  });

  router.put('/positions/:id', async (req, res) => {
    const sb = getSupabase();
    const { data: pos } = await sb.from('portfolio_positions')
      .select('id, portfolio_id, symbol, entry_price, client_portfolios!inner(manager_clients!inner(manager_id))')
      .eq('id', req.params.id)
      .eq('client_portfolios.manager_clients.manager_id', req.user.id)
      .single();
    if (!pos) return res.status(404).json({ error: 'Position not found' });

    const allowed = ['entry_price', 'shares', 'avg_cost', 'target_sell_price', 'stop_loss_price', 'note'];
    const updates = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];

    const { data, error } = await sb.from('portfolio_positions')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });

    // Write REBALANCE event — use updated entry_price if changed, else original
    const rebalancePrice = req.body.entry_price ?? pos.entry_price;
    const rebalanceShares = req.body.shares ?? pos.shares;
    await sb.from('position_history').insert({
      position_id: pos.id,
      portfolio_id: pos.portfolio_id,
      symbol: pos.symbol,
      event_type: 'REBALANCE',
      price: rebalancePrice,
      shares: rebalanceShares,
      total_value: rebalanceShares ? rebalanceShares * rebalancePrice : null,
      note: req.body.note || 'Position updated',
    });

    return res.json(data);
  });

  router.delete('/positions/:id', async (req, res) => {
    const sb = getSupabase();
    const { data: pos } = await sb.from('portfolio_positions')
      .select('id, portfolio_id, symbol, entry_price, shares, client_portfolios!inner(manager_clients!inner(manager_id))')
      .eq('id', req.params.id)
      .eq('client_portfolios.manager_clients.manager_id', req.user.id)
      .single();
    if (!pos) return res.status(404).json({ error: 'Position not found' });

    // delete_only = true means remove the entry without recording a SELL event
    if (!req.body.delete_only) {
      const sellPrice = Number(req.body.sell_price) || pos.entry_price;
      const gainPct = ((sellPrice - pos.entry_price) / pos.entry_price) * 100;

      await sb.from('position_history').insert({
        position_id: pos.id,
        portfolio_id: pos.portfolio_id,
        symbol: pos.symbol,
        event_type: 'SELL',
        price: sellPrice,
        shares: pos.shares,
        total_value: pos.shares ? pos.shares * sellPrice : null,
        gain_pct: gainPct,
        note: req.body.note || null,
      });

      const { error } = await sb.from('portfolio_positions').delete().eq('id', req.params.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ ok: true, gain_pct: gainPct });
    }

    // Plain delete — no history event
    const { error } = await sb.from('portfolio_positions').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
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
