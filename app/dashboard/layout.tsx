import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getAuthUser } from '@/lib/supabase/authUser'
import { getOpportunityBadgeCount } from '@/lib/opportunities/unreadCount'
import { needsReacceptance } from '@/lib/legal/terms'
import { redirect } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import MobileNav from '@/components/MobileNav'
import Tutorial from '@/components/Tutorial'
import FloatingHelp from '@/components/FloatingHelp'

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
    { data: creditRow },
    unreadCount,
    networkNotifCount,
    meetingNotifCount,
    opportunityBadgeCount,
    adminBadgeCount,
  ] = await Promise.all([
    supabase.from('profiles').select('profile_complete, full_name, avatar_url, last_active_at').eq('id', user.id).single(),
    supabase
      .from('profiles')
      .select('terms_version_accepted, privacy_version_accepted, terms_grandfathered_through_version, privacy_grandfathered_through_version')
      .eq('id', user.id)
      .single()
      .then((r) => r.data as any, () => null),
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
          supabase.from('waitlist').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
          adminSupa.from('issue_reports').select('id', { count: 'exact', head: true }).eq('status', 'new'),
        ])
        return (wl ?? 0) + (iss ?? 0)
      } catch {
        return 0
      }
    })(),
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
  const credits: number = creditRow?.balance ?? 0

  // Throttled activity tracking — at most one write per 5 minutes per user.
  // Fire-and-forget: this write must never block the render (and therefore the
  // login navigation). The 5-minute throttle makes an occasional dropped write
  // self-correcting on the next request.
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000)
  const lastActiveAt = (profile as any)?.last_active_at
  if (!lastActiveAt || new Date(lastActiveAt) < fiveMinAgo) {
    void supabase
      .from('profiles')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', user.id)
      .then(() => {}, () => {})
  }

  return (
    <>
      <Tutorial />
      <MobileNav credits={credits} unreadCount={unreadCount} meetingNotifCount={meetingNotifCount} opportunityBadgeCount={opportunityBadgeCount} adminBadgeCount={adminBadgeCount} />
      <div className="min-h-screen md:flex bg-[#FAF6EE]">
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
        />
        <main className="flex-1 min-w-0 overflow-x-hidden">
          {children}
        </main>
      </div>
      <FloatingHelp />
    </>
  )
}
