# Demo Engagement Analytics

Lightweight tracking for the `/demo` page so we can measure Wave 1 outreach
engagement: which referral codes drive traffic, how many recipients actually
press play, and how many watch the demo to completion.

## What it captures

Three event types, one row each, in `public.demo_views`:

| event_type        | When it fires                                                       |
| ----------------- | ------------------------------------------------------------------- |
| `page_view`       | The `/demo` page unlocks (first time per tab session).              |
| `video_start`     | The user presses play on the demo video (first time per session).   |
| `video_complete`  | Playback reaches 90% of the video's duration (first time per session). |

Each row stores: `event_type`, `created_at`, anonymous `session_id` (random
UUID generated client-side, scoped to the tab session), optional `ref_code`
from the `?ref=` URL parameter (server-side sanitized to `[A-Za-z0-9_-]`,
max 64 chars), and the request `user_agent` (capped at 512 chars).

## What it does NOT capture

- No IP addresses (Vercel sees them at the platform layer; we don't read or persist them)
- No cookies (uses `sessionStorage` only)
- No email, name, or other identity
- No third-party analytics SDKs

The `session_id` cannot be linked back to a person and rotates whenever the
browser tab is closed.

## Referral URLs

Share a per-recipient URL by adding a `?ref=` query parameter:

```
https://andrel.app/demo?ref=david
https://andrel.app/demo?ref=sarah
https://andrel.app/demo?ref=gc-founder-01
```

The ref code is preserved across all three events fired during that session.

## Leaderboard query

Run this in the Supabase SQL Editor to see engagement by referral code:

```sql
select ref_code,
       count(*) filter (where event_type='page_view')     as views,
       count(*) filter (where event_type='video_start')   as starts,
       count(*) filter (where event_type='video_complete') as completes,
       min(created_at) as first_event,
       max(created_at) as last_event
from public.demo_views
group by ref_code
order by views desc;
```

Rows with `ref_code = null` represent direct visits (no `?ref=` parameter).

## Deployment

Schema is in `migrations/2026-06-04_demo_views.sql`. Apply it once by pasting
into the Supabase Dashboard SQL Editor — the repo migration file is
record-keeping only (see `docs/CREDIT_MIGRATION_PHASE_2.md` item 9 for the
prior-art note on this convention).

Between code deploy and schema application, `/api/demo/track` inserts will
fail with `relation "public.demo_views" does not exist`. The route swallows
this error and returns 204 regardless, so the gap is invisible to clients —
the only effect is lost rows for any visits during that window.
