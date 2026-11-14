# PDPL & biometrics — legal position note (V1)

**This document is not legal advice.** It states, plainly, what the law
requires as the product understands it, what the code does and does not do,
and what remains a non-code blocker for Hazem. Egyptian legal advice must be
commissioned before any central biometric processing starts (Brief §12,
decision 4 in §16).

## The law

Egypt's Personal Data Protection Law, **Law 151 of 2020**, treats
fingerprints and face scans as **biometric, sensitive personal data**.
Processing them needs:

1. **Explicit written consent from every employee** — recorded per employee,
   per purpose, with the consent text, date, method and version. The product
   records exactly that (`consent_records`: purpose, consentText, method,
   version, consentedAt; withdrawal with withdrawnAt).
2. **A separate licence from the regulator** (the Personal Data Protection
   Centre) for processing sensitive/biometric data. Consent alone is not
   enough for central processing.

Processing without consent can be a **criminal offence**, with fines cited
in the brief's check at **EGP 500,000–5,000,000**. Kiosk photos and any
face comparison must be assessed under the same law — do not assume a photo
is exempt because it is "just a picture".

## What the V1 code does

- **Mobile biometrics (Mode C2, preferred route):** the phone's own
  fingerprint / face unlock confirms "this is the enrolled person holding
  this device". The biometric template stays on the phone, held by the
  operating system. The product receives **only a yes/no assertion** — an
  Ed25519 signature over `(tenant | employee | device | time | nonce)`,
  verified against the enrolled device **public key**. The server stores
  the public key only. It never receives, stores or transmits a
  fingerprint/face template or a private key. Requests carrying any
  template-like field are rejected (see `FORBIDDEN_BIOMETRIC_FIELDS` in
  `packages/shared/src/v1.ts` and the V1 tests, which scan the store for
  them).
- **Consent gating:** enrolment and clock-in are refused (403
  `CONSENT_REQUIRED`) without an active consent record for that purpose.
  Withdrawal revokes bound devices and blocks further biometric clock-ins;
  the consent record and audit trail are **retained** (withdrawal is not
  deletion of the evidence that consent existed).
- **Kiosk photos:** purpose-limited to attendance verification, access
  limited to branch manager and owner, **90-day retention** with a purge
  job (`POST /api/consent/purge-photos`). Photos attached to a dispute are
  retained longer by policy — that exception is not automated in V1 and
  must be decided case by case.
- **Data-subject requests:** access / export / delete run as a tracked
  workflow (`received → verified → owner_approved → executed → confirmed`),
  never as an ad-hoc database edit. Deletion is **blocked** when the
  employee has payslips in a locked payroll run (retention beats deletion
  for locked pay records); that block is surfaced, not worked around.
- **Support views:** masked by default (names initialled, phones partially
  masked, no photos, no salaries, no payslips) with consent status shown.
  Unmasking is break-glass impersonation only: time-boxed, ticket-justified,
  audit-logged, tenant-visible.

## What the code does NOT do (non-code blockers)

- It does **not** obtain the regulator licence. Until Hazem's legal adviser
  confirms the licensing route, no central biometric processing (central
  fingerprint/face matching, a central template store, automated face
  comparison as a decision-maker) may be switched on. The V1 design
  deliberately avoids needing it for the mobile route — but whether the
  mobile assertion route itself needs a licence filing is a question for
  the adviser, not for this codebase.
- It does **not** provide consent wording. The seeded consent text is a
  demo string; final Arabic wording must come from the legal review.
- It does **not** cover ZKTeco fingerprint templates stored **on the
  device itself**. ZKTeco sync in V1 moves attendance punches (device user
  ID + timestamp), never templates. If a customer enrols fingerprints on a
  ZKTeco device, that enrolment is the customer's device-side act and must
  itself be covered by consent + the licensing assessment.
- It does **not** set the NOSI employer rate or confirm the tax/overtime
  rule set — those remain the M0 payroll-reviewer's job.

## Checklist before Mode C goes live for a real branch

- [ ] PDPL legal advice commissioned; consent wording approved.
- [ ] Regulator licence route assessed (and filed if the adviser says so).
- [ ] Consent collected per employee per purpose before any enrolment.
- [ ] Photo retention (90 days) confirmed as the tenant's policy.
- [ ] Break-glass policy approved (who holds each superadmin role).
- [ ] A named person owns the January statutory-rule release each year.
