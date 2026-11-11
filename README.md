# HR & Payroll SaaS — Egypt

Standalone codebase for the HR & Payroll SaaS described in the v2 product brief
(`hr-payroll-product-brief.pdf`, 28 pages). Beachhead: 5–30 staff restaurants,
cafés and small frontline businesses in Egypt, sold first through Zad.

> **Scope — M1 Foundation + M2 Attendance & Shifts + M3 Payroll MVP.** M1: multi-tenancy, auth,
> roles, Settings framework (§10), Superadmin Lite (§11), seed demo data,
> Docker Compose. M2: attendance Modes A (QR + geofence) and B (passcode +
> photo kiosk), exception queue, roster templates + publish with WhatsApp
> notify (**stubbed**), swaps, open shifts, leave + Egypt 2026 holidays, and
> Settings screens for Attendance, Shifts and Leave (§10 Areas 2–4).
> M3: salary structures, 5-step payroll runs (prepare → review anomalies →
> calculate → approve/lock → pay), tax / NOSI / levies engine (Law 7/2024,
> **REVIEWER-UNCONFIRMED**), Arabic printable payslips, CIB/QNB/NBE/Banque Misr
> bank files (**generated files, not disbursement**), locked runs with
> next-run adjustments only, reports + logged CSV exports, and Settings
> screens for Payroll Structure, Statutory Rates, Notifications and
> Integrations/Billing/Data (§10 Areas 6–9).
> It does **not** build ZKTeco sync, live WhatsApp sending, or AI agents — those are M4 / V1.

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

Health check: `curl http://localhost:3001/health` → `{"status":"ok","scope":"m3"}`

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
- Salary structures for all 10 employees (emp-demo-1 follows Brief Appendix A:
  basic EGP 8,000 + transport EGP 2,000 = EGP 10,000 gross) + Settings v1 for
  payroll structure, notifications and integrations (§10 Areas 6, 8, 9)
- A **calculated demo payroll run for Nov 2026** (`run-demo-2026-11`, 10 payslips,
  totals reconcile; employer cost PENDING — see M3 below). It cannot be approved
  until a reviewer sets the NOSI employer rate.
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

## M3 — Payroll MVP (Brief §7, §10 Areas 6–9, Appendix A/B)

- **Engine** (`packages/shared/src/payroll.ts`, pure, piasters only): pro-rating
  by calendar days (joiner/leaver), overtime priced from verified attendance
  (day 1.35× / night 1.70× / rest day 2.00× / public holiday 3.00×, Labour Law
  14/2025), NOSI insurable wage clamped to EGP 2,700–16,700 with employee 11%,
  income tax per Law 7/2024 brackets (annualised, EGP 20,000 personal exemption,
  phase-out above EGP 600,000), Martyrs' Fund levy 0.0002% on gross,
  EGP 7,000 minimum-wage flag, advance/loan instalments, next-run adjustments.
  **The whole tax/overtime rule set is flagged REVIEWER-UNCONFIRMED** — see
  `docs/tax-2024-research-note.md` for the sources and the open questions
  (phase-out basis, levy basis, holiday 3.00× vs 2.00×, night window).
- **NOSI employer rate — still BLOCKED.** No default is shipped anywhere.
  `employerNosiPiasters()` returns null, employee payslips calculate correctly
  while employer cost is PENDING, and a run **refuses to finalise** (409
  `EMPLOYER_NOSI_RATE_UNRESOLVED`) until a reviewer sets the rate through the
  guarded versioned Settings change (owner/accountant, effective date, reason,
  impact preview, audit log). Employer contributions are never shown as an
  employee deduction. Tests set the rate only through that same Settings flow.
- **Run workflow** (`apps/api/src/payroll.ts`): 1) Prepare (period + branches,
  pulls verified attendance / approved leave / swaps / overtime; unresolved
  exceptions block calculation until resolved or explicitly accepted by the
  owner, choice recorded) → 2) Review anomalies (missing clock-outs, overtime
  spikes, below-minimum-wage, sharp net moves vs last month, zero attendance
  but full pay) → 3) Calculate (line-by-line payslips stored; sum of payslips
  = run total = payment-file total, re-checked on export) → 4) Approve
  (owner only, second confirmation showing total employer cost; run locks) →
  5) Pay (bank file + payslips via **stubbed** WhatsApp + in-app).
  Locked runs are immutable — corrections only as next-run adjustments, and a
  statutory change may not back-date into a locked period.
- **Bank files**: CIB / QNB / Banque Misr / NBE CSV layouts, clearly marked
  `GENERATED FILE — not a disbursement. No money moved.` Payslips are Arabic-first
  (printable HTML view + stubbed WhatsApp); PDF is the printable view, not a binary.
- **Reports**: payroll summary/register, employer cost report, tax + NOSI
  summaries, attendance/lateness, labour cost per branch per day. Exports are
  CSV (+ printable HTML); **every export is logged** (`GET /api/payroll/exports`).
- **Settings Areas 6–9** via the M1 framework: payroll structure (allowances,
  deduction types, templates, advance/loan policy, pay period/day, bank/wallet),
  statutory rates (guarded per §10), notifications/WhatsApp templates, and
  integrations/billing/data (ZKTeco devices, kiosk tablets, WhatsApp number —
  provider still `stub`).
- **Golden cases — all pass** (`packages/shared/test/payroll.test.ts`,
  `apps/api/test/m3.test.ts`): Appendix A worked example (gross 10,000,
  NOSI 1,100, tax 592.50, levy 0.02, net 8,307.48, employer PENDING);
  joiner/leaver mid-month pro-rating; NOSI floor 2,700 and ceiling 16,700;
  pay below EGP 7,000 flagged; overtime on rest day and public holiday;
  unpaid leave day; advance/loan deduction across two months; locked run
  corrected only via next-run adjustment. Plus: zero-pay leaver gets no NOSI
  floor (net 0, not −297) and tax phase-out above EGP 600,000.

### M3 API endpoints (all tenant-scoped, JWT)
`GET|POST /api/payroll/structures`, `POST /api/payroll/runs` (prepare),
`GET /api/payroll/runs[/:id]`, `POST /api/payroll/runs/:id/review|calculate|approve|pay|bank-file`,
`GET /api/payroll/runs/:id/payslips|export?kind=register|summary`,
`GET /api/payroll/payslips/:id|html`, `GET|POST /api/payroll/adjustments`,
`GET /api/payroll/reports/summary|employer-cost|tax-nosi|attendance|labour-cost`,
`GET /api/payroll/exports`, `GET /api/payroll/bank-files`.

### M3 exit criterion (Brief §15)
> Parallel run matches the accountant's figures to the pound on golden cases (Appendix B).

**Not yet met — needs a real parallel run.** The golden cases pass in tests,
but no accountant has reconciled a live month against the product yet.
Prerequisite: the M0 payroll reviewer confirms the tax/overtime rule set and
the NOSI employer rate (see M0 below).

## What M4 should build next

AI v1 (Agents 1 + 3: daily owner briefing, pre-payroll anomaly checker),
offline hardening, support tooling; then V1 (ZKTeco sync, mobile biometrics,
Agents 2 + 4, Zad integration, full Superadmin console). M4 must not start
before the M3 exit criterion: a parallel run matching the accountant's figures.

## M0 — payroll reviewer (BLOCKER, not code)

The NOSI employer contribution rate is **UNRESOLVED** in the brief (v1 stated 21%,
earlier research indicated 18.75%, employee 11% in both). This repo ships **no
employer NOSI default** — the field is `null` and flagged `needsReviewerConfirmation`.
Do not invent a rate and do not hard-code 21%. M3 was built with the guardrail
instead of the rate: the engine calculates employee payslips correctly, but a
run **cannot be finalised** until a payroll reviewer confirms the rate at M0
and sets it through the guarded Settings change. The reviewer must also confirm
the tax/overtime rule set (see `docs/tax-2024-research-note.md`) before any
live run is paid.

## What I need from Hazem

- GitHub repo: `hkamal-Bzns/HR-Product-` (private) — M1 and M2 are live there.
- Hosting choice for production (VPS / Railway / Render / other) — Compose is written to be portable.
- Payroll reviewer name/contact for the M0 NOSI confirmation.
- Pilot business names (3–5 from Zad relationships) for M2.
