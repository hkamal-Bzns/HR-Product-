# NOSI rates — research note (DRAFT, needs reviewer sign-off)

**Date researched:** 2026-11-08
**Status:** DRAFT — not applied to the code. The repo still ships `nosiEmployerPct: null`
(UNRESOLVED) by design; see `packages/shared/src/index.ts` and the M0 gate in the README.
Applying the rate below is a versioned Settings change (owner/accountant, effective date,
reason, impact preview, audit log), not a hard-coded edit.

## Question

Brief v2 left the NOSI employer rate UNRESOLVED: v1 had stated 21%, while earlier
research indicated 18.75% (employee 11% in both). Which is correct for a regular
private-sector employee in 2026?

## Answer — 18.75% employer / 11% employee

| | Rate (2026, regular employee) |
|---|---|
| Employer | **18.75%** of insurable wage |
| Employee | **11%** of insurable wage |
| Total | 29.75% |

Law: Social Insurance and Pensions Law No. 148 of 2019, administered by NOSI.

## Where the 21% came from

21% is a **different, narrower rule**: managers and board members listed in the
commercial register are subject to a flat 21% on the maximum insurable wage
(EGP 16,700 in 2026), regardless of actual salary. It is not the rate for regular
employees. That is the most likely source of the 21% in brief v1 — and the product
will need a separate handling for that category in M3 payroll, not the standard rate.

## 2026 insurable-wage band — confirmed by NOSI itself

- Minimum: **EGP 2,700/month** (up from EGP 2,300)
- Maximum: **EGP 16,700/month** (up from EGP 14,500)
- Effective: **1 January 2026**, under Law 148 of 2019.
- NOSI announcement (Arabic), 2025-11-30:
  https://www.nosi.gov.eg/ar/news/Pages/2025-11-30.aspx

The band already in the M1 seed (2,700–16,700) matches NOSI's announcement.

## Worked examples (2026, regular employee)

Insurable wage = actual wage clamped to EGP 2,700–16,700.

| Monthly wage | Insurable wage | Employer 18.75% | Employee 11% |
|---|---|---|---|
| EGP 2,500 | EGP 2,700 (floor) | EGP 506.25 | EGP 297.00 |
| EGP 7,000 (private-sector minimum wage, from 1 Mar 2025) | EGP 7,000 | EGP 1,312.50 | EGP 770.00 |
| EGP 30,000 | EGP 16,700 (cap) | EGP 3,131.25 | EGP 1,837.00 |

## Watch out — rates rise in January 2027

Article 19 of Law 148 of 2019 raises the pension rate by one point every seven years
from 2020, shared equally. From **1 January 2027** the totals are due to rise to
**19.25% employer / 11.5% employee**, and the insurable-wage limits change again.
The product's effective-dated statutory-rate versions (§10) must carry a 2027 version;
re-confirm the 2027 band in December 2026 before January payroll.

## Sources (checked 2026-11-08)

- NOSI announcement, 2025-11-30 — 2026 band EGP 2,700–16,700 from 1 Jan 2026:
  https://www.nosi.gov.eg/ar/news/Pages/2025-11-30.aspx
- Andersen Egypt, "Social Insurance in Egypt" (published 2026-06-30, updated
  2026-07-01) — employer 18.75%, employee 11%, total 29.75%; 2026 band 2,700–16,700:
  https://eg.andersen.com/social-insurance-in-egypt/
- TopSource Worldwide, "Payroll Services in Egypt" — rates verified 12 Oct 2026
  against Law 148 of 2019, NOSI's 2026 limits announcement and Labour Law 14 of 2025;
  also notes the Jan 2027 rise to 19.25% / 11.5%:
  https://topsourceworldwide.com/global-payroll/egypt/
- Gloroots, "Egypt Payroll Guide" — employer 18.75% / employee 11%; managers/board
  members in the commercial register at a flat 21% on the maximum insurable wage:
  https://www.gloroots.com/payroll-policy/egypt
- Dawmly, "How Net Salary Is Calculated in Egypt (2026)", 30 Oct 2026 — employee 11%
  of insurable wage held between EGP 2,700 and 16,700 in 2026:
  https://www.dawmly.com/blog/how-net-salary-is-calculated-egypt/

## What still needs a human

A payroll reviewer / Egyptian labour-law adviser should confirm this note (one line:
"confirmed for regular private-sector employees, 2026") before the rate is set as the
M2/M3 default. The rate sources above are law-firm and payroll-provider summaries
citing Law 148 of 2019 and NOSI; the NOSI page itself confirms the band, not the
percentages in the text retrieved. Do not ship payroll on this note alone.
