import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Briefcase, MapPin, Inbox, Star, Sparkles, Clock } from 'lucide-react'
import IntroductionActions from '@/components/IntroductionActions'
import WithdrawInterestButton from '@/components/WithdrawInterestButton'
import IntroductionCard from '@/components/IntroductionCard'
import RequestIntroButton from '@/components/RequestIntroButton'

export const metadata = { title: 'Introductions | Andrel' }

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

function Avatar({ profile, size = 'md' }: { profile: any; size?: 'sm' | 'md' }) {
  const avatarColor = pickColor(profile.id)
  const initials = getInitials(profile.full_name)
  const sizeClass = size === 'sm' ? 'w-9 h-9 text-xs' : 'w-11 h-11 text-sm'
  return profile.avatar_url ? (
    <img src={profile.avatar_url} alt={profile.full_name} className={`${sizeClass} rounded-full object-cover flex-shrink-0`} />
  ) : (
    <div className={`${sizeClass} rounded-full ${avatarColor} flex items-center justify-center text-white font-bold flex-shrink-0`}>
      {initials}
    </div>
  )
}

export default async function IntroductionsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profileRows } = await supabase
    .from('profiles')
    .select('id, full_name, email, subscription_tier')
    .or(`id.eq.${user.id},email.eq.${user.email}`)
    .limit(1)

  const profileRow = profileRows?.[0] ?? null
  const profileId = profileRow?.id ?? user.id
  const firstName = profileRow?.full_name?.split(' ')[0] || 'there'
  const userTier = (profileRow as any)?.subscription_tier ?? 'free'
  const isPaid = userTier !== 'free'

  // Pending intro requests where I'm the target
  const { data: pending } = await supabase
    .from('intro_requests')
    .select('id, note, created_at, requester:profiles!requester_id(id, full_name, title, company, avatar_url)')
    .eq('target_user_id', profileId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  // Active batch
  const { data: activeBatchRows } = await supabase
    .from('introduction_batches')
    .select('id, batch_number')
    .eq('status', 'active')
    .limit(1)

  const activeBatch = activeBatchRows?.[0] ?? null

  // This week's suggestions (not yet acted on)
  const { data: newRows, error: batchError } = activeBatch
    ? await supabase
        .from('batch_suggestions')
        .select('id, suggested_id, reason')
        .eq('batch_id', activeBatch.id)
        .eq('recipient_id', profileId)
        .not('status', 'in', '(passed,hidden_permanent)')
    : { data: [], error: null }

  // Already expressed interest (across all batches) - exclude rescinded
  const { data: existingRequests } = await supabase
    .from('intro_requests')
    .select('target_user_id, created_at')
    .eq('requester_id', user.id)
    .in('status', ['pending', 'approved', 'batched'])
    .order('created_at', { ascending: false })

  const requestedIds = new Set((existingRequests || []).map((r: any) => r.target_user_id))

  // All batch suggestions with their interest status
  const allSuggestionIds = (newRows || []).map((r: any) => r.suggested_id).filter(Boolean)

  // Fetch all profiles needed
  let profileMap: Record<string, any> = {}
  if (allSuggestionIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, title, company, location, bio, interests, seniority, role_type, mentorship_role, avatar_url')
      .in('id', allSuggestionIds)
    for (const p of profiles || []) profileMap[p.id] = p
  }

  const rowMap: Record<string, any> = {}
  for (const r of newRows || []) rowMap[r.suggested_id] = r

  // All suggestions with their state
  const allSuggestions = allSuggestionIds
    .map((id: string) => ({ 
      rowId: rowMap[id]?.id, 
      profile: profileMap[id], 
      reason: rowMap[id]?.reason,
      alreadyRequested: requestedIds.has(id)
    }))
    .filter((r: any) => r.profile)


  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <div className="max-w-4xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Introductions</h1>
          <p className="text-slate-500 text-sm mt-0.5">Your curated introductions, {firstName}.</p>
        </div>

        {/* Tier banner */}
        {!isPaid && (
          <div className="mb-6 flex items-center justify-between bg-[#FDF3E3] border border-[#C4922A]/20 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-[#C4922A] uppercase tracking-wide">Free</span>
              <span className="text-xs text-slate-500">· Upgrade for priority matching and more introductions</span>
            </div>
            <a href="/dashboard/billing" className="text-xs font-semibold text-[#1B2850] hover:underline flex-shrink-0">Upgrade →</a>
          </div>
        )}
        {isPaid && (
          <div className="mb-6 flex items-center gap-2 bg-[#F5F6FB] border border-[#1B2850]/10 rounded-xl px-4 py-3">
            <span className="text-xs font-semibold text-[#1B2850] uppercase tracking-wide capitalize">{userTier}</span>
            <span className="text-xs text-slate-400">· Priority matching active</span>
          </div>
        )}

        {/* Pending requests from others */}
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
                  <div key={p.id} className="bg-white border border-amber-200 rounded-xl p-4 shadow-sm flex flex-col gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar profile={req} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-slate-900 truncate">{req.full_name || 'Unknown'}</p>
                        <p className="text-xs text-slate-500 truncate">
                          {[req.title, req.company].filter(Boolean).join(' at ') || 'No title yet'}
                        </p>
                        {p.note && <p className="text-xs text-slate-400 mt-0.5 italic line-clamp-2">"{p.note}"</p>}
                      </div>
                      <span className="text-xs text-slate-400 flex-shrink-0">{daysAgo === 0 ? 'Today' : `${daysAgo}d ago`}</span>
                    </div>
                    <div className="flex items-center gap-2 border-t border-amber-100 pt-2.5">
                      <IntroductionActions introId={p.id} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* SECTION 1 — This Week's Introductions */}
        <div className="mb-10">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                This Week's Introductions{activeBatch ? ` · Batch ${activeBatch.batch_number}` : ''}
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">Review and express interest — Andrel facilitates when there's strong mutual alignment.</p>
            </div>
            {allSuggestions.length > 0 && (
              <span className="text-xs text-slate-400">{allSuggestions.length} new</span>
            )}
          </div>

          {allSuggestions.length === 0 ? (
            <div className="bg-white border border-slate-100 rounded-xl p-12 text-center shadow-sm">
              <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Inbox className="w-6 h-6 text-slate-400" />
              </div>
              <p className="text-sm font-semibold text-slate-700 mb-1">
                {!activeBatch ? 'No active batch right now' : 'You have reviewed all introductions this week'}
              </p>
              <p className="text-xs text-slate-400">
                {!activeBatch
                  ? 'Your next batch of introductions will appear here once it goes live.'
                  : 'Check back next week for your next curated batch.'}
              </p>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-4">
              {allSuggestions.map((row: any) => {
                const s = row.profile
                const interests = Array.isArray(s.interests)
                  ? s.interests
                  : typeof s.interests === 'string' && s.interests
                    ? s.interests.split(',').map((i: string) => i.trim()).filter(Boolean)
                    : []
                return (
                  <IntroductionCard key={row.rowId || s.id} targetId={s.id}>
                    <div className="bg-white border border-slate-100 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-3">
                      <div className="flex items-start gap-3">
                        <Avatar profile={s} />
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
                      {s.bio && <p className="text-xs text-slate-500 leading-relaxed line-clamp-3">{s.bio}</p>}
                      <div className="flex flex-wrap gap-1.5">
                        {s.seniority && <Tag color="indigo">{s.seniority}</Tag>}
                        {s.role_type && <Tag color="violet">{s.role_type}</Tag>}
                        {s.mentorship_role && <Tag color="emerald"><span className="flex items-center gap-1"><Star className="w-2.5 h-2.5" />{s.mentorship_role}</span></Tag>}
                      </div>
                      {interests.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {interests.slice(0, 5).map((tag: string) => <Tag key={tag}>{tag}</Tag>)}
                        </div>
                      )}
                      {row.reason && (
                        <div className="flex items-start gap-2 bg-[#FDF3E3] border border-[#C4922A]/20 rounded-lg px-3 py-2.5">
                          <Sparkles className="w-3.5 h-3.5 text-[#C4922A] flex-shrink-0 mt-0.5" />
                          <p className="text-xs text-slate-600 italic leading-relaxed">{row.reason}</p>
                        </div>
                      )}
                      {row.alreadyRequested ? (
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 text-xs text-emerald-600 font-medium">
                            <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></span>
                            Interest expressed
                          </div>
                          <WithdrawInterestButton targetId={s.id} />
                        </div>
                      ) : (
                        <RequestIntroButton targetId={s.id} alreadyRequested={false} rowId={row.rowId} userTier={userTier} />
                      )}
                    </div>
                  </IntroductionCard>
                )
              })}
            </div>
          )}
        </div>

        {/* SECTION 2 — Pending Introductions */}
        {pendingSuggestions.length > 0 && (
          <div>
            <div className="mb-3">
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Under Review</h2>
              <p className="text-xs text-slate-400 mt-0.5">Andrel reviews these introductions and facilitates when there is strong alignment.</p>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              {pendingSuggestions.map((row: any) => {
                const s = row.profile
                return (
                  <div key={s.id} className="bg-white border border-slate-100 rounded-xl p-5 shadow-sm flex flex-col gap-3 opacity-80">
                    <div className="flex items-start gap-3">
                      <Avatar profile={s} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-slate-900 truncate">{s.full_name || 'New member'}</p>
                        {(s.title || s.company) && (
                          <div className="flex items-center gap-1 text-xs text-slate-500 mt-0.5">
                            <Briefcase className="w-3 h-3 flex-shrink-0" />
                            <span className="truncate">{[s.title, s.company].filter(Boolean).join(' at ')}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    {s.bio && <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">{s.bio}</p>}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2 bg-[#F5F6FB] border border-slate-100 rounded-lg px-3 py-2.5 flex-1">
                        <Clock className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                        <div>
                          <p className="text-xs font-semibold text-slate-600">Under review</p>
                          <p className="text-xs text-slate-400">Andrel is reviewing this introduction. We facilitate based on alignment, not direct requests.</p>
                        </div>
                      </div>
                      <WithdrawInterestButton targetId={s.id} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
