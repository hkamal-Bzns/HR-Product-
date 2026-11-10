# HR & Payroll SaaS — Egypt

Standalone codebase for the HR & Payroll SaaS described in the v2 product brief
(`hr-payroll-product-brief.pdf`, 28 pages). Beachhead: 5–30 staff restaurants,
cafés and small frontline businesses in Egypt, sold first through Zad.

> **Scope — M1 Foundation only.** This repo is M1: multi-tenancy, auth, roles,
> Settings framework (§10), Superadmin Lite (§11), seed demo data, Docker Compose.
> It does **not** build payroll calculation, attendance clock-in, ZKTeco sync,
> live WhatsApp sending, or AI agents — those are M2–M4 / V1.

## Stack

- Node.js 22 LTS, TypeScript strict
- API: Fastify + TypeBox, JWT sessions, API keys with scopes, bcrypt password hashing
- DB: PostgreSQL 16, Drizzle ORM, migrations in `packages/db/migrations`
- Queue/cache: Redis 7 + BullMQ (wired in Compose; no jobs in M1)
- Web: React + Vite, Arabic default with full RTL, English toggle, EGP / Africa/Cairo
- Money: integer piasters everywhere (`packages/shared`). Never float EGP.
- Phones: normalised to `+20…` (`packages/shared`).

## Layout

```
apps/api/          Fastify API (auth, tenancy, settings, superadmin-lite, seed)
apps/web/          React dashboard (Arabic RTL default)
packages/db/       Drizzle schema + SQL migrations
packages/shared/   Pure types/helpers: phone normalisation, money, roles, settings areas
docker-compose.yml api + web + postgres + redis
```

## Run locally

```bash
cp .env.example .env        # edit DATABASE_URL / JWT_SECRET — never commit real secrets
docker compose up --build   # api :3001, web :5173, postgres :5432, redis :6379
# without Docker (API only, in-memory store for dev):
npm install
npm run build --workspace=@hr-payroll/shared
npm run build --workspace=@hr-payroll/db
npm run seed --workspace=@hr-payroll/api   # seeds the demo café (see below)
npm run dev --workspace=@hr-payroll/api
```

Health check: `curl http://localhost:3001/health` → `{"status":"ok","scope":"m1"}`

## Tests

```bash
npm install
npm test            # shared + db schema + api (unit + integration, node:test)
npm run typecheck   # tsc --noEmit in every workspace
```

M1 acceptance checklist (from Brief §15, M1):

- [ ] A business can set itself up self-serve in under 30 minutes (seed + register flow)
- [ ] Tenant A cannot read Tenant B data — see `apps/api/test/tenancy.test.ts`
- [ ] Settings change creates a new versioned, effective-dated rule set; locked runs are never rewritten (no payroll runs exist in M1 — the guard is in the settings store)
- [ ] Statutory rate change requires Owner/Accountant, effective date, reason, impact preview, audit log
- [ ] Superadmin can list tenants, change plan, toggle feature flags — and **cannot** see salaries/photos/payslips by default; break-glass is disabled by default and logged when used
- [ ] NOSI employer rate has **no default** — see `packages/db` / `packages/shared` and §M0 below

## Demo seed (first seed only)

One Egyptian café tenant — `demo-cafe` (القاهرة كافيه):

- 2 branches: Zamalek (HQ) and Maadi
- 3 staff users: owner, accountant, branch manager
- 10 employees, demo settings (attendance QR+geofence on, kiosk on, grace 10 min)
- No real people, no real salaries — demo figures only, in piasters.

Seed is idempotent: re-running it reports `already_seeded` and changes nothing.

## M0 — payroll reviewer (BLOCKER, not code)

The NOSI employer contribution rate is **UNRESOLVED** in the brief (v1 stated 21%,
earlier research indicated 18.75%, employee 11% in both). This repo ships **no
employer NOSI default** — the field is `null` and flagged `needsReviewerConfirmation`.
Do not invent a rate and do not hard-code 21%. A payroll reviewer must confirm the
correct rate at M0 before any payroll engine (M3) is built or any live run is made.

## What M2 should build next

Attendance Modes A (QR + geofence) and B (passcode + photo kiosk), exception queue,
roster templates, publish + WhatsApp notify (stubbed), swaps, leave — plus Settings
screens for Attendance, Shifts and Leave (Brief §10 Areas 2–4). Payroll (M3), AI
Agents 1 + 3 (M4) and ZKTeco (V1) must not be started before M2's exit criterion:
a pilot branch runs two full weeks with no paper fallback.

## What I need from Hazem

- GitHub repo name (e.g. `hazem/hr-payroll`) — this repo is `git init` + committed locally only; **not pushed** (GitHub is not connected yet).
- Hosting choice for production (VPS / Railway / Render / other) — Compose is written to be portable.
- Payroll reviewer name/contact for the M0 NOSI confirmation.
- Pilot business names (3–5 from Zad relationships) for M2.
