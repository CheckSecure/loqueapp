import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { Briefcase, MapPin, Inbox, Star, Sparkles, Clock } from 'lucide-react'
import IntroductionActions from '@/components/IntroductionActions'
import AdminIntroCard from '@/components/AdminIntroCard'
import WithdrawInterestButton from '@/components/WithdrawInterestButton'
import IntroductionCard from '@/components/IntroductionCard'
import HideSuggestionButton from '@/components/HideSuggestionButton'
import RequestIntroButton from '@/components/RequestIntroButton'
import { Avatar as UIAvatar } from '@/components/ui/Avatar'
import { Pill } from '@/components/ui/Pill'
import { EmptyState } from '@/components/ui/EmptyState'

export const metadata = { title: 'Introductions | Andrel' }

// Avatar helpers moved to components/ui/Avatar (Phase 0 primitive).

function Tag({ children, color = 'slate' }: { children: React.ReactNode; color?: string }) {
  const styles: Record<string, string> = {
    slate:  'bg-slate-50 text-slate-600 border-slate-100',
    indigo: 'bg-brand-cream text-brand-navy border-brand-navy/10',
    violet: 'bg-slate-50 text-slate-600 border-slate-100',
    emerald:'bg-brand-gold-soft text-brand-gold border-brand-gold/20',
    amber:  'bg-amber-50 text-amber-700 border-amber-100',
  }
  return (
    <span className={`text-xs border px-2 py-0.5 rounded-full ${styles[color] || styles.slate}`}>
      {children}
    </span>
  )
}

function Avatar({ profile, size = 'md' }: { profile: any; size?: 'sm' | 'md' }) {
  // On mobile use md (48px); on sm+ jump to lg (64px) for more presence.
  return (
    <>
      <span className="sm:hidden">
        <UIAvatar
          id={profile.id}
          name={profile.full_name}
          src={profile.avatar_url}
          size={size === 'sm' ? 'sm' : 'md'}
        />
      </span>
      <span className="hidden sm:inline-block">
        <UIAvatar
          id={profile.id}
          name={profile.full_name}
          src={profile.avatar_url}
          size={size === 'sm' ? 'sm' : 'lg'}
        />
      </span>
    </>
  )
}

export default async function IntroductionsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profileRows } = await supabase
    .from('profiles')
    .select('id, full_name, email, subscription_tier, is_founding_member')
    .or(`id.eq.${user.id},email.eq.${user.email}`)
    .limit(1)

  const profileRow = profileRows?.[0] ?? null
  const profileId = profileRow?.id ?? user.id
  const firstName = profileRow?.full_name?.split(' ')[0] || 'there'
  const userTier = (profileRow as any)?.subscription_tier ?? 'free'
  const isPaid = userTier !== 'free'
  const tierCap = (profileRow as any)?.is_founding_member ? 5
    : userTier === 'executive' ? 8
    : userTier === 'professional' ? 5
    : userTier === 'free' ? 3
    : 3

  // Get all existing matches for this user
  const { data: existingMatches } = await supabase
    .from('matches')
    .select('user_a_id, user_b_id')
    .or(`user_a_id.eq.${profileId},user_b_id.eq.${profileId}`)

  const matchedUserIds = new Set(
    (existingMatches || []).flatMap((m: any) => 
      [m.user_a_id, m.user_b_id].filter(id => id !== profileId)
    )
  )

  // Suggested intro requests (onboarding recommendations for this user)
  const { data: suggestedIntros } = await supabase
    .from('intro_requests')
    .select('id, target_user_id, created_at, match_reason, target:profiles!target_user_id(id, full_name, title, company, location, bio, interests, seniority, role_type, avatar_url)')
    .eq('requester_id', profileId)
    .eq('status', 'suggested')
    .order('created_at', { ascending: false })

  // Admin-curated intros (where this user is the TARGET and intro is admin_pending)
  const { data: adminIntrosRaw } = await supabase
    .from('intro_requests')
    .select('id, requester_id, target_user_id, status, created_at, is_admin_initiated, other:profiles!requester_id(id, full_name, title, company, location, bio, seniority, role_type, avatar_url)')
    .eq('target_user_id', profileId)
    .eq('is_admin_initiated', true)
    .in('status', ['admin_pending', 'approved'])
    .order('created_at', { ascending: false })

  // For each admin intro, check if the reverse intro (other user's side) is already approved
  const adminIntros = await Promise.all((adminIntrosRaw || []).map(async (intro: any) => {
    const { data: reverse } = await supabase
      .from('intro_requests')
      .select('status')
      .eq('requester_id', intro.target_user_id)
      .eq('target_user_id', intro.requester_id)
      .eq('is_admin_initiated', true)
      .in('status', ['admin_pending', 'approved', 'declined'])
      .maybeSingle()
    // Show admin_pending (user needs to decide) OR approved (user accepted, waiting on other)
    if (intro.status !== 'admin_pending' && intro.status !== 'approved') return null
    // Hide once the other side declines (silent decline per spec)
    if (reverse?.status === 'declined') return null
    // If both are approved, match has (or will be) created — drop from intros list
    if (intro.status === 'approved' && reverse?.status === 'approved') return null
    return {
      ...intro,
      userAlreadyAccepted: intro.status === 'approved',
      otherAlreadyApproved: reverse?.status === 'approved'
    }
  }))

  const adminIntrosFiltered = adminIntros.filter(Boolean)

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

  // Already expressed interest (across all batches)
  const { data: existingRequests } = await supabase
    .from('intro_requests')
    .select('target_user_id, created_at')
    .eq('requester_id', user.id)
    .order('created_at', { ascending: false })

  const requestedIds = new Set((existingRequests || []).map((r: any) => r.target_user_id))

  // All batch suggestions with their interest status - EXCLUDE MATCHED USERS
  const allSuggestionIds = (newRows || [])
    .map((r: any) => r.suggested_id)
    .filter((id: string) => id && !matchedUserIds.has(id))

  // Sidecar: collect all other-party IDs and find which are not active (catches deactivated + flagged)
  const allOtherPartyIds = Array.from(new Set([
    ...(adminIntrosRaw || []).map((i: any) => i.requester_id),
    ...(suggestedIntros || []).map((i: any) => i.target_user_id),
    ...allSuggestionIds,
  ]))
  const deactivatedIds = new Set<string>()
  if (allOtherPartyIds.length > 0) {
    const { data: statusRows } = await supabase
      .from('profiles')
      .select('id, account_status')
      .in('id', allOtherPartyIds)
      .neq('account_status', 'active')
    for (const r of statusRows || []) deactivatedIds.add(r.id)
  }

  const adminIntrosVisible = adminIntrosFiltered.filter(
    (intro: any) => !deactivatedIds.has(intro.requester_id)
  )

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


  const suggestedProfiles = (suggestedIntros || [])
    .filter((intro: any) => intro.target && !matchedUserIds.has(intro.target.id) && !deactivatedIds.has(intro.target.id))
    .map((intro: any) => ({
      rowId: intro.id,
      profile: intro.target,
      reason: intro.match_reason || 'Curated introduction',
      alreadyRequested: false,
      fromOnboarding: true
    }))

  // All suggestions with their state (batch + onboarding)
  const batchSuggestions = allSuggestionIds
    .filter((id: string) => !deactivatedIds.has(id))
    .map((id: string) => ({
      rowId: rowMap[id]?.id,
      profile: profileMap[id],
      reason: rowMap[id]?.reason,
      alreadyRequested: requestedIds.has(id),
      fromOnboarding: false
    }))
    .filter((r: any) => r.profile)

  const allSuggestions = Array.from(
    new Map(
      [...suggestedProfiles, ...batchSuggestions]
        .filter((item: any) => item?.profile?.id)
        .map((item: any) => [item.profile.id, item])
    ).values()
  ).slice(0, tierCap)


  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <div className="max-w-4xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Introductions</h1>
          <p className="text-slate-500 text-sm mt-0.5">Your curated introductions, {firstName}.</p>
        </div>

        {/* Tier banner */}
        {!isPaid && (
          <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3 bg-brand-gold-soft border border-brand-gold/20 rounded-xl px-4 py-3">
            <div className="flex items-center gap-3 min-w-0">
              <Pill variant="gold" dot>Free</Pill>
              <span className="text-xs text-slate-600 truncate">Upgrade for priority matching and more introductions</span>
            </div>
            <a href="/dashboard/billing" className="text-xs font-semibold text-brand-navy hover:underline flex-shrink-0">Upgrade &rarr;</a>
          </div>
        )}
        {isPaid && (
          <div className="mb-6 flex items-center gap-3 bg-brand-cream border border-brand-navy/10 rounded-xl px-4 py-3">
            <Pill variant="navy" dot><span className="capitalize">{userTier}</span></Pill>
            <span className="text-xs text-slate-500">Priority matching active</span>
          </div>
        )}


        {/* SECTION: Introduced by Andrel (admin-curated) — top priority */}
        {adminIntrosVisible.length > 0 && (
          <div className="mb-6 p-4 rounded-xl border border-brand-gold/30 bg-brand-gold/5">
            <h3 className="text-sm font-semibold text-brand-navy mb-3">Introduced by Andrel</h3>
            <div className="grid sm:grid-cols-2 gap-4">
              {adminIntrosVisible.map((intro: any) => (
                <AdminIntroCard
                  key={intro.id}
                  introRequestId={intro.id}
                  otherUser={intro.other}
                  otherAlreadyApproved={intro.otherAlreadyApproved}
                  userAlreadyAccepted={intro.userAlreadyAccepted}
                />
              ))}
            </div>
          </div>
        )}

        {/* SECTION 1 — This Week's Introductions */}
        <div className="mb-10">
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-4 mb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                This week's introductions{activeBatch ? <span className="text-slate-400 font-normal"> &middot; batch {activeBatch.batch_number}</span> : ''}
              </h2>
              <p className="text-sm text-slate-500 mt-1">Review and express interest &mdash; Andrel facilitates when there's strong mutual alignment.</p>
            </div>
            {allSuggestions.length > 0 && (
              <Pill variant="gold">{allSuggestions.length} new</Pill>
            )}
          </div>

          {allSuggestions.length === 0 ? (
            <EmptyState
              icon={<Inbox className="w-6 h-6 text-slate-400" />}
              title="Your next introduction is being curated"
              description="We'll notify you when there's a strong match worth your time."
            />
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
                  <IntroductionCard key={row.rowId || s.id} targetId={s.id} rowId={row.rowId}>
                    <div className="bg-white border border-slate-100 rounded-2xl p-6 shadow-sm hover:shadow-md hover:border-slate-200 transition-all flex flex-col gap-4">
                      <div className="flex items-start gap-3">
                        <Avatar profile={s} />
                        <div className="flex-1 min-w-0">
                          <p className="text-base font-semibold text-slate-900 truncate leading-tight">{s.full_name || 'New member'}</p>
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
                        <div className="flex items-start gap-2 bg-brand-gold-soft border border-brand-gold/20 rounded-lg px-3 py-2.5">
                          <Sparkles className="w-3.5 h-3.5 text-brand-gold flex-shrink-0 mt-0.5" />
                          <p className="text-xs text-slate-600 italic leading-relaxed">{row.reason}</p>
                        </div>
                      )}
                      {row.alreadyRequested ? (
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1.5">
                            <svg className="w-3 h-3 text-emerald-600" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/>
                            </svg>
                            <span className="text-xs font-medium text-emerald-700">Interest expressed</span>
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

      </div>
    </div>
  )
}
