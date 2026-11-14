-- V1 (Brief §5 Mode C1/C2, §11, §12, §9 Zad stub, §14 Pro tier).
-- Biometric devices store a PUBLIC KEY ONLY — never a fingerprint/face
-- template, never a private key. NOSI employer rate untouched (still NULL).
-- Bank files remain GENERATED files, not disbursements.
CREATE TABLE zkteco_devices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), branch_id uuid REFERENCES branches(id), name text NOT NULL, model text NOT NULL, serial text NOT NULL, adapter text NOT NULL DEFAULT 'stub-adms', sync_status text NOT NULL DEFAULT 'never_synced', last_sync_at timestamptz, last_error text, last_clock_drift_seconds integer, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_zkteco_devices_tenant ON zkteco_devices(tenant_id);

CREATE TABLE zkteco_mappings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), device_id uuid NOT NULL REFERENCES zkteco_devices(id), device_user_id text NOT NULL, employee_id uuid NOT NULL REFERENCES employees(id), created_by_user_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX idx_zkteco_mappings_device_user ON zkteco_mappings(device_id, device_user_id);

CREATE TABLE zkteco_punches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), device_id uuid NOT NULL REFERENCES zkteco_devices(id), device_user_id text NOT NULL, employee_id uuid REFERENCES employees(id), device_at timestamptz NOT NULL, direction text NOT NULL DEFAULT 'in', dedup_key text NOT NULL UNIQUE, clock_drift_seconds integer, source text NOT NULL DEFAULT 'stub-adms', attendance_record_id uuid REFERENCES attendance_records(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_zkteco_punches_device ON zkteco_punches(device_id, device_at);

CREATE TABLE biometric_devices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), employee_id uuid NOT NULL REFERENCES employees(id), device_name text NOT NULL, platform text NOT NULL, public_key_pem text NOT NULL, consent_id uuid, revoked boolean NOT NULL DEFAULT false, revoked_at timestamptz, last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_biometric_devices_employee ON biometric_devices(tenant_id, employee_id);

CREATE TABLE consent_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), employee_id uuid NOT NULL REFERENCES employees(id), purpose text NOT NULL, consented boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'active', consent_text text NOT NULL, method text NOT NULL, version text NOT NULL, consented_at timestamptz, withdrawn_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_consent_records_employee_purpose ON consent_records(tenant_id, employee_id, purpose);

CREATE TABLE data_subject_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), employee_id uuid REFERENCES employees(id), kind text NOT NULL, status text NOT NULL DEFAULT 'received', requested_by text NOT NULL, notes text, executed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_dsr_tenant_status ON data_subject_requests(tenant_id, status);

CREATE TABLE plan_catalogue_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version integer NOT NULL, tiers jsonb NOT NULL DEFAULT '[]', zkteco_addon_price_piasters integer NOT NULL DEFAULT 24900, status text NOT NULL DEFAULT 'draft', created_by_user_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE subscriptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), plan text NOT NULL, plan_version integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'trial', trial_ends_at timestamptz, price_piasters_per_month integer NOT NULL DEFAULT 0, addons jsonb NOT NULL DEFAULT '[]', coupon text, discount_pct integer NOT NULL DEFAULT 0, dunning_stage text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), period text NOT NULL, amount_piasters integer NOT NULL, status text NOT NULL DEFAULT 'unpaid', refund_piasters integer NOT NULL DEFAULT 0, refund_provider_ref text, refund_note text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE statutory_rule_versions_v1 (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version integer NOT NULL, values jsonb NOT NULL DEFAULT '{}', effective_from text NOT NULL, status text NOT NULL DEFAULT 'draft', reviewer_signoff_ref text, release_notes_ar text, release_notes_en text, staging_result jsonb, published_at timestamptz, created_by_user_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tenant_notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id), kind text NOT NULL, title_ar text NOT NULL, title_en text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', read boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE superadmin_audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), superadmin_user_id uuid, superadmin_role text, tenant_id uuid REFERENCES tenants(id), action text NOT NULL, entity text, detail jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_superadmin_audit_created ON superadmin_audit(created_at);
