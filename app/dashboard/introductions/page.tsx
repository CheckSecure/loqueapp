import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Search, Briefcase, MapPin, Inbox } from 'lucide-react'
import pool from '@/lib/db'
import IntroductionActions from '@/components/IntroductionActions'
import RequestIntroButton from '@/components/RequestIntroButton'

export const metadata = { title: 'Introductions | Cadre' }

export default async function IntroductionsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { rows: profileRows } = await pool.query(
    'SELECT full_name FROM profiles WHERE id = $1',
    [user.id]
  )
  const firstName = profileRows[0]?.full_name?.split(' ')[0] || 'there'

  // Pending intro requests where I'm the target
  const { rows: pending } = await pool.query(
    `SELECT i.id, i.message, i.created_at,
            p.id as req_id, p.full_name as req_name, p.role as req_role,
            p.company as req_company, p.avatar_color as req_color
     FROM introductions i
     JOIN profiles p ON p.id = i.requester_id
     WHERE i.target_id = $1 AND i.status = 'pending'
     ORDER BY i.created_at DESC`,
    [user.id]
  )

  // IDs already connected (to exclude from suggestions)
  const { rows: myIntros } = await pool.query(
    `SELECT requester_id, target_id FROM introductions
     WHERE requester_id = $1 OR target_id = $1`,
    [user.id]
  )
  const connectedIds = new Set([
    user.id,
    ...myIntros.map((r: any) => r.requester_id),
    ...myIntros.map((r: any) => r.target_id),
  ])
  const excludeList = [...connectedIds]

  // Suggested profiles
  const { rows: suggestions } = await pool.query(
    `SELECT id, full_name, role, company, location, expertise, avatar_color
     FROM profiles
     WHERE open_to_intros = true
       AND id != ALL($1::uuid[])
     LIMIT 6`,
    [excludeList]
  )

  return (
    <div className="p-6 md:p-8 pt-20 md:pt-8">
      <div className="max-w-4xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Introductions</h1>
          <p className="text-slate-500 text-sm mt-0.5">Warm connections curated for you, {firstName}.</p>
        </div>

        {/* Pending requests */}
        {pending.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
              Pending requests · {pending.length}
            </h2>
            <div className="space-y-3">
              {pending.map((p: any) => {
                const daysAgo = Math.floor((Date.now() - new Date(p.created_at).getTime()) / 86400000)
                const initials = p.req_name?.split(' ').map((n: string) => n[0]).slice(0,2).join('').toUpperCase() || '?'
                return (
                  <div key={p.id} className="bg-white border border-amber-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
                    <div className="flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-full ${p.req_color || 'bg-indigo-500'} flex items-center justify-center text-white text-xs font-bold`}>
                        {initials}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{p.req_name || 'Unknown'}</p>
                        <p className="text-xs text-slate-500">
                          {[p.req_role, p.req_company].filter(Boolean).join(' at ') || 'No title yet'}
                        </p>
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
        {suggestions.length === 0 ? (
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
