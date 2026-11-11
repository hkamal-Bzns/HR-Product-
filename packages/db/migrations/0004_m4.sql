-- M4 — AI agents v1 + pilot hardening (Brief §8, §15 M4).
-- Agent runs are the audit trail (inputs hash, output, stubbed cost estimate,
-- human decision). Provider is 'stub' — no real LLM key exists in M4.
-- Schedule drafts are DRAFT ONLY until a human reviews and publishes them
-- through the M2 publish flow. users.employee_id links a login account to an
-- employee record (M3-flagged gap fix for employee self-service).
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id uuid REFERENCES employees(id);

CREATE TABLE agent_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), agent_id text NOT NULL, month text NOT NULL, input_hash text NOT NULL, output jsonb NOT NULL DEFAULT '{}', cost_piasters integer NOT NULL DEFAULT 0, provider text NOT NULL DEFAULT 'stub', status text NOT NULL DEFAULT 'completed', human_decision text, decisions jsonb NOT NULL DEFAULT '[]', decided_by_user_id uuid, employee_id uuid REFERENCES employees(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_agent_runs_tenant_agent_month ON agent_runs(tenant_id, agent_id, month);

CREATE TABLE agent_cost_ledger (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), agent_id text NOT NULL, month text NOT NULL, cost_piasters integer NOT NULL DEFAULT 0, run_id uuid NOT NULL REFERENCES agent_runs(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_agent_cost_tenant_month ON agent_cost_ledger(tenant_id, agent_id, month);

CREATE TABLE schedule_drafts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), branch_id uuid REFERENCES branches(id), week_start text NOT NULL, status text NOT NULL DEFAULT 'draft', suggestions jsonb NOT NULL DEFAULT '[]', agent_run_id uuid REFERENCES agent_runs(id), created_by_user_id uuid, decided_by_user_id uuid, published_roster_id uuid REFERENCES rosters(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_schedule_drafts_tenant_week ON schedule_drafts(tenant_id, week_start);

CREATE TABLE routed_questions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), employee_id uuid NOT NULL REFERENCES employees(id), question text NOT NULL, intent text NOT NULL, status text NOT NULL DEFAULT 'routed', answer text, answered_by_user_id uuid, created_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz);
CREATE INDEX idx_routed_questions_tenant_status ON routed_questions(tenant_id, status);

CREATE TABLE offline_sync_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), employee_id uuid NOT NULL REFERENCES employees(id), device_at timestamptz NOT NULL, outcome text NOT NULL, reason text NOT NULL, signature_status text NOT NULL DEFAULT 'legacy', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_offline_sync_tenant ON offline_sync_log(tenant_id, created_at);
