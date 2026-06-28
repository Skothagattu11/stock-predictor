-- ============================================================================
-- Wealth Manager schema for stock-predictor
-- Run this once in Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ============================================================================

-- 1. Clients managed by a wealth manager
CREATE TABLE IF NOT EXISTS manager_clients (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id    UUID        NOT NULL,  -- links to auth.users.id
  full_name     TEXT        NOT NULL,
  email         TEXT,
  phone         TEXT,
  risk_profile  TEXT        NOT NULL DEFAULT 'moderate', -- conservative | moderate | aggressive
  investment_goal TEXT,
  notes         TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Portfolios belonging to a client
CREATE TABLE IF NOT EXISTS client_portfolios (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID        NOT NULL REFERENCES manager_clients(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  color       TEXT        NOT NULL DEFAULT '#5b8cff',
  strategy    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Individual stock positions in a portfolio
CREATE TABLE IF NOT EXISTS portfolio_positions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id      UUID        NOT NULL REFERENCES client_portfolios(id) ON DELETE CASCADE,
  symbol            TEXT        NOT NULL,
  shares            NUMERIC,
  avg_cost          NUMERIC,
  entry_price       NUMERIC     NOT NULL,
  entry_date        TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_sell_price NUMERIC,
  stop_loss_price   NUMERIC,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Audit trail: BUY / SELL / REBALANCE / NOTE events
--    position_id is nullable (SET NULL) so SELL records survive position deletion
CREATE TABLE IF NOT EXISTS position_history (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id  UUID        REFERENCES portfolio_positions(id) ON DELETE SET NULL,
  portfolio_id UUID        NOT NULL REFERENCES client_portfolios(id) ON DELETE CASCADE,
  symbol       TEXT        NOT NULL,
  event_type   TEXT        NOT NULL, -- BUY | SELL | REBALANCE | NOTE
  price        NUMERIC     NOT NULL,
  shares       NUMERIC,
  total_value  NUMERIC,
  gain_pct     NUMERIC,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Share tokens for public read-only portfolio links
CREATE TABLE IF NOT EXISTS share_tokens (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID        NOT NULL UNIQUE REFERENCES client_portfolios(id) ON DELETE CASCADE,
  token        TEXT        NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  expires_at   TIMESTAMPTZ,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  view_count   INT         NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_manager_clients_manager_id    ON manager_clients(manager_id);
CREATE INDEX IF NOT EXISTS idx_client_portfolios_client_id   ON client_portfolios(client_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_positions_portfolio  ON portfolio_positions(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_position_history_portfolio    ON position_history(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_share_tokens_token            ON share_tokens(token);

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE manager_clients    ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_portfolios  ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE position_history   ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_tokens       ENABLE ROW LEVEL SECURITY;

-- Drop existing policies (safe to re-run; DROP IF EXISTS is supported in PG15)
DO $$ BEGIN
  DROP POLICY IF EXISTS "clients_select"       ON manager_clients;
  DROP POLICY IF EXISTS "clients_insert"       ON manager_clients;
  DROP POLICY IF EXISTS "clients_update"       ON manager_clients;
  DROP POLICY IF EXISTS "clients_delete"       ON manager_clients;
  DROP POLICY IF EXISTS "portfolios_select"    ON client_portfolios;
  DROP POLICY IF EXISTS "portfolios_insert"    ON client_portfolios;
  DROP POLICY IF EXISTS "portfolios_update"    ON client_portfolios;
  DROP POLICY IF EXISTS "portfolios_delete"    ON client_portfolios;
  DROP POLICY IF EXISTS "positions_select"     ON portfolio_positions;
  DROP POLICY IF EXISTS "positions_insert"     ON portfolio_positions;
  DROP POLICY IF EXISTS "positions_update"     ON portfolio_positions;
  DROP POLICY IF EXISTS "positions_delete"     ON portfolio_positions;
  DROP POLICY IF EXISTS "history_select"       ON position_history;
  DROP POLICY IF EXISTS "history_insert"       ON position_history;
  DROP POLICY IF EXISTS "share_tokens_public"  ON share_tokens;
  DROP POLICY IF EXISTS "share_tokens_manager" ON share_tokens;
END $$;

-- Manager sees only their own clients
CREATE POLICY "clients_select" ON manager_clients
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = manager_id);

CREATE POLICY "clients_insert" ON manager_clients
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = manager_id);

CREATE POLICY "clients_update" ON manager_clients
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = manager_id)
  WITH CHECK ((select auth.uid()) = manager_id);

CREATE POLICY "clients_delete" ON manager_clients
  FOR DELETE TO authenticated
  USING ((select auth.uid()) = manager_id);

-- Portfolios: accessible only via client ownership
CREATE POLICY "portfolios_select" ON client_portfolios
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM manager_clients WHERE id = client_id AND manager_id = (select auth.uid())
  ));

CREATE POLICY "portfolios_insert" ON client_portfolios
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM manager_clients WHERE id = client_id AND manager_id = (select auth.uid())
  ));

CREATE POLICY "portfolios_update" ON client_portfolios
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM manager_clients WHERE id = client_id AND manager_id = (select auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM manager_clients WHERE id = client_id AND manager_id = (select auth.uid())
  ));

CREATE POLICY "portfolios_delete" ON client_portfolios
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM manager_clients WHERE id = client_id AND manager_id = (select auth.uid())
  ));

-- Positions
CREATE POLICY "positions_select" ON portfolio_positions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM client_portfolios cp
    JOIN manager_clients mc ON mc.id = cp.client_id
    WHERE cp.id = portfolio_id AND mc.manager_id = (select auth.uid())
  ));

CREATE POLICY "positions_insert" ON portfolio_positions
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM client_portfolios cp
    JOIN manager_clients mc ON mc.id = cp.client_id
    WHERE cp.id = portfolio_id AND mc.manager_id = (select auth.uid())
  ));

CREATE POLICY "positions_update" ON portfolio_positions
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM client_portfolios cp
    JOIN manager_clients mc ON mc.id = cp.client_id
    WHERE cp.id = portfolio_id AND mc.manager_id = (select auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM client_portfolios cp
    JOIN manager_clients mc ON mc.id = cp.client_id
    WHERE cp.id = portfolio_id AND mc.manager_id = (select auth.uid())
  ));

CREATE POLICY "positions_delete" ON portfolio_positions
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM client_portfolios cp
    JOIN manager_clients mc ON mc.id = cp.client_id
    WHERE cp.id = portfolio_id AND mc.manager_id = (select auth.uid())
  ));

-- Position history
CREATE POLICY "history_select" ON position_history
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM client_portfolios cp
    JOIN manager_clients mc ON mc.id = cp.client_id
    WHERE cp.id = portfolio_id AND mc.manager_id = (select auth.uid())
  ));

CREATE POLICY "history_insert" ON position_history
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM client_portfolios cp
    JOIN manager_clients mc ON mc.id = cp.client_id
    WHERE cp.id = portfolio_id AND mc.manager_id = (select auth.uid())
  ));

-- Share tokens: public can read active+non-expired; manager can manage all
CREATE POLICY "share_tokens_public" ON share_tokens
  FOR SELECT
  USING (is_active = true AND (expires_at IS NULL OR expires_at > now()));

CREATE POLICY "share_tokens_manager" ON share_tokens
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM client_portfolios cp
    JOIN manager_clients mc ON mc.id = cp.client_id
    WHERE cp.id = portfolio_id AND mc.manager_id = (select auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM client_portfolios cp
    JOIN manager_clients mc ON mc.id = cp.client_id
    WHERE cp.id = portfolio_id AND mc.manager_id = (select auth.uid())
  ));
