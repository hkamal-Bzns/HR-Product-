-- M1 Foundation — initial schema. See packages/db/src/schema.ts (source of truth).
-- NOSI employer rate: nosi_employer_pct is NULLABLE by design — UNRESOLVED at M0.
CREATE TYPE tenant_status AS ENUM ('trial','active','past_due','suspended','churned');
CREATE TYPE plan AS ENUM ('free','starter','growth','pro');
CREATE TYPE role AS ENUM ('owner','accountant','branch_manager','employee');
CREATE TYPE superadmin_role AS ENUM ('operations','support','finance','auditor');

CREATE TABLE tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, name_ar text NOT NULL, name_en text NOT NULL, status tenant_status NOT NULL DEFAULT 'trial', plan plan NOT NULL DEFAULT 'free', staff_cap integer NOT NULL DEFAULT 5, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), email text NOT NULL, phone text, password_hash text NOT NULL, role role NOT NULL DEFAULT 'employee', branch_id uuid, mfa_enabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE branches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), name_ar text NOT NULL, name_en text NOT NULL, geofence_lat text, geofence_lng text, geofence_radius_m integer NOT NULL DEFAULT 100, timezone text NOT NULL DEFAULT 'Africa/Cairo', active boolean NOT NULL DEFAULT true);
CREATE TABLE employees (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), branch_id uuid REFERENCES branches(id), full_name_ar text NOT NULL, full_name_en text, phone text NOT NULL, job_title text, basic_salary_piasters integer, active boolean NOT NULL DEFAULT true);
CREATE TABLE settings_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), area text NOT NULL, version integer NOT NULL, effective_from text NOT NULL, value jsonb NOT NULL, changed_by_user_id uuid, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE settings_audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), area text NOT NULL, user_id uuid, old_value jsonb, new_value jsonb, effective_from text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE statutory_rate_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version integer NOT NULL, effective_from text NOT NULL, nosi_employee_pct integer NOT NULL DEFAULT 11, nosi_employer_pct integer, nosi_floor_egp integer NOT NULL DEFAULT 2700, nosi_ceiling_egp integer NOT NULL DEFAULT 16700, martyrs_fund_pct text NOT NULL DEFAULT '0.0002', minimum_wage_egp integer NOT NULL DEFAULT 7000, reviewer_signoff_ref text, status text NOT NULL DEFAULT 'draft', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid REFERENCES tenants(id), actor_user_id uuid, actor_kind text NOT NULL, action text NOT NULL, entity text, entity_id text, detail jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE api_keys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), name text NOT NULL, key_hash text NOT NULL, scopes jsonb NOT NULL DEFAULT '[]', revoked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE feature_flags (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid REFERENCES tenants(id), key text NOT NULL, enabled boolean NOT NULL DEFAULT false);
CREATE TABLE superadmin_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, password_hash text NOT NULL, role superadmin_role NOT NULL, mfa_enabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE break_glass_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), superadmin_user_id uuid NOT NULL REFERENCES superadmin_users(id), ticket_id text NOT NULL, reason text NOT NULL, expires_at timestamptz NOT NULL, enabled boolean NOT NULL DEFAULT false, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_employees_tenant ON employees(tenant_id);
CREATE INDEX idx_settings_tenant_area ON settings_versions(tenant_id, area);
CREATE INDEX idx_audit_tenant ON audit_log(tenant_id);
