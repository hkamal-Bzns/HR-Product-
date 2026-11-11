# Income tax (Law 7/2024) & overtime (Labour Law 14/2025) — research note

**Date researched:** 2026-11-11
**Status:** REVIEWER-UNCONFIRMED — the whole rule set is flagged as such in the
code (`TAX_RULES_2026.status`, `OVERTIME_RULES_2026.status`,
`DEFAULT_STATUTORY_SETTINGS.taxRuleStatus`). The brief says the brackets apply
"as the reviewer confirms". A payroll reviewer must confirm every figure below
before a live run is paid on it. The rule sets are versioned data, so a
confirmed version replaces them without changing the arithmetic.

This note is research, not legal or tax advice. The brief and the appointed
reviewer prevail over any summary here.

## Income tax — Law 7 of 2024 (in force for salaries from 1 March 2024)

Amends Income Tax Law 91 of 2005. Monthly withholding method (all sources
agree): annualise the month — (monthly gross − employee social insurance)
× 12 — subtract the EGP 20,000 annual personal exemption, tax the annual
figure in slices, divide by 12.

| Annual taxable income (after exemption) | Rate |
|---|---|
| Up to EGP 40,000 | 0% |
| EGP 40,001 – 55,000 | 10% |
| EGP 55,001 – 70,000 | 15% |
| EGP 70,001 – 200,000 | 20% |
| EGP 200,001 – 400,000 | 22.5% |
| EGP 400,001 – 1,200,000 | 25% |
| Above EGP 1,200,000 | 27.5% |

### Phase-out above EGP 600,000 (Law 7/2024)

Higher incomes lose the lower bands step by step (all sources agree on the
shape; the exact slice boundaries below are the consensus reading):

| Annual taxable income | Bands applied |
|---|---|
| Up to 600,000 | Full table above |
| 600,001 – 700,000 | 10% from the first pound to 55,000, then 15% / 20% / 22.5% / 25% |
| 700,001 – 800,000 | 15% from the first pound to 70,000, then 20% / 22.5% / 25% |
| 800,001 – 900,000 | 20% from the first pound to 200,000, then 22.5% / 25% |
| 900,001 – 1,200,000 | 22.5% from the first pound to 400,000, then 25% |
| Above 1,200,000 | 25% up to 1,200,000, 27.5% above |

The engine implements this phase-out table (`annualIncomeTaxPiasters`).
**Reviewer to confirm:** whether the phase-out thresholds are measured on
annual taxable income after the exemption (as implemented) or on annual net
income before it, and the rounding rule for monthly withholding (engine
rounds the monthly figure to the nearest piaster).

### Worked check (Appendix A)

Gross EGP 10,000, employee NOSI EGP 1,100 → annual taxable
(10,000 − 1,100) × 12 − 20,000 = EGP 86,800 → tax
0 + 1,500 + 2,250 + 20% × 16,800 (3,360) = EGP 7,110/year → EGP 592.50/month.

## Overtime — Labour Law 14 of 2025 (effective 1 September 2025)

Standard time: 8 hours/day, 48 hours/week (Art. 117). Multipliers are TOTAL
pay for the overtime hour:

| Case | Multiplier | Source article |
|---|---|---|
| Daytime overtime (until 21:00) | 1.35× (normal + 35%) | Art. 121 |
| Night overtime (21:00–06:00) | 1.70× (normal + 70%) | Art. 121 |
| Weekly rest day worked | 2.00× + substitute rest day the following week | Art. 121 |
| Public holiday worked | 3.00× of the day's pay, or a substitute day off on the employee's written request | Art. 129 |

Hourly rate = monthly basic ÷ 208 standard hours/month (26 days × 8 h).
**Ambiguity to confirm:** some summaries state public-holiday pay as "200%
of the regular rate" (i.e. 2.00× total) rather than 300% of the day's pay.
Dawmly and Wuzzuf state 300% (the day's wage plus twice that) under
Art. 129; the engine uses 3.00× and the reviewer must confirm. The night
window also varies by source (21:00–06:00 per Dawmly; 22:00–06:00 and
19:00–07:00 appear elsewhere); the engine uses 21:00–06:00.

## Martyrs' Fund levy — 0.0002%

Brief §7: 0.0002% levy (0.02 per mille) "on the basis the reviewer confirms".
**Working basis implemented: gross pay.** For Appendix A that is
0.0002% × EGP 10,000 = EGP 0.02/month. The reviewer must confirm the basis
(gross vs taxable vs insurable) and whether the levy is an employee deduction
or an employer cost; the engine currently deducts it from the employee.

## NOSI — unchanged from the M0 note

Insurable-wage band 2026 EGP 2,700–16,700, employee 11% (see
`docs/nosi-2026-research-note.md`). **Employer rate: still UNRESOLVED.**
No employer figure is encoded in the tax/overtime rule sets or anywhere else
in the payroll engine; `employerNosiPiasters()` returns null and a run
refuses to finalise while it is null.

## Sources (checked 2026-11-11)

- Dawmly, "How Net Salary Is Calculated in Egypt (2026)", 30 Oct 2026 —
  brackets, exemption, annualisation, NOSI band:
  https://www.dawmly.com/blog/how-net-salary-is-calculated-egypt/
- Dawmly, "Working Hours in Egypt: Labor Law 2026 & Overtime" —
  35% / 70% premiums, rest-day double + substitute day, holiday 300% (Art. 129):
  https://dawmly.com/blog/egyptian-labor-law-working-hours-overtime/
- Dawmly, "How to Calculate Overtime in Egypt 2026 (135%/170% Examples)":
  https://dawmly.com/blog/how-to-calculate-overtime-egypt/
- Wanas Payroll, "Egypt Payroll Tax and Insurance 2026" (figures verified
  22 Oct 2026) — brackets, exemption, phase-out, six-step method:
  https://payroll.wanasapps.com/guides/egypt-social-insurance-income-tax-2026
- NNRoad, "Egypt Salary Income Tax 2026" (reviewed Nov 2026 against Law 91/2005
  as amended by Law 7/2024):
  https://nnroad.com/blog/individual-income-tax-in-egypt/
- TopSource Worldwide, "Payroll Services in Egypt" (verified 12 Oct 2026):
  https://topsourceworldwide.com/global-payroll/egypt/
- Legal500, "Personal Income Tax In Egypt" and "A Closer Look At Egypt's
  Income Tax Adjustments For 2024" — phase-out table:
  https://www.legal500.com/intelligence/egypt/tax/personal-income-tax-in-egypt-exemptions-rates-and-compliance
- Egyptian Tax Authority, Law 7/2024 text (PDF, Arabic) — official source,
  cited by OpenAccountants:
  https://eta.gov.eg/sites/default/files/2024-03/law_no.7-2024.pdf
- Wuzzuf, "Working Hours in the New Egyptian Labor Law" — 135% / 170% /
  rest-day / 300% holiday:
  https://wuzzuf.net/careers/working-hours-in-the-new-egyptian-labor-law-2/

## What still needs a human

A payroll reviewer / Egyptian labour-law adviser should confirm, in writing:
(1) the bracket table and phase-out thresholds and what they are measured on;
(2) the monthly rounding rule; (3) the Martyrs' Fund levy basis and bearer;
(4) the public-holiday multiplier (3.00× vs 2.00×) and the night window;
(5) the NOSI employer rate (separate M0 item — see the NOSI note).
Until then the engine is REVIEWER-UNCONFIRMED and no live run may be paid
on it without a parallel check (Brief §15, M3 exit criterion).
