import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Plus, Search, Star, Briefcase, MapPin, Users, Inbox } from 'lucide-react'
import IntroductionActions from '@/components/IntroductionActions'

export const metadata = { title: 'Introductions | Cadre' }

export default async function IntroductionsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const firstName = ((await supabase.from('profiles').select('full_name').eq('id', user.id).single()).data?.full_name as string)?.split(' ')[0] || 'there'

  // Pending intro requests where I'm the target
  const { data: pending } = await supabase
    .from('introductions')
    .select('id, message, created_at, requester:profiles!requester_id(id, full_name, role, company, avatar_color)')
    .eq('target_id', user.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  // IDs I've already requested or received from
  const { data: myIntros } = await supabase
    .from('introductions')
    .select('requester_id, target_id')
    .or(`requester_id.eq.${user.id},target_id.eq.${user.id}`)

  const connectedIds = new Set([
    user.id,
    ...(myIntros || []).map(i => i.requester_id),
    ...(myIntros || []).map(i => i.target_id),
  ])

  // Suggested profiles: other open users not yet connected
  const { data: suggestions } = await supabase
    .from('profiles')
    .select('id, full_name, role, company, location, expertise, avatar_color')
    .eq('open_to_intros', true)
    .not('id', 'in', `(${[...connectedIds].join(',')})`)
    .limit(6)

  return (
    <div className="p-6 md:p-8 pt-20 md:pt-8">
      <div className="max-w-4xl">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Introductions</h1>
            <p className="text-slate-500 text-sm mt-0.5">Warm connections curated for you, {firstName}.</p>
          </div>
        </div>

        {/* Pending requests */}
        {(pending && pending.length > 0) && (
          <div className="mb-8">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
              Pending requests · {pending.length}
            </h2>
            <div className="space-y-3">
              {pending.map((p: any) => {
                const req = p.requester
                const daysAgo = Math.floor((Date.now() - new Date(p.created_at).getTime()) / 86400000)
                return (
                  <div key={p.id} className="bg-white border border-amber-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
                    <div className="flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-full ${req.avatar_color || 'bg-indigo-500'} flex items-center justify-center text-white text-xs font-bold`}>
                        {req.full_name?.split(' ').map((n: string) => n[0]).slice(0,2).join('').toUpperCase() || '?'}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{req.full_name || 'Unknown'}</p>
                        <p className="text-xs text-slate-500">{[req.role, req.company].filter(Boolean).join(' at ') || 'No title yet'}</p>
                        {p.message && <p className="text-xs text-slate-400 mt-0.5 italic">"{p.message}"</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400">{daysAgo === 0 ? 'Today' : `${daysAgo}d ago`}</span>
                      <IntroductionActions introId={p.id} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Search */}
        <div className="relative mb-6">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search professionals by name, role, or company..."
            className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
          />
        </div>

        {/* Suggestions */}
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Suggested for you</h2>
        {(!suggestions || suggestions.length === 0) ? (
          <div className="bg-white border border-slate-100 rounded-xl p-12 text-center shadow-sm">
            <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Inbox className="w-6 h-6 text-slate-400" />
            </div>
            <p className="text-sm font-semibold text-slate-700 mb-1">No suggestions yet</p>
            <p className="text-xs text-slate-400">As more people join Cadre, you'll see introduction suggestions here.</p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {suggestions.map((s: any) => (
              <div key={s.id} className="bg-white border border-slate-100 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-full ${s.avatar_color || 'bg-indigo-500'} flex items-center justify-center text-white text-sm font-bold flex-shrink-0`}>
                    {s.full_name?.split(' ').map((n: string) => n[0]).slice(0,2).join('').toUpperCase() || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-900 truncate">{s.full_name || 'New member'}</p>
                    {(s.role || s.company) && (
                      <div className="flex items-center gap-1 text-xs text-slate-500">
                        <Briefcase className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{[s.role, s.company].filter(Boolean).join(' at ')}</span>
                      </div>
                    )}
                    {s.location && (
                      <div className="flex items-center gap-1 text-xs text-slate-400">
                        <MapPin className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{s.location}</span>
                      </div>
                    )}
                  </div>
                </div>
                {s.expertise && s.expertise.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {s.expertise.slice(0, 4).map((tag: string) => (
                      <span key={tag} className="text-xs bg-slate-50 text-slate-600 border border-slate-100 px-2 py-0.5 rounded-full">{tag}</span>
                    ))}
                  </div>
                )}
                <RequestIntroButton targetId={s.id} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function RequestIntroButton({ targetId }: { targetId: string }) {
  return (
    <form action={async () => {
      'use server'
      const { requestIntroduction } = await import('@/app/actions')
      await requestIntroduction(targetId)
    }}>
      <button type="submit" className="w-full text-xs font-semibold bg-indigo-600 text-white py-1.5 rounded-lg hover:bg-indigo-700 transition-colors">
        Request intro
      </button>
    </form>
  )
}
