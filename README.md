# HR & Payroll SaaS — Egypt

Standalone codebase for the HR & Payroll SaaS described in the v2 product brief
(`hr-payroll-product-brief.pdf`, 28 pages). Beachhead: 5–30 staff restaurants,
cafés and small frontline businesses in Egypt, sold first through Zad.

> **Scope — M1 Foundation + M2 Attendance & Shifts + M3 Payroll MVP + M4 AI agents v1.**
> M1: multi-tenancy, auth, roles, Settings framework (§10), Superadmin Lite (§11), seed demo data,
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
> M4: four AI agents v1 (daily owner briefing, schedule builder, pre-payroll
> anomaly checker, employee Q&A) on a **STUBBED** deterministic LLM provider
> (no real key, no real calls), agent-run audit trail + per-agent cost ledger
> with caps and kill switches, user↔employee linking for self-service,
> offline sync hardening (signed-timestamp verification, sync-status
> endpoint, cached roster viewing), tenant health snapshot + masked
> ticket-context for support, and Settings Area 10 (AI agents).
> It does **not** build ZKTeco sync, live WhatsApp sending, a real LLM, or
> the full Superadmin console — those are V1.

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

Health check: `curl http://localhost:3001/health` → `{"status":"ok","scope":"m4"}`

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

## M4 — AI agents v1 + pilot hardening (Brief §8, §15 M4)

- **LLM provider is STUBBED** (`apps/api/src/agentCore.ts`): `LlmProvider`
  with `generateStructured(prompt, schema)`; the `StubLlmProvider` composes
  outputs deterministically from structured inputs via the pure logic in
  `packages/shared/src/agents.ts` — names, dates and amounts are rendered
  from data, never generated as free text. No real LLM key exists, no real
  API calls are made. An `HttpLlmProvider` adapter (OpenAI-compatible) is
  defined and only activates when `LLM_API_KEY` is set in the environment;
  the key is never committed and never logged. Real per-token cost accounting
  must replace the stub estimates in V1.
- **Agent 1 — Daily owner briefing** (`POST /api/agents/briefing/run`,
  `GET /api/agents/briefing/latest`): yesterday's attendance (present/late/
  absent/missing clock-out, with names), today's uncovered shifts (coverage
  minimums), leave, labour cost to date vs the same point last month
  (daily rate × worked days; honestly reported as missing when there is no
  prior-month data), open exceptions, and the one action that matters most
  (uncovered shift > missing clock-out > absence > late > cost jump).
  Arabic first, WhatsApp via the stubbed notifier + in-app. Facts only.
- **Agent 2 — Schedule builder** (`POST /api/agents/schedule/draft`,
  `/api/agents/schedule/drafts/:id/review|publish`): draft roster for next
  week from the last 8 weeks of published rosters/attendance + coverage
  rules + approved leave; every suggestion shows its reason (history count)
  and its rest / weekly-hours / consecutive-days / coverage violations with
  a score. **Draft ONLY — it never auto-publishes.** A manager reviews each
  suggestion (accept/edit/reject) and only then publishes through the
  existing M2 publish flow (which notifies via stubbed WhatsApp).
- **Agent 3 — Pre-payroll anomaly checker** (`POST /api/agents/anomaly/run`,
  `/api/agents/anomaly/decisions`, wired into the M3 review step 2
  `POST /api/payroll/runs/:id/review`): ranked anomalies with amounts in
  EGP — duplicate payment (block), overtime spike vs the employee's own
  history, missing clock-outs priced as full days, plus the M3 base check
  (OT > 50% of basic, below minimum wage, sharp net move, zero attendance
  but full pay). The owner decides (accept/dismiss with a note); all flags
  and decisions are audit-logged. If the agent is paused, the review step
  still returns the M3 base check — **an agent pause never blocks payroll**.
- **Agent 4 — Employee Q&A** (`POST /api/agents/qa/ask`,
  `GET /api/agents/qa/mine`, `/api/agents/qa/routed`): Arabic answers to
  "next shift?", "leave balance?", "why was EGP X deducted?" — traced to the
  actual payslip lines, never recalculating pay. The employee sees ONLY
  their own data: the M3-flagged gap is fixed by linking a user account to
  an employee record (`POST /api/employees/link`, owner only;
  `GET /api/me/employee`), with tenant + ownership checks on every
  self-service read (payslip list, single payslip, printable payslip).
  Unanswered questions route to the manager (`routed_questions`) for a human
  answer.
- **Guardrails (tested)**: no agent changes pay, approves leave, publishes a
  roster, or disciplines anyone; every agent output cites its source
  numbers; every run is recorded (inputs SHA-256 hash, output, stubbed cost
  in piasters, status, human decision) in `agent_runs` + `agent_cost_ledger`.
  Cost per tenant per month is visible (`GET /api/agents/cost`) with a
  configurable cap (default EGP 500/agent/month, Settings Area 10 or
  `POST /api/agents/cost/cap`); exceeding the cap pauses that agent only.
  Kill switch per agent, per tenant (`POST /api/agents/kill-switch`,
  scope `tenant`, owner) and globally (scope `global`, superadmin + MFA),
  plus Settings Area 10 kill switches.
- **Offline hardening**: the M2 offline queue now verifies signed timestamps
  (HMAC-SHA256 when `OFFLINE_SIGNING_SECRET` is set; legacy mode accepts
  any non-empty signature, flagged as such, so existing kiosk clients keep
  working). Conflict rules: duplicate / unsigned / bad signature /
  overlapping active session are held for review with no record created;
  stale records are created but flagged `pending_review`. Every record is
  written to the sync log; `GET /api/attendance/offline-sync/status`
  reports pending/accepted/conflicted counts. The web caches the last
  published roster in localStorage and shows a staleness banner when
  offline. Payroll calculation stays server-side only.
- **Support tooling** (superadmin + MFA): `GET /api/superadmin/tenants/:id/health`
  — setup incomplete, branches with no clock-ins today, stuck payroll runs,
  WhatsApp delivery (stubbed rates, labelled as such), per-agent cost/pause
  state; `GET /api/superadmin/tenants/:id/ticket-context` — masked view
  (names initialled, phones partially masked, no photos, no salary figures).
- **Settings Area 10 — AI agents** (§10): provider (`stub`), monthly cap
  per agent, kill switches, briefing send time/language — owner change,
  accountant/branch-manager view, employee none.
- **Seed**: demo employee login `employee@demo-cafe.eg` / `DemoEmp123!`
  linked to emp-demo-1, plus demo agent runs (one briefing for 2026-11-11,
  one Zamalek draft for week 2026-11-16, one anomaly check on the Nov run,
  three Q&A exchanges).
- **Web** (`apps/web/src/main.tsx`): Agents page — briefing view, schedule-draft
  review (accept/edit/reject per suggestion, publish after review), anomaly
  review on the payroll wizard and the Agents page, employee Q&A chat-style
  view, cost + kill switches, offline sync status. English toggle still works.

### M4 API endpoints (all tenant-scoped, JWT; superadmin ones need MFA)
`POST /api/agents/briefing/run`, `GET /api/agents/briefing/latest`,
`POST /api/agents/schedule/draft`, `GET /api/agents/schedule/drafts[/:id]`,
`POST /api/agents/schedule/drafts/:id/review|publish`,
`POST /api/agents/anomaly/run`, `POST /api/agents/anomaly/decisions`,
`POST /api/agents/qa/ask`, `GET /api/agents/qa/mine`, `GET /api/agents/qa/routed`,
`POST /api/agents/qa/routed/:id/answer`, `POST /api/employees/link`,
`GET /api/me/employee`, `GET /api/agents/status|runs|cost`,
`POST /api/agents/cost/cap`, `POST /api/agents/kill-switch`,
`GET /api/attendance/offline-sync/status`,
`GET /api/superadmin/tenants/:id/health|ticket-context`.

### M4 exit criterion (Brief §15)
> First live (non-parallel) payroll paid through the product.

**Not yet met — needs a real pilot.** The code for it is complete and tested
(see below), but no live branch has run it and no live payroll has been paid
through the product. The M3 exit criterion (parallel run matching the
accountant's figures) is likewise still open pending the M0 reviewer.

## What V1 builds next

ZKTeco sync add-on, mobile biometrics, iOS app, Zad integration, full
Superadmin console (billing ops and dunning, tenant health, support console,
AI cost and kill switches, vendor analytics — §11), a real LLM provider with
per-token cost accounting (replacing the M4 stub estimates), and live
WhatsApp via 360dialog/Gupshup. V1 must not start before the M4 exit
criterion: a first live payroll paid through the product.

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
