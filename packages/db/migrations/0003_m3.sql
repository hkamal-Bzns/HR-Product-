-- M3 — Payroll MVP (Brief §7, §10 Areas 6–7, Appendix A/B).
-- Locked runs are immutable: payslips store their line-by-line breakdown at
-- calculation time under the rule version that created them; corrections go
-- only to a later run as payroll_adjustments. NOSI employer rate untouched
-- (still NULL / UNRESOLVED, M0 blocker) — no employer default anywhere.
-- Bank files are GENERATED files (CSV layouts), not disbursements.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS bank_account text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS wallet_number text;

CREATE TABLE salary_structures (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), employee_id uuid NOT NULL REFERENCES employees(id), template_name text, basic_salary_piasters integer NOT NULL, allowances jsonb NOT NULL DEFAULT '[]', pay_period text NOT NULL DEFAULT 'monthly', pay_day integer NOT NULL DEFAULT 28, bank_account text, wallet_number text, advance_total_piasters integer NOT NULL DEFAULT 0, advance_instalment_piasters integer NOT NULL DEFAULT 0, loan_total_piasters integer NOT NULL DEFAULT 0, loan_instalment_piasters integer NOT NULL DEFAULT 0, effective_from text NOT NULL, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_salary_structures_tenant_employee ON salary_structures(tenant_id, employee_id);

CREATE TABLE payroll_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), period text NOT NULL, branch_ids jsonb NOT NULL DEFAULT '[]', status text NOT NULL DEFAULT 'draft', warnings_accepted jsonb NOT NULL DEFAULT '[]', anomalies jsonb NOT NULL DEFAULT '[]', total_gross_piasters integer NOT NULL DEFAULT 0, total_net_piasters integer NOT NULL DEFAULT 0, total_employee_nosi_piasters integer NOT NULL DEFAULT 0, total_tax_piasters integer NOT NULL DEFAULT 0, total_employer_nosi_piasters integer, employer_cost_status text NOT NULL DEFAULT 'pending', tax_rule_version integer NOT NULL DEFAULT 1, tax_rule_status text NOT NULL DEFAULT 'REVIEWER-UNCONFIRMED', overtime_rule_version integer NOT NULL DEFAULT 1, created_by_user_id uuid, approved_by_user_id uuid, approved_at timestamptz, locked_at timestamptz, paid_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_payroll_runs_tenant_period ON payroll_runs(tenant_id, period);

CREATE TABLE payslips (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), run_id uuid NOT NULL REFERENCES payroll_runs(id), employee_id uuid NOT NULL REFERENCES employees(id), period text NOT NULL, lines jsonb NOT NULL DEFAULT '[]', gross_piasters integer NOT NULL DEFAULT 0, employee_nosi_piasters integer NOT NULL DEFAULT 0, income_tax_piasters integer NOT NULL DEFAULT 0, martyrs_levy_piasters integer NOT NULL DEFAULT 0, total_deductions_piasters integer NOT NULL DEFAULT 0, net_piasters integer NOT NULL DEFAULT 0, employer_nosi_piasters integer, total_employer_cost_piasters integer, insurable_wage_piasters integer NOT NULL DEFAULT 0, worked_days integer NOT NULL DEFAULT 0, regular_hours_piasters integer NOT NULL DEFAULT 0, overtime_minutes jsonb NOT NULL DEFAULT '{}', below_minimum_wage boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_payslips_run ON payslips(run_id);
CREATE INDEX idx_payslips_tenant_employee ON payslips(tenant_id, employee_id);

CREATE TABLE payroll_adjustments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), employee_id uuid NOT NULL REFERENCES employees(id), source_run_id uuid REFERENCES payroll_runs(id), target_period text NOT NULL, amount_piasters integer NOT NULL, reason text NOT NULL, status text NOT NULL DEFAULT 'pending', created_by_user_id uuid, applied_run_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_payroll_adjustments_tenant_period ON payroll_adjustments(tenant_id, target_period, status);

CREATE TABLE bank_files (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), run_id uuid NOT NULL REFERENCES payroll_runs(id), bank text NOT NULL, filename text NOT NULL, content text NOT NULL, total_piasters integer NOT NULL DEFAULT 0, record_count integer NOT NULL DEFAULT 0, note text NOT NULL DEFAULT 'GENERATED FILE — not a disbursement. No money moved.', generated_by_user_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_bank_files_run ON bank_files(run_id);

CREATE TABLE export_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), run_id uuid REFERENCES payroll_runs(id), kind text NOT NULL, format text NOT NULL, generated_by_user_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_export_log_tenant ON export_log(tenant_id, created_at);
