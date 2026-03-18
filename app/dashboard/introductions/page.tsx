import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Search, Briefcase, MapPin, Inbox, Star, Sparkles } from 'lucide-react'
import IntroductionActions from '@/components/IntroductionActions'
import RequestIntroButton from '@/components/RequestIntroButton'

export const metadata = { title: 'Introductions | Cadre' }

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

function Tag({ children, color = 'slate' }: { children: React.ReactNode; color?: string }) {
  const styles: Record<string, string> = {
    slate:  'bg-slate-50 text-slate-600 border-slate-100',
    indigo: 'bg-[#F5F6FB] text-[#1B2850] border-[#1B2850]/10',
    violet: 'bg-slate-50 text-slate-600 border-slate-100',
    emerald:'bg-[#FDF3E3] text-[#C4922A] border-[#C4922A]/20',
    amber:  'bg-amber-50 text-amber-700 border-amber-100',
  }
  return (
    <span className={`text-xs border px-2 py-0.5 rounded-full ${styles[color] || styles.slate}`}>
      {children}
    </span>
  )
}

export default async function IntroductionsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Look up the profile by auth id OR email to get the correct profile id
  const { data: profileRows } = await supabase
    .from('profiles')
    .select('id, full_name, email')
    .or(`id.eq.${user.id},email.eq.${user.email}`)
    .limit(1)

  const profileRow = profileRows?.[0] ?? null
  const profileId = profileRow?.id ?? user.id
  const firstName = profileRow?.full_name?.split(' ')[0] || 'there'

  // Pending intro requests where I'm the target (from introductions table)
  const { data: pending } = await supabase
    .from('introductions')
    .select('id, message, created_at, requester:profiles!requester_id(id, full_name, role, company)')
    .eq('target_id', profileId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  // Step 1: get the active batch — use limit(1) instead of single() to avoid coerce error
  const { data: activeBatchRows } = await supabase
    .from('introduction_batches')
    .select('id, batch_number')
    .eq('status', 'active')
    .limit(1)

  const activeBatch = activeBatchRows?.[0] ?? null
  const activeBatchNumber = activeBatch?.batch_number ?? null

  // Step 2: get suggestions for this user in the active batch using profileId
  const { data: batchRows, error: batchError } = activeBatch
    ? await supabase
        .from('batch_suggestions')
        .select('id, suggested_id, reason')
        .eq('batch_id', activeBatch.id)
        .eq('recipient_id', profileId)
    : { data: [], error: null }

  const suggestedIds = (batchRows || []).map((r: any) => r.suggested_id).filter(Boolean)

  // Fetch the full profiles for those suggested IDs
  let profileMap: Record<string, any> = {}
  if (suggestedIds.length > 0) {
    const { data: suggestedProfiles } = await supabase
      .from('profiles')
      .select('id, full_name, title, company, location, bio, interests, seniority, role_type, mentorship_role')
      .in('id', suggestedIds)
    for (const p of suggestedProfiles || []) {
      profileMap[p.id] = p
    }
  }

  const suggestions = (batchRows || [])
    .map((r: any) => ({ rowId: r.id, profile: profileMap[r.suggested_id], reason: r.reason }))
    .filter((r: any) => r.profile)

  return (
    <div className="p-6 md:p-8 pt-20 md:pt-8">
      <div className="max-w-4xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Introductions</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Your curated batch of introductions, {firstName}.
          </p>
        </div>

        {/* Pending requests */}
        {pending && pending.length > 0 && (
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
                      <div className={`w-9 h-9 rounded-full ${pickColor(req.id)} flex items-center justify-center text-white text-xs font-bold`}>
                        {getInitials(req.full_name)}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{req.full_name || 'Unknown'}</p>
                        <p className="text-xs text-slate-500">
                          {[req.role, req.company].filter(Boolean).join(' at ') || 'No title yet'}
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
            placeholder="Search by name, role, or company..."
            className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition"
          />
        </div>

        {/* Batch suggestions */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
            {activeBatchNumber != null
              ? `Your introductions · Batch ${activeBatchNumber}`
              : 'Your introductions'}
          </h2>
          {suggestions.length > 0 && (
            <span className="text-xs text-slate-400">{suggestions.length} match{suggestions.length !== 1 ? 'es' : ''}</span>
          )}
        </div>

        {suggestions.length === 0 ? (
          <div className="bg-white border border-slate-100 rounded-xl p-12 text-center shadow-sm">
            <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Inbox className="w-6 h-6 text-slate-400" />
            </div>
            <p className="text-sm font-semibold text-slate-700 mb-1">
              {!activeBatch ? 'No active batch right now' : 'No suggestions in this batch'}
            </p>
            <p className="text-xs text-slate-400">
              {batchError
                ? `Could not load suggestions: ${batchError.message}`
                : !activeBatch
                  ? 'Your next batch of introductions will appear here once it goes live.'
                  : 'Check back soon — your curated matches will show up here.'}
            </p>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-4">
            {suggestions.map((row: any) => {
              const s = row.profile
              const key = row.rowId || s.id
              const avatarColor = pickColor(s.id)
              const reason = row.reason as string | null | undefined
              const interests = Array.isArray(s.interests)
                ? s.interests
                : typeof s.interests === 'string' && s.interests
                  ? s.interests.split(',').map((i: string) => i.trim()).filter(Boolean)
                  : []

              return (
                <div
                  key={key}
                  className="bg-white border border-slate-100 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-3"
                >
                  {/* Header */}
                  <div className="flex items-start gap-3">
                    <div className={`w-11 h-11 rounded-full ${avatarColor} flex items-center justify-center text-white text-sm font-bold flex-shrink-0`}>
                      {getInitials(s.full_name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-900 truncate">{s.full_name || 'New member'}</p>
                      {(s.title || s.company) && (
                        <div className="flex items-center gap-1 text-xs text-slate-500 mt-0.5">
                          <Briefcase className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{[s.title, s.company].filter(Boolean).join(' at ')}</span>
                        </div>
                      )}
                      {s.location && (
                        <div className="flex items-center gap-1 text-xs text-slate-400 mt-0.5">
                          <MapPin className="w-3 h-3 flex-shrink-0" />
                          <span className="truncate">{s.location}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Bio */}
                  {s.bio && (
                    <p className="text-xs text-slate-500 leading-relaxed line-clamp-3">{s.bio}</p>
                  )}

                  {/* Badges */}
                  <div className="flex flex-wrap gap-1.5">
                    {s.seniority && <Tag color="indigo">{s.seniority}</Tag>}
                    {s.role_type && <Tag color="violet">{s.role_type}</Tag>}
                    {s.mentorship_role && (
                      <Tag color="emerald">
                        <span className="flex items-center gap-1">
                          <Star className="w-2.5 h-2.5" />
                          {s.mentorship_role}
                        </span>
                      </Tag>
                    )}
                  </div>

                  {/* Interests */}
                  {interests.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {interests.slice(0, 5).map((tag: string) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                    </div>
                  )}

                  {/* Why this match */}
                  {reason && (
                    <div className="flex items-start gap-2 bg-[#FDF3E3] border border-[#C4922A]/20 rounded-lg px-3 py-2.5">
                      <Sparkles className="w-3.5 h-3.5 text-[#C4922A] flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-slate-600 italic leading-relaxed">{reason}</p>
                    </div>
                  )}

                  <RequestIntroButton targetId={s.id} />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
