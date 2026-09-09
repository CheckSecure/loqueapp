# Phase 4A — the Andrel Next designation foundation

**4A-1 is installed. 4A-2 is not.** After 4A-1 the application is still *incapable* of creating a
Next member: no production TypeScript writes `profiles.member_type`, and migration 099 adds none.
This stage installs the guardrails before anything can use them.

## Architecture A — the intended community lives on the waitlist row

`waitlist.intended_member_type text NOT NULL DEFAULT 'professional'`, CHECK `IN ('professional','next')`.

**Why there.** Under the current invitation model the Auth user is minted by
`generateLink({type:'invite'})` and **no profile row exists** until the member acts. The profile is
created later by `/api/profile/initialize` or `completeOnboarding`, both of which omit `member_type`
and therefore take the column default. There is no profile to carry the community at invite time,
and the waitlist row is the only durable pre-account record.

Every existing row becomes `'professional'` in one statement, so existing Professional invitations
resolve exactly as before.

## Why Architecture D — "create Professional, promote later" — is prohibited

Two reasons, both from the code:

1. **`ensureRecord()` is check-then-insert.** If the profile exists it returns `'exists'` and writes
   nothing, so a retry after a mis-created Professional row would never correct it. The mistake
   would be permanent.
2. **The interval is not safe.** Between creation and promotion the student *is* a Professional.
   `completeOnboarding` can set `profile_complete` in the same session, and at that instant they are
   eligible for all seven ordinary candidate pools and discoverable via `can_discover_profile`.

The immutability trigger makes D impossible rather than merely discouraged.

## Conflicting intent fails closed — at both levels

**Issuance.** Migration 009 already declares `UNIQUE INDEX waitlist_email_lower_uniq ON
public.waitlist (lower(email))`, so two rows cannot share an address that differs only in case. It
normalises with `lower()` alone, while migration 078's identity resolvers use
`lower(btrim(...))` — so `' a@x.com'` and `'a@x.com'` are different rows to the index and the same
person to the resolver. `waitlist_intent_no_conflict_biu` closes that gap: it refuses a row whose
btrim-normalised address already has a **different** live intent. Same-intent duplicates are allowed,
because replayed issuance must stay idempotent. `revoked` rows are excluded (migration 029).

**Provisioning.** Issuance protection is never sufficient alone — legacy rows predate it, an operator
can write directly, a trigger can be disabled. `public.resolve_intended_member_type(text)` gives the
provisioner its own answer at the moment it is about to write:

```
{"outcome":"resolved","member_type":"professional"|"next"}
{"outcome":"ambiguous","count":N}      ← refusal
{"outcome":"not_found"}                ← refusal
```

**Both refusals mean create nothing.** A provisioner that cannot obtain `resolved` must never fall
back to the column default — that is precisely what silently produces a Professional profile for a
student. This was proven in the harness by *disabling* the trigger, smuggling in a conflicting row,
and confirming the resolver still answers `ambiguous`.

Identity is `lower(btrim(...))` — byte-identical to 078's resolvers and to
`lib/auth/normalizeEmail.ts`. One rule, not a subtly different fourth one.

## `member_type` is immutable after INSERT

`profiles_member_type_immutable_bu`, a `BEFORE UPDATE ... FOR EACH ROW` trigger, raises when
`NEW.member_type IS DISTINCT FROM OLD.member_type`.

- **It binds `service_role`.** The application writes profiles as `service_role`, which bypasses RLS,
  so an RLS policy could not bind it and neither could a TypeScript check. A trigger runs inside the
  write itself. Verified in the harness under `SET ROLE service_role`, including a bulk
  `UPDATE profiles SET member_type='next'` with no WHERE clause.
- **An UPDATE naming the same value is allowed.** `IS DISTINCT FROM` is NULL-safe and means the
  existing whole-row upserts in `app/actions.ts` keep working untouched. The invariant is about the
  *value* changing, not the column being named.
- **INSERT is deliberately untouched**, so 4A-2 can create a profile with `member_type='next'`
  atomically. Verified.
- **No bypass of any kind**: no session flag, no admin exemption, no `ADMIN_EMAIL`, no correction
  function. A legitimate future correction will be a separately designed administrative operation —
  deliberately absent here, because a correction mechanism that exists is one that can be called.

## Invitation replay and supersession

`token identity ≠ community identity`. Resume tokens (078) and their supersession (094) govern *how
someone gets back in*; the waitlist row governs *which community they are for*. Retiring a token
changes nothing about the designation.

| Scenario | Result |
|---|---|
| Duplicate send / duplicate link open | resolver re-reads the same row; idempotent |
| Existing `auth.users` | recovery-link path; designation unchanged |
| Existing `profiles` row | the existing row wins; immutability trigger forbids a change |
| Partial onboarding resumed | unchanged |
| Superseded resume token | unchanged — supersession is about tokens |
| Conflicting intents | refused at issuance; `ambiguous` at provisioning |
| Intent changed after issuance | the trigger refuses a flip while a different live intent exists |
| Concurrent issuance | 009's unique index plus the trigger; database-enforced, not a TS pre-check |
| Partial provisioning then retry | resolver re-consulted; still `resolved`; no default fallback |

## Migration health

Two probes registered: a **column** probe for `waitlist.intended_member_type` and a **function**
probe for `resolve_intended_member_type` with all-NULL args (STABLE, returns `not_found`, touches
nothing).

**Limitation, stated rather than implied: migration health cannot verify the triggers.** PostgREST
does not expose `pg_catalog`, so `pg_trigger` is not introspectable through the service-role client.
The triggers are proven by the migration's own postapply assertions — which roll the whole migration
back on failure — and by the disposable-PostgreSQL execution results above. A green dashboard means
the column and the resolver exist; it is not evidence that immutability is enforced.

## Scope

4A-1 contains **no** production Next writer. 4A-2 will be the first stage capable of authoritative
Next creation, and it must consult `resolve_intended_member_type` and refuse on anything but
`resolved`. Mentorship and Recruiting/Hiring remain separate future explicit cross-community bridges
and may not weaken the ordinary rule. The seven ordinary candidate pools remain same-community.

## Recorded, deliberately NOT fixed: `provisionMemberRecords` is off the live path

**Classification: obsolete architecture (B), not a regression, and not a Professional bug.**

`90f2598` (2026-07-22) added `provisionMemberRecords` and called it from `adminSendWaitlistInvite`,
which minted users with `auth.admin.createUser({...})` and a temp password — the fix for a real
incident where ~58% of follow-on profile/credit writes were lost.

`edbdc7e` (2026-08-10, "Replace password invites with secure tracked links") **deleted
`adminSendWaitlistInvite` entirely** (114 lines from `app/actions.ts`) and replaced the model with
`generateLink({type:'invite'})`. The provisioning call went with the function that contained it. Under
the new model nothing is created at invite time by design.

**New Professionals receive their initial credits at `/api/profile/complete`** (lines 117-126): if no
`meeting_credits` row exists it inserts one at `getMonthlyCredits(getEffectiveTier(profile))` with a
matching `credit_transactions` row, and tops up an existing row that is below the floor. Same tier
logic and same floor as `provisionMemberRecords`. So credits arrive at profile completion rather than
at invite, and **no member is missing them**.

The only residue is an **unused import** at `app/actions.ts:33`.
`reconcileMissingProvisioning` remains a legitimate repair tool for the legacy orphans.

This was recorded and **not fixed** in 4A-1: it is unrelated Professional provisioning, and this
stage must not absorb it. It does not invalidate Architecture A — it reinforces it, since the absence
of a profile at invite time is exactly why the designation must live on the waitlist row.
