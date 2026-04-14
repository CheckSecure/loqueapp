import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { MessageSquare } from 'lucide-react'
import NetworkCard from '@/components/NetworkCard'
import MarkNetworkNotificationsRead from '@/components/MarkNetworkNotificationsRead'

export const metadata = { title: 'Network | Andrel' }

export default async function NetworkPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profileRows } = await supabase
    .from('profiles')
    .select('id')
    .or(`id.eq.${user.id},email.eq.${user.email}`)
    .limit(1)

  const profileId = profileRows?.[0]?.id ?? user.id

  const { data: matches } = await supabase
    .from('matches')
    .select('id, user_a_id, user_b_id, matched_at')
    .or(`user_a_id.eq.${profileId},user_b_id.eq.${profileId}`)

  const matchedUserIds = (matches || []).map((m: any) =>
    m.user_a_id === profileId ? m.user_b_id : m.user_a_id
  )

  // Get unread connection notifications to identify new connections
  const { data: unreadNotifs } = await supabase
    .from('notifications')
    .select('body')
    .eq('user_id', profileId)
    .in('type', ['intro_accepted', 'new_connection'])
    .is('read_at', null)

  // Extract names from notification bodies: "You're now connected with [Name]"
  const newConnectionNames = new Set(
    (unreadNotifs || [])
      .map((n: any) => {
        const match = n.body?.match(/You're now connected with ([^.]+)/)
        return match ? match[1].trim() : null
      })
      .filter(Boolean)
  )

  let profileMap: Record<string, any> = {}
  if (matchedUserIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, title, company, location, bio, role_type, avatar_url')
      .in('id', matchedUserIds)
    for (const p of profiles || []) profileMap[p.id] = p
  }

  const connections = (matches || []).map((m: any) => {
    const otherId = m.user_a_id === profileId ? m.user_b_id : m.user_a_id
    const profile = profileMap[otherId]
    return {
      matchId: m.id,
      profile,
      connectedAt: m.matched_at,
      isNew: profile ? newConnectionNames.has(profile.full_name) : false
    }
  }).filter((c: any) => c.profile)

  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <MarkNetworkNotificationsRead userId={profileId} />
      <div className="max-w-4xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Network</h1>
          <p className="text-slate-500 text-sm mt-0.5">Your confirmed introductions — people you've been connected with through Andrel.</p>
        </div>

        {connections.length === 0 ? (
          <div className="bg-white border border-slate-100 rounded-xl p-12 text-center shadow-sm">
            <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <MessageSquare className="w-6 h-6 text-slate-400" />
            </div>
            <p className="text-sm font-semibold text-slate-700 mb-1">No connections yet</p>
            <p className="text-xs text-slate-400 max-w-xs mx-auto">Once Andrel facilitates an introduction, your connections will appear here.</p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {connections.map(({ matchId, profile, connectedAt, isNew }: any) => (
              <NetworkCard
                key={matchId}
                matchId={matchId}
                profile={profile}
                connectedAt={connectedAt}
                isNew={isNew}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
