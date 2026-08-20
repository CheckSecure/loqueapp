# Security follow-up: over-broad anon/authenticated table grants

**Status: RECORDED, NOT IMPLEMENTED. Deliberately excluded from migration 063.**

Found by the read-only production `pg_catalog` audit (2026-08-19, PostgreSQL 17.6). None of these
grants was created by a repository migration — they are Supabase platform defaults that have never
been narrowed. They do **not** invalidate migration 063's security model, which is why remediation
is kept out of that change; but two of them are only one configuration change away from mattering.

## What the catalog shows

| Table | anon / authenticated hold | RLS | Policies | What actually denies access |
|---|---|---|---|---|
| `recommendation_batches` | **ALL** — `arwdDxtm`, incl. INSERT/UPDATE/DELETE/TRUNCATE | enabled | **0** | **RLS alone** |
| `blocked_users` | **ALL** — `arwdDxtm` | enabled | **0** | **RLS alone** |
| `intro_requests` | SELECT, REFERENCES, TRIGGER, **TRUNCATE** | enabled | 5 | grant revocation (055) **and** RLS |
| `matches` | SELECT, REFERENCES, TRIGGER, **TRUNCATE** | enabled | 5 | grant revocation (055) and RLS |
| `profiles` | DELETE, REFERENCES, TRIGGER, **TRUNCATE** (no SELECT — 058) | enabled | 6 | grant revocation and RLS |
| `member_pairs` | none | enabled | 0 | no grant at all |

Verified empirically: an anon `GET` against `recommendation_batches`, `blocked_users` and
`intro_requests` returns **HTTP 200 with `content-range: */0`** — the privilege is real, and RLS
returns no rows. `member_pairs` and `profiles` return `42501 permission denied`.

## The two findings worth acting on

### 1. `recommendation_batches` is protected by RLS alone

RLS is enabled with **zero policies**, which denies all non-owner rows. That is the only thing
standing between `anon`/`authenticated` and full DML on batch metadata. Disable RLS on that table,
or add a single permissive policy, and a member could insert or delete batch rows directly.

This is **not** a capacity bypass: cards live in `intro_requests`, where migration 055 already
revoked INSERT/UPDATE/DELETE from browser roles, and the caps are counted from card rows. The damage
would be to the one-active/one-queued batch invariant — `place_batch_rows` and `promote_queued_rows`
would start returning `inconsistent_batches` and generation would stall. A degradation, not an
over-issue. Migration 063 fails safe in that scenario rather than exceeding a cap.

### 2. `TRUNCATE` is granted to anon and authenticated on five tables

`intro_requests`, `recommendation_batches`, `blocked_users`, `matches`, `profiles`.

**RLS does not apply to TRUNCATE.** It is the one privilege on this list that row security cannot
contain. It is not reachable through PostgREST, which never issues TRUNCATE, so today it is latent
rather than live — it would require direct SQL access with one of those roles. It should still not
be granted.

## Proposed remediation — a separate migration, not 063

Narrow the grants to what each role actually needs, leaving RLS as defence in depth rather than as
the only defence:

```sql
-- SKETCH ONLY — not reviewed, not applied, not part of migration 063.
REVOKE TRUNCATE ON TABLE public.intro_requests, public.recommendation_batches,
                          public.blocked_users, public.matches, public.profiles
  FROM PUBLIC, anon, authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.recommendation_batches, public.blocked_users
  FROM PUBLIC, anon, authenticated;

-- service_role keeps everything it already has; no GRANT is added by this remediation.
```

Before running any of it, confirm what currently depends on those grants:

- `blocked_users` — the block/unblock UI writes blocks. Determine whether that path runs as
  `service_role` (server action) or as `authenticated` (browser). If the latter, revoking INSERT
  breaks blocking, and the write must move server-side first.
- `recommendation_batches` — no application path should be writing this as a browser role, but that
  must be confirmed, not assumed.
- Re-run the catalog audit afterwards and diff the `role_privileges` block.

## Why this is not in migration 063

Migration 063 replaces three functions and changes no grants and no rows. Mixing a privilege change
into it would make one reviewable unit into two, and would couple a capacity fix to a security change
with a different blast radius and a different rollback story. They are independent and should ship
independently.

## Also worth correcting when this is picked up

Migration 043's header comment states that "matches / intro_requests / blocked_users have NO grant".
The live catalog contradicts that for all three. The comment is stale and should be fixed alongside
this work so the next reader is not misled the way this one nearly was.
