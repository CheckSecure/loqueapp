import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getOpportunityBadgeCount } from '@/lib/opportunities/unreadCount'
import { redirect } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import MobileNav from '@/components/MobileNav'

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
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const ADMIN_EMAIL = 'bizdev91@gmail.com'

  if (user.email !== ADMIN_EMAIL) {
    const { data: profileCheck } = await supabase
      .from('profiles')
      .select('profile_complete, full_name')
      .eq('id', user.id)
      .single()

    const needsOnboarding = !profileCheck || (!profileCheck.profile_complete && !profileCheck.full_name)
    if (needsOnboarding) {
      redirect('/onboarding')
    }
  }

  const [{ data: profile }, { data: creditRow }] = await Promise.all([
    supabase.from('profiles').select('full_name, avatar_url').eq('id', user.id).single(),
    supabase.from('meeting_credits').select('balance').eq('user_id', user.id).single(),
  ])

  const displayName = profile?.full_name || user.email?.split('@')[0] || 'You'
  const initials = displayName.split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase()
  const avatarColor = pickColor(user.id)
  const avatarUrl: string | null = (profile as any)?.avatar_url ?? null
  const credits: number = creditRow?.balance ?? 0

  // Unread message count
  let unreadCount = 0
  try {
    const { data: matchRows } = await supabase
      .from('matches')
      .select('id')
      .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`)

    const matchIds = (matchRows || []).map((r: any) => r.id)

    if (matchIds.length > 0) {
      const { data: convRows } = await supabase
        .from('conversations')
        .select('id')
        .in('match_id', matchIds)

      const convIds = (convRows || []).map((r: any) => r.id)

      if (convIds.length > 0) {
        const { count, error } = await supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .in('conversation_id', convIds)
          .neq('sender_id', user.id)
          .eq('is_system', false)
          .is('read_at', null)

        if (!error) {
          unreadCount = count ?? 0
        } else {
          const { count: fallbackCount } = await supabase
            .from('messages')
            .select('id', { count: 'exact', head: true })
            .in('conversation_id', convIds)
            .neq('sender_id', user.id)
            .eq('is_system', false)
          unreadCount = fallbackCount ?? 0
        }
      }
    }
  } catch {
    unreadCount = 0
  }

  // Network notification count (unread intro_accepted notifications)
  let networkNotifCount = 0
  try {
    const { count } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .in('type', ['intro_accepted', 'new_connection'])
      .is('read_at', null)
    
    networkNotifCount = count ?? 0
  } catch {
    networkNotifCount = 0
  }

  // Meeting notification count (unread meeting-related notifications)
  let meetingNotifCount = 0
  try {
    const { count } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .in('type', ['meeting_request', 'meeting_accepted', 'meeting_declined'])
      .is('read_at', null)
    
    meetingNotifCount = count ?? 0
  } catch {
    meetingNotifCount = 0
  }

  // Opportunity badge — sum of:
  //   receiver side: active, non-responded, non-dismissed For You opportunities
  //   creator side: interested responses waiting on action across active signals
  let opportunityBadgeCount = 0
  try {
    const admin = createAdminClient()
    const { total } = await getOpportunityBadgeCount(admin, user.id)
    opportunityBadgeCount = total
  } catch {
    opportunityBadgeCount = 0
  }

  return (
    <>
      <MobileNav credits={credits} unreadCount={unreadCount} meetingNotifCount={meetingNotifCount} opportunityBadgeCount={opportunityBadgeCount} />
      <div className="min-h-screen md:flex bg-slate-50">
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
        />
        <main className="flex-1 min-w-0 overflow-x-hidden">
          {children}
        </main>
      </div>
    </>
  )
}
