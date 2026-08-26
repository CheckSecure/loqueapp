import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getAuthUser } from '@/lib/supabase/authUser'
import { getOpportunityBadgeCount } from '@/lib/opportunities/unreadCount'
import { needsReacceptance } from '@/lib/legal/terms'
import { redirect } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import MobileNav from '@/components/MobileNav'
// Resolved HERE, on the server, where the session is already known. Every surface this layout
// renders — dashboard and admin alike — is behind the auth guard below, so the wordmark
// destination is a constant the client is handed rather than something it has to ask about.
import { AUTHENTICATED_LOGO_HREF } from '@/lib/nav/logoHref'
import Tutorial from '@/components/Tutorial'
import FloatingHelp from '@/components/FloatingHelp'
import PresenceHeartbeat from '@/components/PresenceHeartbeat'
import MainScrollReset from '@/components/MainScrollReset'

import type { Metadata } from 'next'

/**
 * NOINDEX for every member surface under /dashboard, including /dashboard/admin.
 *
 * The route is already auth-gated in middleware.ts, so a crawler cannot read its content — but an
 * unauthenticated fetch returns a redirect to /login, and without this the URL itself could still be
 * indexed from an external link. /dashboard is therefore deliberately NOT disallowed in robots.txt:
 * blocking the fetch would stop a crawler ever seeing this directive. Two response-delivered signals
 * carry it — this metadata and the X-Robots-Tag header in next.config.js — and both depend on the
 * request being allowed. Authentication, not robots, is the privacy boundary.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
}

const AVATAR_COLORS = [
  'bg-[#1B2850]','bg-[#2E4080]','bg-amber-500','bg-rose-500',
  'bg-cyan-600','bg-teal-600','bg-pink-500','bg-slate-600',
]

function pickColor(id: string) {
  const n = id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient()
  // Deduped, server-validated auth — shares ONE getUser() network round-trip with
  // the page this layout renders (React cache), instead of each calling getUser.
  const user = await getAuthUser()
  if (!user) redirect('/login')

  const ADMIN_EMAIL = 'bizdev91@gmail.com'
  const isAdmin = user.email === ADMIN_EMAIL

  const perfLog = process.env.PERF_LOG === '1'
  const tData = perfLog ? Date.now() : 0

  // ONE concurrent fan-out for EVERYTHING the shell needs: the gate reads
  // (onboarding + clickwrap), display fields, credits, and every badge run
  // together, so the common (no-redirect) path costs a single round-trip of depth
  // instead of three serial `profiles` reads followed by a separate badge wave.
  // Gate decisions are evaluated AFTER the fan-out (redirects must run outside any
  // try/catch so their NEXT_REDIRECT signal isn't swallowed); the handful of
  // read-only queries a to-be-redirected user triggers are harmless.
  //
  // The clickwrap read is its OWN query that resolves to null on any error, so an
  // unapplied acceptance migration fails open without breaking the onboarding gate
  // or the display fields. Each badge keeps its own error isolation (→ 0); only the
  // genuinely dependent chains stay ordered internally (the unread-message
  // match → conversation → message chain, and getOpportunityBadgeCount).
  const [
    { data: profile },
    acceptance,
    { data: creditRow, error: creditError },
    unreadCount,
    networkNotifCount,
    meetingNotifCount,
    opportunityBadgeCount,
    adminBadgeCount,
    presenceRow,
  ] = await Promise.all([
    // A3: both are SELF reads. Server component → read the caller's OWN row via service_role scoped to
    // user.id (base-table SELECT is revoked for the browser/authenticated role; the legal-acceptance
    // fields are not in the minimal self RPC allowlist, so admin is the right server-side path here).
    createAdminClient().from('profiles').select('profile_complete, full_name, avatar_url').eq('id', user.id).single(),
    createAdminClient()
      .from('profiles')
      .select('terms_version_accepted, privacy_version_accepted, terms_grandfathered_through_version, privacy_grandfathered_through_version')
      .eq('id', user.id).single().then((r) => r.data as any, () => null),
    supabase.from('meeting_credits').select('balance').eq('user_id', user.id).single(),

    // Unread message count — dependent 3-hop chain, isolated so a failure
    // anywhere yields 0 without affecting the other badges.
    (async (): Promise<number> => {
      try {
        const { data: matchRows } = await supabase
          .from('matches')
          .select('id')
          .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`)

        const matchIds = (matchRows || []).map((r: any) => r.id)
        if (matchIds.length === 0) return 0

        const { data: convRows } = await supabase
          .from('conversations')
          .select('id')
          .in('match_id', matchIds)

        const convIds = (convRows || []).map((r: any) => r.id)
        if (convIds.length === 0) return 0

        const { count, error } = await supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .in('conversation_id', convIds)
          .neq('sender_id', user.id)
          .eq('is_system', false)
          .is('read_at', null)

        if (!error) {
          return count ?? 0
        }

        const { count: fallbackCount } = await supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .in('conversation_id', convIds)
          .neq('sender_id', user.id)
          .eq('is_system', false)
        return fallbackCount ?? 0
      } catch {
        return 0
      }
    })(),

    // Network notification count (unread intro_accepted / new_connection)
    (async (): Promise<number> => {
      try {
        const { count } = await supabase
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .in('type', ['intro_accepted', 'new_connection'])
          .is('read_at', null)
        return count ?? 0
      } catch {
        return 0
      }
    })(),

    // Meeting notification count (unread meeting-related notifications)
    (async (): Promise<number> => {
      try {
        const { count } = await supabase
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .in('type', ['meeting_request', 'meeting_accepted', 'meeting_declined'])
          .is('read_at', null)
        return count ?? 0
      } catch {
        return 0
      }
    })(),

    // Opportunity badge — sum of:
    //   receiver side: active, non-responded, non-dismissed For You opportunities
    //   creator side: interested responses waiting on action across active signals
    (async (): Promise<number> => {
      try {
        const admin = createAdminClient()
        const { total } = await getOpportunityBadgeCount(admin, user.id)
        return total
      } catch {
        return 0
      }
    })(),

    // Admin badge — waitlist pending + issue reports new (admin only)
    (async (): Promise<number> => {
      if (!isAdmin) return 0
      try {
        const adminSupa = createAdminClient()
        const [{ count: wl }, { count: iss }] = await Promise.all([
          adminSupa.from('waitlist').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
          adminSupa.from('issue_reports').select('id', { count: 'exact', head: true }).eq('status', 'new'),
        ])
        return (wl ?? 0) + (iss ?? 0)
      } catch {
        return 0
      }
    })(),

    // Presence throttle read — folded into the fan-out so it adds NO serial latency to the
    // render path. Reads the member's OWN row from the private member_presence table (self
    // RLS). Fails open to null if migration 046 isn't applied yet.
    supabase.from('member_presence').select('last_active_at').eq('user_id', user.id).maybeSingle()
      .then((r) => r.data as { last_active_at: string | null } | null, () => null),
  ])

  if (perfLog) {
    // eslint-disable-next-line no-console
    console.log(`[perf] dashboard layout data (getUser + fan-out) = ${Date.now() - tData}ms`)
  }

  // Redirect gates — evaluated after the fan-out, OUTSIDE any try/catch so the
  // NEXT_REDIRECT signal from redirect() propagates.
  //
  // Onboarding gate (non-admin): a member with no profile / an unstarted profile
  // goes to onboarding.
  if (!isAdmin) {
    const needsOnboarding = !profile || (!profile.profile_complete && !profile.full_name)
    if (needsOnboarding) redirect('/onboarding')
  }

  // Clickwrap gate: accepted or grandfathered through the CURRENT versions, else
  // to /legal/accept (outside /dashboard → no loop). `acceptance` is null when the
  // migration is unapplied, which fails open.
  if (acceptance && needsReacceptance({
    acceptedTermsVersion: acceptance.terms_version_accepted,
    acceptedPrivacyVersion: acceptance.privacy_version_accepted,
    grandfatheredTermsVersion: acceptance.terms_grandfathered_through_version,
    grandfatheredPrivacyVersion: acceptance.privacy_grandfathered_through_version,
  })) redirect('/legal/accept')

  const displayName = profile?.full_name || user.email?.split('@')[0] || 'You'
  const initials = displayName.split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase()
  const avatarColor = pickColor(user.id)
  const avatarUrl: string | null = (profile as any)?.avatar_url ?? null
  // A FAILED credits read is NOT a zero balance. meeting_credits RLS calls is_admin(); when that
  // helper was unexecutable (migration-059 incident) this read errored and `?? 0` rendered "No credits
  // remaining" as if authoritative. null = load failed (nav renders an unavailable state, never 0);
  // a genuinely-missing row (PGRST116) is a real 0. Any other error → null.
  const credits: number | null =
    creditError && (creditError as any).code !== 'PGRST116'
      ? null
      : (creditRow?.balance ?? 0)
  if (creditError && (creditError as any).code !== 'PGRST116') {
    console.error('[layout] credits read failed', { uid: user.id, code: (creditError as any).code, msg: (creditError as any).message })
  }

  // Throttled activity tracking — at most one write per 5 minutes per user. Writes go to
  // the PRIVATE member_presence table (self-only RLS), NOT profiles, so an opted-out
  // member's raw timestamp is never client-readable. Fire-and-forget: this write must never
  // block the render (and therefore the login navigation). The 5-minute throttle makes an
  // occasional dropped write self-correcting on the next request.
  const presenceThreshold = new Date(Date.now() - 3 * 60 * 1000)
  const lastActiveAt = presenceRow?.last_active_at
  if (!lastActiveAt || new Date(lastActiveAt) < presenceThreshold) {
    const nowIso = new Date().toISOString()
    void supabase
      .from('member_presence')
      .upsert({ user_id: user.id, last_active_at: nowIso, updated_at: nowIso }, { onConflict: 'user_id' })
      .then(
        ({ error }) => { if (error) console.error('[presence.layout] upsert failed', { uid: user.id, code: error.code, msg: error.message }) },
        () => {},
      )
  }

  return (
    <>
      <Tutorial />
      <MainScrollReset />
      <MobileNav credits={credits} unreadCount={unreadCount} meetingNotifCount={meetingNotifCount} opportunityBadgeCount={opportunityBadgeCount} adminBadgeCount={adminBadgeCount} logoHref={AUTHENTICATED_LOGO_HREF} />
      <div className="dashboard-shell min-h-screen md:flex bg-[#FAF6EE]">
        <Sidebar
          displayName={displayName}
          email={user.email || ''}
          initials={initials}
          avatarColor={avatarColor}
          avatarUrl={avatarUrl}
          credits={credits}
          unreadCount={unreadCount}
          networkNotifCount={networkNotifCount}
          meetingNotifCount={meetingNotifCount}
          opportunityBadgeCount={opportunityBadgeCount}
          adminBadgeCount={adminBadgeCount}
          logoHref={AUTHENTICATED_LOGO_HREF}
        />
        <main id="dashboard-main" className="flex-1 min-w-0 md:h-full md:min-h-0 md:overflow-y-auto overflow-x-hidden pb-[env(safe-area-inset-bottom)] md:pb-0">
          {children}
        </main>
      </div>
      <FloatingHelp />
      <PresenceHeartbeat />
    </>
  )
}
