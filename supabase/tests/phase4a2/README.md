# Phase 4A-2 — migration 100 verification harness

Disposable. **Never point this at production.** `run.sh` takes no connection string and cannot be
aimed at anything but a cluster it builds and destroys itself.

    ./supabase/tests/phase4a2/run.sh

Exit status is the verdict: `cases.sql` raises if any assertion failed.

## Why this is a separate directory rather than an extension of `phase3/`

`phase3/fixtures.sql` inserts five profiles with an explicit `member_type` and no waitlist rows.
Every one of those inserts is **refused** once migration 100 is loaded. Extending Phase 3 in place
would have meant rewriting its fixtures to satisfy the thing under test — so Phase 3 never loads
migration 100, this harness never loads Phase 3's fixtures, and neither weakens the other.

`harness_schema_delta.sql` builds on `phase3/harness_schema.sql` instead of duplicating it, so the
role setup and the `ALTER DEFAULT PRIVILEGES` modelling stay in one place.

## Load order, and why it is what it is

```
phase3/harness_schema.sql        tables, roles, Supabase default privileges
harness_schema_delta.sql         profiles constraints, auth.users, public.waitlist
095, 053, 078-resolvers, 075, 084, 099        the real migrations, verbatim
historical_fixtures.sql          ← BEFORE 100
100_provisioning_…sql            the migration under test
cases.sql                        the matrix
```

**The fixtures load before migration 100 on purpose.** Production had 139 profiles when 100 was
written, and two of them predate the invitation architecture entirely. A fixture created *after* the
trigger would have had to satisfy it — which is exactly the property cases 12, 13 and 22 exist to
measure. Seeding first is the only faithful model.

**Migrations are loaded verbatim, never restated.** The one exception is migration 078, which also
creates the resume-token tables and reaches into `invitation_deliveries`; none of that is reachable
from a profiles INSERT, and loading it whole would put a large unrelated surface here where an
unrelated breakage would look like a migration-100 failure. `extract_resolvers.py` copies the two
functions `may_provision_profile` actually calls, **byte-for-byte**, into `resolvers_078.sql`, and
`lib/__tests__/phase4a2-provisioning-boundary.test.ts` asserts the round trip — every extracted body
must still appear verbatim in 078, or the test fails and the file must be regenerated.

## It never truncates

075's `capture_profiles_truncate` fires `BEFORE TRUNCATE` and calls `record_account_deletion_event`,
so truncating `profiles` between cases would write ledger rows — and would fail outright if the
ledger were absent. A fresh cluster per run is cheaper and cannot drift.

## What this harness proved that reading could not

Two results changed the design rather than confirming it.

**`NOT NULL` is enforced on a row that `ON CONFLICT` discards.** A proposed row carrying NULL in a
NOT NULL column raises 23502 *before* the conflict is resolved. So the trigger's step 0 cannot
simply `RETURN NEW`: once the `member_type` default is gone, that would break every existing
member's next profile edit. Step 0 assigns the row's current community instead. Case 24 keeps both
halves — the raw PostgreSQL fact, and the behaviour that depends on it. Removing the assignment
turns five assertions red with `null value in column "member_type"`.

**The two-function split is load-bearing, not stylistic.** Removing the `may_provision_profile` gate
and letting `resolve_intended_member_type` decide alone lets a *declined* invitation, an ambiguous
identity, a **mismatched auth id** and a never-invited `contacted` row all create profiles — because
099's resolver excludes only `revoked`. Fourteen assertions go red.

## The concurrency proof (R2)

    ./supabase/tests/phase4a2/concurrency_proof.sh

**Deliberately not part of `vitest run`.** It needs a local PostgreSQL toolchain and spends ~40s
waiting on locks on purpose; a timing test in the ordinary suite is the kind of flake that gets
muted and then ignored. What lives in the fast suite instead is the *structure* the measured
behaviour depends on — see the two assertions in
`lib/__tests__/phase4a2-provisioning-boundary.test.ts` about lock ordering and the VOLATILE/STABLE
split. Both were negative-tested: declaring the trigger `STABLE`, or removing the `FOR SHARE`, each
turns one red.

Two genuinely independent connections, fed through their own FIFOs. Blocking is measured from
`pg_stat_activity.wait_event_type` and `pg_blocking_pids()` — the server's own view — because psql
writing to a file is block-buffered and "no output yet" would prove nothing.

Measured on PostgreSQL 16.15, reproduced identically across two runs, **0 deadlocks**:

| Scenario | Result |
|---|---|
| **1** A inserts and holds; B revokes the same invitation | B waits on `Lock / transactionid`, blocked by A's pid. Still blocked at 2s and 4s. Released when A commits (~6.1s) |
| **2** same, A **rolls back** | B blocked ~4.1s, released on rollback. **No profile created** |
| **3** B revokes and holds; A inserts; B **commits** | A waits on `Lock / transactionid`, blocked by B's pid (~5.1s). When it unblocks, **A observes the committed revoke and refuses: `provisioning refused (waitlist_not_invited)`. No profile created** |
| **4** B revokes and holds; A inserts; B **rolls back** | A blocked ~5.1s, then proceeds. Profile created, `member_type = professional` |

**Scenario 3 is the one that mattered.** Serialising is only half the requirement — after the lock
is granted, the STABLE authorizer has to observe the revoke that committed while it waited, or the
lock has merely delayed a stale read. It observes it, because the trigger is VOLATILE and therefore
takes a fresh snapshot for each statement it runs, which the STABLE function then inherits. That was
an assumption until this script measured it.

**Deadlock analysis.** No cycle exists. Provisioning acquires `profiles` (row insert) then
`waitlist` (FOR SHARE); the revoke path acquires `waitlist` only and never touches `profiles` before
it. A cycle would need a writer taking `profiles` before `waitlist` in one session and the reverse
in another; `/api/admin/waitlist/revoke` reads profiles only to decide whether to proceed, before it
opens its transaction against waitlist. The run confirms it: `deadlock` appears 0 times in the
server log.

## Known limitation: PostgreSQL version

This runs on whatever `initdb` is on PATH; production is 17.6. The behaviours under test — BEFORE
INSERT firing for `ON CONFLICT`, constraint evaluation on an excluded row, trigger name ordering,
`FOR SHARE` — are unchanged across these majors, but the harness cannot prove that by itself.

**Where a property must be true of PRODUCTION, assert it in migration 100's own postapply block**,
which runs against the real database and rolls the migration back on failure. Same discipline as the
`phase3/README.md` note about ACLs: this is a better model, not a substitute.

`phase3/README.md`'s other warning applies unchanged — a locally measured ACL is a floor, not the
production state.
