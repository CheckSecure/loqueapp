import { createClient } from '@/lib/supabase/server'
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

  const { data: profile_check } = await supabase
    .from('profiles')
    .select('profile_complete')
    .eq('id', user.id)
    .single()

  if (!profile_check?.profile_complete) {
    redirect('/onboarding')
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

  // Unread message count — messages from others in the user's conversations
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
          .is('read_at', null)

        if (!error) {
          unreadCount = count ?? 0
        } else {
          const { count: fallbackCount } = await supabase
            .from('messages')
            .select('id', { count: 'exact', head: true })
            .in('conversation_id', convIds)
            .neq('sender_id', user.id)
          unreadCount = fallbackCount ?? 0
        }
      }
    }
  } catch {
    unreadCount = 0
  }

  return (
    <>
      <MobileNav credits={credits} unreadCount={unreadCount} />
      <div className="min-h-screen md:flex bg-slate-50">
        <Sidebar
          displayName={displayName}
          email={user.email || ''}
          initials={initials}
          avatarColor={avatarColor}
          avatarUrl={avatarUrl}
          credits={credits}
        />
        <main className="flex-1 min-w-0 overflow-x-hidden">
          {children}
        </main>
      </div>
    </>
  )
}
