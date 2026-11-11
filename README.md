# HR & Payroll SaaS — Egypt

Standalone codebase for the HR & Payroll SaaS described in the v2 product brief
(`hr-payroll-product-brief.pdf`, 28 pages). Beachhead: 5–30 staff restaurants,
cafés and small frontline businesses in Egypt, sold first through Zad.

> **Scope — M1 Foundation + M2 Attendance & Shifts.** M1: multi-tenancy, auth,
> roles, Settings framework (§10), Superadmin Lite (§11), seed demo data,
> Docker Compose. M2: attendance Modes A (QR + geofence) and B (passcode +
> photo kiosk), exception queue, roster templates + publish with WhatsApp
> notify (**stubbed**), swaps, open shifts, leave + Egypt 2026 holidays, and
> Settings screens for Attendance, Shifts and Leave (§10 Areas 2–4).
> It does **not** build payroll calculation, ZKTeco sync, live WhatsApp
> sending, or AI agents — those are M3–M4 / V1.

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

Health check: `curl http://localhost:3001/health` → `{"status":"ok","scope":"m2"}`

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

## M2 — what was built (Brief §15)

- **Mode A QR + geofence** (`apps/api/src/attendance.ts`, `m2.ts`): rotating QR
  token endpoint (`GET /api/attendance/qr-token`), GPS within the branch
  geofence radius from Settings, optional Wi-Fi match, shift window, mock-location
  flag, velocity check, one active session per employee. Off-location / low-confidence
  punches are **flagged for review, never auto-rejected**.
- **Offline queue** (`POST /api/attendance/offline-queue`): signed, timestamped
  records; duplicates and out-of-tolerance records go to the review queue and are
  **never silently overwritten**.
- **Mode B passcode + photo kiosk**: bcrypt-hashed 4–6 digit passcodes, 5 failed
  attempts → 15-minute lockout, consent record required before enrolment, photo
  stored as `photoRef` + retention date only (**never image bytes in git**,
  90-day default, branch-manager/owner access only). Photo mismatch **flags
  only — never auto-rejects**.
- **Exception queue** (`GET /api/exceptions`, `POST /api/exceptions/:id/resolve`):
  missed clock-out, late, early-leave, off-location, low-confidence, overtime
  over cap, photo mismatch. Resolve/dismiss needs a reason; every action is
  audit-logged. A missed-clock-out sweep endpoint flags open sessions past shift end.
- **Rosters** (`/api/shifts/templates`, `/api/rosters`, `/api/rosters/:id/publish`):
  Morning / Evening (overnight) / Split templates, draft → published, coverage
  warnings (min staff per role), rest / weekly-hours / consecutive-days guards.
  Publish notifies each rostered employee via the **stubbed** WhatsApp notifier.
- **Swaps & open shifts** (`/api/swaps`, `/api/open-shifts`): cover must match role
  and pass rest rules; manager approval required; approval moves the assignment.
- **Leave** (`/api/leave/*`): annual / sick / casual / unpaid, balances + accrual
  math (`packages/shared`), approval deducts the balance and marks roster
  assignments on-leave (removes expected attendance), Egypt 2026 public holidays
  pre-loaded (lunar dates marked provisional), who-is-off view.
- **Settings Areas 2–4** via the M1 framework: attendance modes per branch/group,
  QR rotation, grace, rounding (none/5/15), thresholds, missed-punch handling,
  break rules, shift/rest/caps/coverage, leave types/balances/approvers. Guardrail 4
  enforced: dangerous changes (geofence > 300 m, photo off, overtime cap up,
  retention cut, statutory) need `confirmDangerous: true` + a reason. Guardrail 3:
  changes affecting a published roster return `impact.publishedRosterAssignments`.
- **WhatsApp is STUBBED in M2** (`apps/api/src/notify.ts`): `StubWhatsAppProvider`
  records messages in the outbox (`GET /api/outbox`) with status
  `queued_stubbed`. Nothing is delivered and nothing claims delivery.
- **Web** (`apps/web/src/main.tsx`): Arabic RTL shell + real M2 screens —
  Attendance (QR token display + geofence clock-in demo, kiosk passcode form),
  Roster (templates, draft create, publish), Exceptions queue, Leave (request
  form + balances + 2026 holidays), Settings Areas 2–4 editor. English toggle works.

### M2 exit criterion (Brief §15)
> A pilot branch runs two full weeks on the product with no paper fallback.

**Not yet met — needs a real pilot.** The code for it is complete and tested
(see below), but no live branch has run it. Pilot prerequisites: a real branch
with geofence set, kiosk tablet (or manager phone for QR), staff enrolled with
consent, and a manager resolving the exception queue daily.

## Demo seed (first seed only)

One Egyptian café tenant — `demo-cafe` (القاهرة كافيه):

- 2 branches: Zamalek (HQ, 30.0626, 31.2197, 100 m) and Maadi (29.9601, 31.2506, 150 m)
- 3 staff users: owner, accountant, branch manager (Zamalek)
- 10 employees with contract type, start date and salary components (demo only)
- Shift templates Morning / Evening / Split; a **published 2-week roster**
  (weeks 2026-11-02 and 2026-11-09, 100 assignments)
- Sample attendance for 2026-11-10: on-time, 25-min-late, missed clock-out,
  off-location — with matching open exceptions
- Leave balances 2026 (annual 21 / sick 15 / casual 6) + one approved annual
  leave (emp-demo-6, 2026-11-12 → 13) with its roster days marked on-leave
- Kiosk consent + passcode enrolment for emp-demo-1 (passcode `1234`, demo only)
- Settings v1 for attendance, shifts and leave (shipped defaults, §10 guardrail 5)
- No real people, no real salaries — demo figures only, in piasters.

Seed is idempotent: re-running it reports `already_seeded` and changes nothing.

### M2 API endpoints (all tenant-scoped, JWT)
`GET /api/branches`, `GET /api/employees`, `GET /api/attendance/qr-token`,
`POST /api/attendance/clock-in|clock-out`, `POST /api/attendance/offline-queue`,
`GET /api/attendance`, `POST /api/attendance/consent`,
`POST /api/attendance/kiosk/enrol|kiosk/clock-in`,
`POST /api/attendance/sweep-missed-clock-outs`, `GET /api/exceptions`,
`POST /api/exceptions/:id/resolve`, `GET|POST /api/shifts/templates`,
`GET|POST /api/rosters`, `POST /api/rosters/:id/publish`,
`GET|POST /api/swaps`, `POST /api/swaps/:id/approve|reject`,
`GET|POST /api/open-shifts`, `POST /api/open-shifts/:id/claim|approve`,
`GET /api/leave/balances|holidays|who-off|requests`, `POST /api/leave/requests`,
`POST /api/leave/requests/:id/approve|reject`, `GET /api/outbox` (stubbed).

## M0 — payroll reviewer (BLOCKER, not code)

The NOSI employer contribution rate is **UNRESOLVED** in the brief (v1 stated 21%,
earlier research indicated 18.75%, employee 11% in both). This repo ships **no
employer NOSI default** — the field is `null` and flagged `needsReviewerConfirmation`.
Do not invent a rate and do not hard-code 21%. A payroll reviewer must confirm the
correct rate at M0 before any payroll engine (M3) is built or any live run is made.

## What M3 should build next

Payroll MVP: salary structures, run workflow, tax / NOSI / levies engine, payslips
(WhatsApp + PDF), bank files, locked runs, reports; Settings screens for Payroll
Structure and Statutory Rates (Areas 6–7) with guardrails, plus Notifications,
Billing and Data screens (Areas 8–9). M3 must not start before M2's exit
criterion: a pilot branch runs two full weeks with no paper fallback. The M0
NOSI employer-rate blocker is still open — no employer default is shipped.

## What I need from Hazem

- GitHub repo: `hkamal-Bzns/HR-Product-` (private) — M1 and M2 are live there.
- Hosting choice for production (VPS / Railway / Render / other) — Compose is written to be portable.
- Payroll reviewer name/contact for the M0 NOSI confirmation.
- Pilot business names (3–5 from Zad relationships) for M2.
