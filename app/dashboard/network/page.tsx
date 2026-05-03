import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { MessageSquare } from 'lucide-react'
import NetworkCard from '@/components/NetworkCard'
import MarkNetworkNotificationsRead from '@/components/MarkNetworkNotificationsRead'
import { generateMatchInsights } from '@/lib/matching/matchInsights'

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

  // Fetch matches, blocks, and notifications in parallel
  const [
    { data: rawMatches },
    { data: blocks },
    { data: unreadNotifs },
  ] = await Promise.all([
    supabase
      .from('matches')
      .select('id, user_a_id, user_b_id, matched_at, status, removed_at')
      .or(`user_a_id.eq.${profileId},user_b_id.eq.${profileId}`),
    supabase
      .from('blocked_users')
      .select('user_id, blocked_user_id')
      .or(`user_id.eq.${profileId},blocked_user_id.eq.${profileId}`),
    supabase
      .from('notifications')
      .select('body')
      .eq('user_id', profileId)
      .in('type', ['intro_accepted', 'new_connection'])
      .is('read_at', null),
  ])

  // Filter out removed matches from network view
  const activeMatches = (rawMatches || []).filter((m: any) => m.status !== 'removed')

  const blockedIds = new Set<string>()
  for (const b of blocks || []) {
    if (b.user_id === profileId) blockedIds.add(b.blocked_user_id)
    else blockedIds.add(b.user_id)
  }

  const matches = activeMatches.filter((m: any) => {
    const otherId = m.user_a_id === profileId ? m.user_b_id : m.user_a_id
    return !blockedIds.has(otherId)
  })

  const matchedUserIds = matches.map((m: any) =>
    m.user_a_id === profileId ? m.user_b_id : m.user_a_id
  )

  // Extract names from notification bodies: "You're now connected with [Name]"
  const newConnectionNames = new Set(
    (unreadNotifs || [])
      .map((n: any) => {
        const match = n.body?.match(/You're now connected with ([^.]+)/)
        return match ? match[1].trim() : null
      })
      .filter(Boolean)
  )

  // Fetch matched-user profiles and own profile in parallel
  let profileMap: Record<string, any> = {}
  const [{ data: matchedProfiles }, { data: selfProfile }] = await Promise.all([
    matchedUserIds.length > 0
      ? supabase
          .from('profiles')
          .select('id, full_name, title, company, location, city, state, bio, role_type, seniority, avatar_url, purposes, intro_preferences, interests, expertise, open_to_mentorship, open_to_business_solutions, linkedin_url, account_status')
          .in('id', matchedUserIds)
      : Promise.resolve({ data: [] as any[], error: null }),
    supabase
      .from('profiles')
      .select('id, full_name, title, company, bio, seniority, role_type, purposes, intro_preferences, interests, expertise, open_to_mentorship')
      .eq('id', profileId)
      .maybeSingle(),
  ])
  for (const p of matchedProfiles || []) profileMap[p.id] = p

  // Fetch conversations keyed by match_id so cards can link directly
  const matchIdList = matches.map((m: any) => m.id)
  const { data: matchConversations } = matchIdList.length > 0
    ? await supabase.from('conversations').select('id, match_id').in('match_id', matchIdList)
    : { data: [] }
  const conversationByMatchId: Record<string, string> = {}
  for (const c of (matchConversations || [])) {
    conversationByMatchId[c.match_id] = c.id
  }

  const connections = (matches || []).map((m: any) => {
    const otherId = m.user_a_id === profileId ? m.user_b_id : m.user_a_id
    const profile = profileMap[otherId]
    let matchInsights: { text: string; kind: string }[] = []
    if (profile && selfProfile) {
      try {
        matchInsights = generateMatchInsights(selfProfile, profile)
      } catch (e) {
        matchInsights = []
      }
    }
    return {
      matchId: m.id,
      profile,
      connectedAt: m.matched_at,
      isNew: profile ? newConnectionNames.has(profile.full_name) : false,
      matchInsights,
      conversationId: conversationByMatchId[m.id] || null
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
            {connections.map(({ matchId, profile, connectedAt, isNew, matchInsights, conversationId }: any) => (
              <NetworkCard
                key={matchId}
                matchId={matchId}
                profile={profile}
                connectedAt={connectedAt}
                isNew={isNew}
                matchInsights={matchInsights}
                conversationId={conversationId}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
