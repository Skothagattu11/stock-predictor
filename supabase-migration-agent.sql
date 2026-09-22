-- Manager Agent Entry — run in the Supabase SQL Editor after supabase-migration.sql.

CREATE TABLE IF NOT EXISTS agent_proposals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  input_text   text,
  input_kind   text NOT NULL DEFAULT 'text',   -- text | image | voice | mixed
  transcript   text,                            -- what the model heard, when voice
  plan         jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending', -- pending | executed | discarded
  results      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  executed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_agent_proposals_manager ON agent_proposals(manager_id);

ALTER TABLE agent_proposals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "proposals_own" ON agent_proposals;
CREATE POLICY "proposals_own" ON agent_proposals
  FOR ALL USING (manager_id = auth.uid()) WITH CHECK (manager_id = auth.uid());

-- Distinguish agent-originated entries in the existing audit trail.
ALTER TABLE position_history ADD COLUMN IF NOT EXISTS source      text DEFAULT 'manual';
ALTER TABLE position_history ADD COLUMN IF NOT EXISTS proposal_id uuid;
