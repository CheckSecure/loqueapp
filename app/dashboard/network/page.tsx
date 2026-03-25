import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Briefcase, MapPin, MessageSquare, Calendar } from 'lucide-react'
import Link from 'next/link'

export const metadata = { title: 'Network | Andrel' }

const AVATAR_COLORS = [
  'bg-[#1B2850]','bg-[#2E4080]','bg-amber-500','bg-rose-500',
  'bg-cyan-600','bg-teal-600','bg-pink-500','bg-slate-600',
]

function pickColor(id: string) {
  const n = (id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}

function getInitials(name?: string) {
  return (name || '?').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()
}

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

  // Get confirmed matches
  const { data: matches } = await supabase
    .from('matches')
    .select('id, user_a_id, user_b_id, created_at')
    .or(`user_a_id.eq.${profileId},user_b_id.eq.${profileId}`)
    .order('created_at', { ascending: false })

  const matchedUserIds = (matches || []).map((m: any) =>
    m.user_a_id === profileId ? m.user_b_id : m.user_a_id
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
    return { matchId: m.id, profile: profileMap[otherId], connectedAt: m.created_at }
  }).filter((c: any) => c.profile)

  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
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
            {connections.map(({ matchId, profile, connectedAt }: any) => {
              const avatarColor = pickColor(profile.id)
              const initials = getInitials(profile.full_name)
              const connectedDate = new Date(connectedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
              return (
                <div key={matchId} className="bg-white border border-slate-100 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-4">
                  <div className="flex items-start gap-3">
                    {profile.avatar_url ? (
                      <img src={profile.avatar_url} alt={profile.full_name} className="w-11 h-11 rounded-full object-cover flex-shrink-0" />
                    ) : (
                      <div className={`w-11 h-11 rounded-full ${avatarColor} flex items-center justify-center text-white text-sm font-bold flex-shrink-0`}>
                        {initials}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-900">{profile.full_name}</p>
                      {(profile.title || profile.company) && (
                        <div className="flex items-center gap-1 text-xs text-slate-500 mt-0.5">
                          <Briefcase className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{[profile.title, profile.company].filter(Boolean).join(' at ')}</span>
                        </div>
                      )}
                      {profile.location && (
                        <div className="flex items-center gap-1 text-xs text-slate-400 mt-0.5">
                          <MapPin className="w-3 h-3 flex-shrink-0" />
                          <span>{profile.location}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {profile.bio && (
                    <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">{profile.bio}</p>
                  )}

                  <div className="text-xs text-slate-400">
                    Connected {connectedDate}
                  </div>

                  <div className="flex gap-2 pt-1 border-t border-slate-50">
                    <Link
                      href="/dashboard/messages"
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-[#1B2850] text-white text-xs font-semibold rounded-lg hover:bg-[#162040] transition-colors"
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                      Message
                    </Link>
                    <Link
                      href="/dashboard/meetings"
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border border-slate-200 text-slate-600 text-xs font-semibold rounded-lg hover:bg-slate-50 transition-colors"
                    >
                      <Calendar className="w-3.5 h-3.5" />
                      Schedule
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
