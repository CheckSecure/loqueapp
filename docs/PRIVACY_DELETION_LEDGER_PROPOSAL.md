# Privacy Policy update — deletion audit record

**Status: APPROVED AND IMPLEMENTED.** `app/privacy/page.tsx` §5 carries the approved language;
`PRIVACY_VERSION` is 2 / `2.0` / August 22, 2026. Not deployed.

This is a factual disclosure of a retention practice, not legal advice. The wording below should be
reviewed by whoever owns the policy before it ships.

## Proposed sentence

To be added to **§5 Data Retention** in `app/privacy/page.tsx`, after the existing 30-day sentence:

> When an account is deleted, Andrel retains a limited deletion audit record for security, fraud
> prevention, compliance, and operational integrity. This record contains only an internal account
> identifier, the date and time of the deletion, and categories describing how it was initiated and
> whether it completed. It does not contain your name, email address, profile information, messages,
> or any other content. We retain this record for seven (7) years.

## Rollout: published without interrupting existing members

`PRIVACY_VERSION` (published) and `MIN_REQUIRED_PRIVACY_VERSION` (required for access) are separate
constants. Published is 2; the minimum stays 1. So:

| Member state | Outcome today |
|---|---|
| accepted Privacy 1 | continues to the dashboard, uninterrupted |
| accepted Privacy 2 | continues |
| grandfathered through 1 | continues |
| no acceptance record at all | gated, and accepting records the **published** version (2) |

Requiring v2 later is **one constant change** — `MIN_REQUIRED_PRIVACY_VERSION = 2`. No migration, no
backfill, no bulk update; stored acceptance records are compared, never edited. Terms behaviour is
untouched and has no minimum of its own.

The decision is made from each member's durable acceptance record, **not** from an account creation
date — a proxy that goes wrong the moment a record and a timestamp disagree.

## Retention period: 7 years — approved

Recommended as instructed, and chosen because it matches the longest ordinary commercial
record-keeping horizon. **No existing Andrel policy or legal requirement was found that specifies a
different period**, so nothing is being contradicted — but nothing independently supports 7 years
either. It is a reasonable default, not a derived requirement, and Daniel should confirm it.

**The purge now exists**, so the period is a mechanism rather than a commitment:
`public.purge_expired_account_deletion_events()` takes no arguments, deletes only rows older than
exactly seven years, returns a count, and is callable by `service_role` alone. The daily
engagement-reminders maintenance run calls it once. The seven-year boundary is enforced twice — in
the purge body and independently in the ledger's append-only trigger — so editing the purge alone
cannot widen it.

Earlier removal remains possible only through a documented legal/privacy process. No arbitrary
per-user deletion endpoint was built, deliberately.

## What the sentence does and does not claim

- It does **not** claim indefinite retention.
- It does **not** promise deletion of the audit record within 30 days — which is important, because
  the existing §5 sentence says personal data is removed within 30 days, and a reader could
  otherwise assume that covers everything. The new sentence carves out the exception explicitly.
- It describes only fields that are actually stored. Every claim is verifiable against the schema:
  no column exists for a name, email, profile field, message, token, IP or payload.

## Existing §5 text — two accuracy notes, no change proposed here

1. *"we will remove your personal data within 30 days"* — the code removes it **immediately**.
   Practice is stronger than the promise, so this is not a violation, but the sentence describes a
   process the product does not have.
2. *"Certain records, including messages and transaction history, may be retained longer where
   necessary"* — messages and `credit_transactions` are deleted immediately. Again stronger than
   promised, and again a description that does not match the implementation.

Neither is corrected here. Both are flagged for the policy owner.
