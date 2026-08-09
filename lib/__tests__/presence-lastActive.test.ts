import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { formatLastActive, presenceForViewer, pickPresenceLabel, PRESENCE_ONLINE_MS } from '@/lib/presence/lastActive'

const NOW = Date.parse('2026-08-10T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000

describe('formatLastActive — labels + boundaries', () => {
  it('within 5 min → "Online now" with the green-dot flag', () => {
    expect(formatLastActive(ago(0), NOW)).toEqual({ label: 'Online now', isOnline: true })
    expect(formatLastActive(ago(4 * MIN), NOW)).toEqual({ label: 'Online now', isOnline: true })
    expect(PRESENCE_ONLINE_MS).toBe(5 * MIN)
  })
  it('5–59 min → "Active Xm ago" (neutral, not online)', () => {
    expect(formatLastActive(ago(5 * MIN), NOW)).toEqual({ label: 'Active 5m ago', isOnline: false })
    expect(formatLastActive(ago(12 * MIN), NOW)).toEqual({ label: 'Active 12m ago', isOnline: false })
    expect(formatLastActive(ago(59 * MIN), NOW)).toEqual({ label: 'Active 59m ago', isOnline: false })
  })
  it('1–23 h → "Active Xh ago"', () => {
    expect(formatLastActive(ago(HOUR), NOW)).toEqual({ label: 'Active 1h ago', isOnline: false })
    expect(formatLastActive(ago(3 * HOUR), NOW)).toEqual({ label: 'Active 3h ago', isOnline: false })
    expect(formatLastActive(ago(23 * HOUR), NOW)).toEqual({ label: 'Active 23h ago', isOnline: false })
  })
  it('previous calendar day (>24h) → "Active yesterday"; under 24h still uses hours', () => {
    expect(formatLastActive('2026-08-09T11:00:00Z', NOW)).toEqual({ label: 'Active yesterday', isOnline: false }) // ~25h → yesterday
    expect(formatLastActive('2026-08-09T23:59:00Z', NOW)).toEqual({ label: 'Active 12h ago', isOnline: false })   // 12h → hours branch wins
  })
  it('2–6 days → "Active Xd ago"', () => {
    expect(formatLastActive('2026-08-08T12:00:00Z', NOW)).toEqual({ label: 'Active 2d ago', isOnline: false })
    expect(formatLastActive('2026-08-05T09:00:00Z', NOW)).toEqual({ label: 'Active 5d ago', isOnline: false })
  })
  it('7+ days or unknown → no status (null)', () => {
    expect(formatLastActive('2026-08-03T12:00:00Z', NOW)).toBeNull() // 7 days
    expect(formatLastActive('2026-07-20T12:00:00Z', NOW)).toBeNull()
    expect(formatLastActive(null, NOW)).toBeNull()
    expect(formatLastActive(undefined, NOW)).toBeNull()
    expect(formatLastActive('not-a-date', NOW)).toBeNull()
  })
})

describe('presenceForViewer — privacy gate', () => {
  it('opted-out member is hidden from OTHER members (server-side)', () => {
    expect(presenceForViewer({ lastActiveAt: ago(MIN), showActivityStatus: false })).toBeNull()
  })
  it('visible member is shown to others', () => {
    expect(presenceForViewer({ lastActiveAt: ago(MIN), showActivityStatus: true })).toBe(ago(MIN))
  })
  it('a member always sees their OWN status, even opted out', () => {
    expect(presenceForViewer({ lastActiveAt: ago(MIN), showActivityStatus: false, viewerIsSelf: true })).toBe(ago(MIN))
  })
  it('null last-active → null regardless', () => {
    expect(presenceForViewer({ lastActiveAt: null, showActivityStatus: true })).toBeNull()
  })
})

// ── Structural: heartbeat safety, server-side gate, surfaces ───────────────────
describe('presence wiring (structural)', () => {
  const heartbeat = readFileSync('app/api/profile/heartbeat/route.ts', 'utf8')
  const pref = readFileSync('app/api/profile/activity-preference/route.ts', 'utf8')
  const netPage = readFileSync('app/dashboard/network/page.tsx', 'utf8')
  const modal = readFileSync('components/network/ConnectionDetailModal.tsx', 'utf8')
  const layout = readFileSync('app/dashboard/layout.tsx', 'utf8')
  const hb = readFileSync('components/PresenceHeartbeat.tsx', 'utf8')

  it('heartbeat identifies the member ONLY from the server session (never a client id)', () => {
    expect(heartbeat).toContain('supabase.auth.getUser()')
    expect(heartbeat).not.toMatch(/req\.json|body|memberId|userId/) // no client-supplied id
  })
  it('heartbeat writes ONLY to the private member_presence table, throttled + fail-silent', () => {
    expect(heartbeat).toContain('THROTTLE_MS')
    expect(heartbeat).toContain("from('member_presence')") // private, self-only-RLS store
    expect(heartbeat).not.toContain("from('profiles')")    // never the client-readable table
    expect(heartbeat).toMatch(/last_active_at:/)
    // no request headers / URL / IP / device data is read or stored
    expect(heartbeat).not.toContain('request.url')
    expect(heartbeat).not.toContain('headers(')
    expect(heartbeat).not.toMatch(/\.ip\b|x-forwarded-for|user-agent/i)
    // the write carries only presence columns — no url/ip/device/path/referrer
    expect(heartbeat).not.toMatch(/\b(url|ip|device|user_agent|path|referrer)\b\s*:/i)
    expect(heartbeat).toContain('catch') // fail-silent
  })
  it('the activity preference writes only the caller\'s own row and validates a boolean', () => {
    expect(pref).toContain('supabase.auth.getUser()')
    expect(pref).toContain(".eq('id', user.id)")
    expect(pref).toContain("typeof body?.show_activity_status !== 'boolean'")
  })
  it('the Network surface gets presence from the SECURITY DEFINER RPC, never the raw column', () => {
    expect(netPage).toContain('member_presence_labels')       // DB-enforced coarse-label RPC
    expect(netPage).not.toMatch(/\.select\([^)]*last_active_at/) // raw timestamp never selected
    expect(netPage).toContain('last_active_display')          // only the coarse label reaches the client
  })
  it('the expanded Network member view renders a LIVE badge seeded from the coarse label', () => {
    expect(modal).toContain('<LivePresenceBadge memberId={profile.id} initialLabel={(profile as any).last_active_display')
  })
  it('the dashboard layout heartbeat writes member_presence (not profiles) + mounts the client heartbeat', () => {
    expect(layout).toContain('<PresenceHeartbeat />')
    expect(layout).toContain("from('member_presence')")
    expect(layout).not.toMatch(/from\('profiles'\)[\s\S]{0,80}last_active_at/) // never touches profiles.last_active_at
    expect(hb).toContain('MIN_INTERVAL_MS')
    expect(hb).toContain('visibilitychange')
    expect(hb).toContain("fetch('/api/profile/heartbeat', { method: 'POST'")
  })
})

// ── Data-boundary privacy: the raw timestamp is NOT client-readable ────────────
// These assert the DB-level mechanism (private table + SECURITY DEFINER RPC), since a live
// Postgres/RLS instance isn't available in unit tests. The migration SQL IS the enforcement.
describe('presence privacy is enforced at the DATA boundary (expansion 046 + cleanup 048)', () => {
  const mig = readFileSync('supabase/migrations/046_member_presence_expansion.sql', 'utf8')
  const cleanup = readFileSync('supabase/migrations/048_drop_profiles_last_active_at.sql', 'utf8')

  it('member_presence is a dedicated table with RLS enabled', () => {
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS public\.member_presence/)
    expect(mig).toContain('ALTER TABLE public.member_presence ENABLE ROW LEVEL SECURITY')
  })
  it('the ONLY read policy is self-only (user_id = auth.uid()); no other-member SELECT exists', () => {
    // every SELECT policy on member_presence must be constrained to the caller's own row
    const selectPolicies = mig.match(/CREATE POLICY[\s\S]*?FOR SELECT[\s\S]*?;/gi) || []
    expect(selectPolicies.length).toBeGreaterThan(0)
    for (const p of selectPolicies) expect(p).toContain('user_id = auth.uid()')
    // there is no broad/other-member read policy
    expect(mig).not.toMatch(/FOR SELECT[\s\S]*?USING \(true\)/i)
  })
  it('other members are exposed ONLY a coarse label via a SECURITY DEFINER RPC that gates access', () => {
    expect(mig).toMatch(/FUNCTION public\.member_presence_labels/)
    expect(mig).toContain('SECURITY DEFINER')
    expect(mig).toMatch(/RETURNS TABLE \(member_id uuid, label text\)/) // label, never a timestamp
    // enforcement clauses live inside the function body
    expect(mig).toMatch(/viewer\s+uuid := auth\.uid\(\)/)
    expect(mig).toMatch(/IF viewer IS NULL THEN[\s\S]*?RETURN;/) // anonymous → nothing
    expect(mig).toContain('p.id = viewer')                       // self always allowed
    expect(mig).toContain('show_activity_status IS DISTINCT FROM false') // opt-out honored
    expect(mig).toContain('can_discover_profile(p.id)')          // relationship/discoverability
  })
  it('the SECURITY DEFINER RPC is hardened with a safe search_path + schema-qualified objects', () => {
    // both functions pin search_path so no object resolves via a caller-controlled path
    const labelFn = mig.slice(mig.indexOf('FUNCTION public.member_presence_labels'))
    expect(labelFn).toMatch(/SET search_path = pg_catalog, public/)
    const helperFn = mig.slice(mig.indexOf('FUNCTION public._presence_label'), mig.indexOf('FUNCTION public.member_presence_labels'))
    expect(helperFn).toMatch(/SET search_path = pg_catalog, public/)
    // referenced objects are schema-qualified
    expect(mig).toContain('public._presence_label(')
    expect(mig).toContain('public.profiles')
    expect(mig).toContain('public.member_presence')
    expect(mig).toContain('public.can_discover_profile(')
    expect(mig).toContain('pg_catalog.unnest(')
  })
  it('execution is revoked from PUBLIC/anon and granted only to authenticated', () => {
    expect(mig).toMatch(/REVOKE ALL ON FUNCTION public\.member_presence_labels\(uuid\[\]\) FROM PUBLIC/i)
    expect(mig).toMatch(/REVOKE ALL ON FUNCTION public\.member_presence_labels\(uuid\[\]\) FROM anon/)
    expect(mig).toMatch(/GRANT EXECUTE ON FUNCTION public\.member_presence_labels\(uuid\[\]\) TO authenticated/)
  })
  it('TABLE privileges are minimal: authenticated gets only SELECT/INSERT/UPDATE (no DELETE)', () => {
    expect(mig).toMatch(/REVOKE ALL ON TABLE public\.member_presence FROM PUBLIC/)
    expect(mig).toMatch(/REVOKE ALL ON TABLE public\.member_presence FROM anon/)
    expect(mig).toMatch(/REVOKE ALL ON TABLE public\.member_presence FROM authenticated/)
    expect(mig).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE public\.member_presence TO authenticated/)
    // never grant destructive/relational privileges to authenticated
    expect(mig).not.toMatch(/GRANT[^;]*\b(DELETE|TRUNCATE|REFERENCES|TRIGGER)\b[^;]*TO authenticated/)
  })
  it('the RPC bounds + de-duplicates its input to avoid resource abuse', () => {
    const fn = mig.slice(mig.indexOf('FUNCTION public.member_presence_labels'))
    expect(fn).toMatch(/max_ids constant int := 500/)          // conservative cap
    expect(fn).toMatch(/target_ids\[1:max_ids\]/)              // slice oversized input
    expect(fn).toMatch(/array_agg\(DISTINCT/)                   // de-duplicate ids
  })
  it('the Network caller also bounds the array it sends to the RPC', () => {
    const net = readFileSync('app/dashboard/network/page.tsx', 'utf8')
    expect(net).toMatch(/matchedUserIds\.slice\(0, 500\)/)
  })
  it('EXPANSION 046 backfills but does NOT drop the legacy column (backward-compatible)', () => {
    const guard = mig.slice(mig.indexOf('DO $$'))
    expect(guard).toMatch(/information_schema\.columns[\s\S]*?column_name = 'last_active_at'/) // guarded/re-runnable
    expect(guard).toMatch(/INSERT INTO public\.member_presence[\s\S]*?FROM public\.profiles/)  // backfill
    expect(mig).not.toMatch(/DROP COLUMN[\s\S]*?last_active_at/)                               // NOT dropped here
  })
  it('CLEANUP 048 drops the legacy column, guarded + idempotent (separate migration)', () => {
    expect(cleanup).toMatch(/information_schema\.columns[\s\S]*?column_name = 'last_active_at'/) // re-runnable guard
    expect(cleanup).toMatch(/ALTER TABLE public\.profiles DROP COLUMN last_active_at/)
  })
  it('no server code selects the raw profiles.last_active_at anymore (only member_presence)', () => {
    for (const f of [
      'app/dashboard/network/page.tsx',
      'app/dashboard/layout.tsx',
      'app/api/messages/send/route.ts',
      'app/api/cron/daily-digest/route.ts',
      'app/dashboard/admin/page.tsx',
    ]) {
      const src = readFileSync(f, 'utf8')
      // any last_active_at reference must be on member_presence, never a profiles select
      expect(src).not.toMatch(/from\('profiles'\)[\s\S]{0,120}last_active_at/)
    }
  })
})

// ── Smoke-test regression: "Online now" stays lit + failures are diagnosable ───
describe('presence keep-alive cadence + observability (post-deploy smoke-test fixes)', () => {
  const route = readFileSync('app/api/profile/heartbeat/route.ts', 'utf8')
  const hbc = readFileSync('components/PresenceHeartbeat.tsx', 'utf8')
  const layout = readFileSync('app/dashboard/layout.tsx', 'utf8')
  const net = readFileSync('app/dashboard/network/page.tsx', 'utf8')
  const evalMs = (src: string, name: string): number => {
    const m = src.match(new RegExp(name + '\\s*=\\s*([0-9*.\\s]+)'))
    if (!m) throw new Error('missing ' + name)
    return Function('return (' + m[1] + ')')() as number // controlled numeric literal
  }

  it('write cadence keeps an active member inside the "Online now" window (throttle-beat fix)', () => {
    const serverThrottle = evalMs(route, 'THROTTLE_MS')
    const clientInterval = evalMs(hbc, 'MIN_INTERVAL_MS')
    // Worst-case staleness before the next write = server throttle + one client ping interval.
    // It MUST stay under the online window or presence drops out of "Online now" while active.
    // (Regression: the old 5-min throttle + 4.5-min client ping summed to 9.5 min > 5 min.)
    expect(serverThrottle + clientInterval).toBeLessThan(PRESENCE_ONLINE_MS)
    // server throttle still respects the "≥2 min between writes" privacy bound
    expect(serverThrottle).toBeGreaterThanOrEqual(2 * 60 * 1000)
  })

  it('heartbeat surfaces the exact failing layer (privacy-safe) instead of swallowing it', () => {
    expect(route).toMatch(/writeError/)                 // upsert error is captured, not ignored
    expect(route).toMatch(/upsert failed/)              // and logged
    expect(route).toMatch(/read failed/)                // read error logged too
    expect(route).toMatch(/auth failed/)                // auth failure logged
    // PRIVACY: never log emails, URLs, IPs, user-agents, or browsing activity
    expect(route).not.toMatch(/\.email\b|request\.url|x-forwarded-for|user-agent|referer/i)
  })

  it('the layout write and Network RPC also log failures for diagnosability', () => {
    expect(layout).toMatch(/presence\.layout.*upsert failed/)
    expect(net).toMatch(/presenceError/)
    expect(net).toMatch(/labels rpc failed/)
    // no emails / member ids of others leaked into the RPC-error log
    expect(net).not.toMatch(/labels rpc failed[\s\S]{0,80}\.email/i)
  })
})

// ── Live modal refresh: label survives mapping; null clears the badge ──────────
describe('pickPresenceLabel — coarse-label extraction from the /api/presence/label response', () => {
  it('returns the coarse label keyed by member_id (no snake/camel rename can drop it)', () => {
    expect(pickPresenceLabel({ labels: { B: 'Online now' } }, 'B')).toBe('Online now')
    expect(pickPresenceLabel({ labels: { B: 'Active 12m ago' } }, 'B')).toBe('Active 12m ago')
  })
  it('null / no-row / empty / non-string → null (badge disappears: offline or opt-out)', () => {
    expect(pickPresenceLabel({ labels: { B: null } }, 'B')).toBeNull()   // opted-out / offline
    expect(pickPresenceLabel({ labels: {} }, 'B')).toBeNull()             // no row
    expect(pickPresenceLabel({ labels: { B: '' } }, 'B')).toBeNull()
    expect(pickPresenceLabel({ labels: { B: 12345 } }, 'B')).toBeNull()   // never a raw timestamp/number
    expect(pickPresenceLabel({}, 'B')).toBeNull()
    expect(pickPresenceLabel(null, 'B')).toBeNull()
  })
})

describe('LivePresenceBadge — refresh lifecycle (structural; jsdom unavailable in this repo)', () => {
  const live = readFileSync('components/presence/LivePresenceBadge.tsx', 'utf8')
  const modalSrc = readFileSync('components/network/ConnectionDetailModal.tsx', 'utf8')
  it('fetches the COARSE label on open via the privacy-filtered route, seeded from the server label', () => {
    expect(live).toContain('initialLabel')                                   // seed from page-load snapshot
    expect(live).toMatch(/fetch\(`\/api\/presence\/label\?ids=/)             // refresh from the route (RPC-gated)
    expect(live).toContain("cache: 'no-store'")                              // never a stale cached label
    expect(live).toContain('pickPresenceLabel(')                             // map response → label (null clears)
  })
  it('polls ~60s while open, pauses when hidden, and STOPS on modal close (cleanup)', () => {
    expect(live).toMatch(/POLL_MS\s*=\s*60 \* 1000/)
    expect(live).toContain('setInterval(refresh, POLL_MS)')
    expect(live).toContain('visibilitychange')
    expect(live).toContain('clearInterval')                                  // stops on unmount (modal close)
    expect(live).toMatch(/visibilityState === 'hidden'/)                     // pause polling when tab hidden
  })
  it('fails silently and never exposes a raw timestamp to the client', () => {
    expect(live).toMatch(/catch\s*\{/)                                       // request failure doesn't break the modal
    expect(live).not.toMatch(/last_active_at|toISOString|Date\.parse/)       // only coarse labels client-side
    // the modal mounts it live, seeded from the server snapshot
    expect(modalSrc).toContain('<LivePresenceBadge memberId={profile.id}')
  })
})

// ── ISSUE 2 regression: admin + profile career-history read one source ─────────
describe('career-history surfaces read the SAME authoritative source (admin ↔ profile)', () => {
  const adminPage = readFileSync('app/dashboard/admin/members/page.tsx', 'utf8')
  const profilePage = readFileSync('app/dashboard/profile/[id]/page.tsx', 'utf8')

  it('both admin and public profile read profile_roles via the shared profileRoles module', () => {
    expect(adminPage).toMatch(/listRolesForProfiles\(createAdminClient\(\)/) // service-role (owner-only RLS)
    expect(profilePage).toContain('listRoles(')
  })
  it('neither surface applies a divergent is_current / category filter before display', () => {
    // The discrepancy must not come from one surface hiding rows the other shows.
    expect(adminPage).not.toMatch(/\.filter\([^)]*is_current/)
    expect(profilePage).not.toMatch(/\.filter\([^)]*is_current/)
    expect(profilePage).not.toMatch(/\.filter\([^)]*role_category/)
  })
})
