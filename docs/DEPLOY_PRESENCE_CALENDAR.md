# Deployment — Member presence + automatic calendar invitations

Zero-downtime (expand/contract) rollout for two features:
- **Presence** — member online/last-active status, privacy-enforced at the data boundary.
- **Calendar invitations** — RFC 5545 invites emailed on meeting confirmation, with durable
  cancellation.

## Required migrations (dependency order)

| Migration | Provides | Depends on |
|-----------|----------|------------|
| `044_profiles_show_activity_status.sql` | `profiles.show_activity_status` (opt-out) | — |
| `045_meeting_calendar_invites.sql` | `meetings.calendar_sequence` + `meeting_calendar_invites` table | — |
| `046_member_presence_expansion.sql` | private `member_presence` table (self-only RLS) + `member_presence_labels()` coarse-label RPC + backfill. **Leaves `profiles.last_active_at` intact.** | 044 |
| `047_calendar_invite_payload.sql` | `meeting_calendar_invites.payload` (durable retry) | **045** |
| `048_drop_profiles_last_active_at.sql` | **CLEANUP** — drops the legacy `profiles.last_active_at` column | 046 **+ new code deployed & verified** |

> **045 is not optional.** 047 adds a column to the table 045 creates, and the accept/delete
> calendar blocks fail open (send nothing) without it. All five migrations are registered in
> `lib/db/migrationHealth.ts`, so the admin banner + `/api/admin/migration-health` flag any that
> are unapplied — including 048 as an *inverted* probe (pending while the legacy column lingers).

## Exact deployment order

**Expansion phase (backward-compatible — old code keeps working):**
1. Apply, in order, **044 → 045 → 046 → 047**.
2. **Verify** (see queries below): tables/columns exist, RLS policies present, RPC granted to
   `authenticated` only, backfill count matches.
3. **Commit + push** the application code together with all five migration files.
4. **Wait** for the production deploy to finish.
5. **Smoke test** with two throwaway test accounts (see below). Do **not** use real members.
6. **Confirm** the new code neither reads nor writes `profiles.last_active_at` (grep / the
   `migration-health` inverted probe will still show 048 pending — expected at this point).

**Cleanup phase (contract — only after the above is green):**
7. Apply **048** to drop `profiles.last_active_at`.
8. **Re-run** `migration-health` (048 now clears) and repeat the presence smoke test.

Rollback: if step 5 fails, redeploy the previous app version — it still works because the legacy
column is intact until step 7. Do **not** run 048 until the new version is verified.

## Verification queries (step 2)

```sql
-- table + RLS
select relrowsecurity from pg_class where relname = 'member_presence';           -- expect: t
select policyname, cmd, qual from pg_policies where tablename = 'member_presence';-- 3 self-only policies (user_id = auth.uid())
-- RPC grants: authenticated only, never anon/public
select grantee, privilege_type from information_schema.role_routine_grants
  where routine_name = 'member_presence_labels';                                  -- expect: authenticated / EXECUTE only
-- backfill parity (run BEFORE 048)
select (select count(*) from profiles where last_active_at is not null) as src,
       (select count(*) from member_presence) as dst;                             -- dst >= src
-- calendar base (045) + payload (047)
select column_name from information_schema.columns
  where table_name = 'meeting_calendar_invites';                                  -- includes payload
select column_name from information_schema.columns
  where table_name = 'meetings' and column_name = 'calendar_sequence';            -- exists
```

## Smoke-test plan (two test accounts A + B, connected)

**Presence**
- A (opted-in) shows a coarse status (e.g. "Online now" / "Active 12m ago") to B in B's Network
  expanded view.
- A toggles **Settings → "Show when I'm active" off** → B sees no status.
- Direct client attempt as B: `supabase.from('member_presence').select('*').eq('user_id', A)`
  returns **no row** (self-only RLS). `select('last_active_at')` on `profiles` for A returns
  nothing (column gone after 048; not selectable before).
- Anonymous `rpc('member_presence_labels', ...)` returns nothing.
- Heartbeat: A's activity updates only A's `member_presence` row, never another member's.

**Calendar** (mocked/real per environment — do not email real members)
- Confirm one meeting A↔B → both receive an invite with the **same UID**
  `andrel-meeting-<id>@andrel.app`, `METHOD:REQUEST`, `SEQUENCE:0`.
- Reschedule + re-confirm → same UID, `SEQUENCE` incremented, `METHOD:REQUEST`.
- Cancel → same UID, `METHOD:CANCEL` / `STATUS:CANCELLED`, `SEQUENCE` incremented.
- No duplicate invites on retries/double-clicks (durable `meeting_calendar_invites` claim).
- The manual **Add to calendar** download still works (shared ICS builder).
