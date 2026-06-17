import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Briefcase, MapPin, Inbox, Star, Sparkles, ChevronDown, ArrowRight, Send, Zap, Users } from 'lucide-react'
import IntroductionActions from '@/components/IntroductionActions'
import AdminIntroCard from '@/components/AdminIntroCard'
import WithdrawInterestButton from '@/components/WithdrawInterestButton'
import IntroductionCard from '@/components/IntroductionCard'
import HideSuggestionButton from '@/components/HideSuggestionButton'
import RequestIntroButton from '@/components/RequestIntroButton'
import EarlierIntroductionsBanner from '@/components/EarlierIntroductionsBanner'
import FoundingMemberWelcomeBanner from '@/components/FoundingMemberWelcomeBanner'
import PageHint from '@/components/PageHint'
import { Avatar as UIAvatar } from '@/components/ui/Avatar'
import { Pill } from '@/components/ui/Pill'
import { EmptyState } from '@/components/ui/EmptyState'
import { getEffectiveTier } from '@/lib/tier-override'
import { computeMatchSignals } from '@/lib/match-signals'
import TargetedRequestModalLauncher from '@/components/TargetedRequestModalLauncher'

export const metadata = { title: 'Introductions | Andrel' }

// Days after which a quiet in-app banner surfaces for untouched earlier introductions.
const STALE_INTRODUCTION_THRESHOLD_DAYS = 14

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

function Avatar({ profile, size = 'md' }: { profile: any; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <UIAvatar
      id={profile.id}
      name={profile.full_name}
      src={profile.avatar_url}
      size={size}
      enlargeable
    />
  )
}

// Pick the display string for a target's role line: prefer the exact_job_title
// (Phase D, free-text), fall back to legacy free-text title, then to the
// structured role_type. role_type is always a structured/legacy value (Phase D
// firewall); the matcher reads it; this is purely the display string.
function displayTitle(p: any): string | null {
  return p?.exact_job_title || p?.title || p?.role_type || null
}

export default async function IntroductionsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profileRows } = await supabase
    .from('profiles')
    .select('id, full_name, email, subscription_tier, is_founding_member, founding_member_expires_at, created_at, role_type, seniority, interests, mentorship_role, location, expertise, purposes')
    .or(`id.eq.${user.id},email.eq.${user.email}`)
    .limit(1)

  const profileRow = profileRows?.[0] ?? null
  const profileId = profileRow?.id ?? user.id
  const firstName = profileRow?.full_name?.split(' ')[0] || 'there'
  const userTier = (profileRow as any)?.subscription_tier ?? 'free'
  const effectiveTier = profileRow ? getEffectiveTier(profileRow) : 'free'
  const isPaid = userTier !== 'free'
  const isFoundingMember = Boolean(profileRow && effectiveTier === 'founding')
  const canCreateOpportunity = effectiveTier !== 'free'
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
  const profileCreatedAt = (profileRow as any)?.created_at
  const accountAgeMs = profileCreatedAt ? Date.now() - new Date(profileCreatedAt).getTime() : null
  const showFoundingWelcome = Boolean(
    isFoundingMember && accountAgeMs !== null && accountAgeMs < THIRTY_DAYS_MS
  )
  const tierCap = (profileRow as any)?.is_founding_member ? 3
    : userTier === 'executive' ? 8
    : userTier === 'professional' ? 5
    : userTier === 'free' ? 3
    : 3

  // Fetch all profile-scoped queries in parallel — all reads use the
  // user-scoped supabase client so RLS applies to the dashboard's reads
  // uniformly. opportunity_candidates appears RLS-protected (no policy file
  // in repo, but anon-probe returns 0 rows silently — consistent with an
  // existing RLS gate). If a user has rows and the policy allows their
  // SELECT, they render here; if not, the empty-state ("Opportunity
  // Concierge") shows — same state we observe for every real user today.
  const [
    { data: existingMatches },
    { data: suggestedIntros },
    { data: adminIntrosRaw },
    { data: userBatchRows },
    { data: existingRequests },
    { data: creditRow },
    { data: pendingTargetedRequest },
    { data: oppCandidateRows },
  ] = await Promise.all([
    supabase
      .from('matches')
      .select('user_a_id, user_b_id')
      .or(`user_a_id.eq.${profileId},user_b_id.eq.${profileId}`),
    supabase
      .from('intro_requests')
      .select('id, target_user_id, created_at, match_reason, target:profiles!target_user_id(id, full_name, title, exact_job_title, company, location, bio, interests, seniority, role_type, mentorship_role, avatar_url, expertise, purposes, account_status)')
      .eq('requester_id', profileId)
      .eq('status', 'suggested')
      .order('created_at', { ascending: false }),
    supabase
      .from('intro_requests')
      .select('id, requester_id, target_user_id, status, created_at, is_admin_initiated, other:profiles!requester_id(id, full_name, title, exact_job_title, company, location, bio, seniority, role_type, avatar_url, account_status)')
      .eq('target_user_id', profileId)
      .eq('is_admin_initiated', true)
      .in('status', ['admin_pending', 'approved'])
      .order('created_at', { ascending: false }),
    supabase
      .from('batch_suggestions')
      .select('batch_id, created_at')
      .eq('recipient_id', profileId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('intro_requests')
      .select('target_user_id, created_at')
      .eq('requester_id', user.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('meeting_credits')
      .select('balance, free_credits, premium_credits')
      .eq('user_id', user.id)
      .maybeSingle(),
    supabase
      .from('targeted_requests')
      .select('id, status, expires_at, created_at, role, industry')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle(),
    // Opportunities for this user (receiver side). Same query shape as
    // app/dashboard/opportunities/page.tsx:33-42 BUT via the user-scoped
    // client — RLS-policed, no service-role on member surface.
    supabase
      .from('opportunity_candidates')
      .select('id, opportunity_id, role, opportunities!inner(id, creator_id, type, title, description, urgency, status, expires_at, profiles!opportunities_creator_id_fkey(full_name, company))')
      .eq('user_id', user.id)
      .is('dismissed_at', null)
      .eq('opportunities.status', 'active')
      .order('shown_at', { ascending: false })
      .limit(3),
  ])

  const balance = creditRow?.balance ?? 0
  const premiumCredits = (creditRow as any)?.premium_credits ?? 0
  const hasPendingTargetedRequest = Boolean(pendingTargetedRequest)

  // Distinct batch_ids in DESC order — current is [0], prior is [1].
  const orderedBatchIds: string[] = []
  for (const row of userBatchRows || []) {
    if (row.batch_id && !orderedBatchIds.includes(row.batch_id)) {
      orderedBatchIds.push(row.batch_id)
      if (orderedBatchIds.length === 2) break
    }
  }
  const currentBatchId = orderedBatchIds[0] ?? null
  const priorBatchId = orderedBatchIds[1] ?? null

  // Untouched suggestions from the current + prior batch only.
  const visibleBatchIds = orderedBatchIds.filter(Boolean)
  const { data: visibleBatchRows } = visibleBatchIds.length > 0
    ? await supabase
        .from('batch_suggestions')
        .select('id, suggested_id, reason, batch_id, created_at')
        .in('batch_id', visibleBatchIds)
        .eq('recipient_id', profileId)
        .not('status', 'in', '(passed,hidden_permanent)')
    : { data: [] as any[] }

  let bannerDismissed = false
  if (currentBatchId) {
    const { data: dismissalRow } = await supabase
      .from('introduction_banner_dismissals')
      .select('batch_id')
      .eq('user_id', profileId)
      .eq('batch_id', currentBatchId)
      .maybeSingle()
    bannerDismissed = !!dismissalRow
  }

  const matchedUserIds = new Set(
    (existingMatches || []).flatMap((m: any) =>
      [m.user_a_id, m.user_b_id].filter(id => id !== profileId)
    )
  )

  // For each admin intro, check if the reverse intro is approved
  const adminIntros = await Promise.all((adminIntrosRaw || []).map(async (intro: any) => {
    const { data: reverse } = await supabase
      .from('intro_requests')
      .select('status')
      .eq('requester_id', intro.target_user_id)
      .eq('target_user_id', intro.requester_id)
      .eq('is_admin_initiated', true)
      .in('status', ['admin_pending', 'approved', 'declined'])
      .maybeSingle()
    if (intro.status !== 'admin_pending' && intro.status !== 'approved') return null
    if (reverse?.status === 'declined') return null
    if (intro.status === 'approved' && reverse?.status === 'approved') return null
    return {
      ...intro,
      userAlreadyAccepted: intro.status === 'approved',
      otherAlreadyApproved: reverse?.status === 'approved'
    }
  }))

  const adminIntrosFiltered = adminIntros.filter(Boolean)
  const requestedIds = new Set((existingRequests || []).map((r: any) => r.target_user_id))

  // Split visible batch suggestions into current vs prior, excluding matched users.
  const currentBatchRows = (visibleBatchRows || []).filter(
    (r: any) => r.batch_id === currentBatchId && r.suggested_id && !matchedUserIds.has(r.suggested_id)
  )
  const priorBatchRows = (visibleBatchRows || []).filter(
    (r: any) => r.batch_id === priorBatchId && r.suggested_id && !matchedUserIds.has(r.suggested_id)
  )

  const currentSuggestionIds = currentBatchRows.map((r: any) => r.suggested_id)
  const priorSuggestionIds = priorBatchRows.map((r: any) => r.suggested_id)

  // Read-side deactivated filter — drop targets whose account_status !== 'active'.
  // Operates on the joined-target profile in memory; NEVER mutates intro_requests rows.
  const allOtherPartyIds = Array.from(new Set([
    ...(adminIntrosRaw || []).map((i: any) => i.requester_id),
    ...(suggestedIntros || []).map((i: any) => i.target_user_id),
    ...currentSuggestionIds,
    ...priorSuggestionIds,
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

  // Fetch all profiles needed for the batch rendering
  const allBatchProfileIds = Array.from(new Set([...currentSuggestionIds, ...priorSuggestionIds]))
    .filter((id: string) => !deactivatedIds.has(id))
  let profileMap: Record<string, any> = {}
  if (allBatchProfileIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, title, exact_job_title, company, location, bio, interests, seniority, role_type, mentorship_role, avatar_url, expertise, purposes')
      .in('id', allBatchProfileIds)
    for (const p of profiles || []) profileMap[p.id] = p
  }

  const currentRowMap: Record<string, any> = {}
  for (const r of currentBatchRows) currentRowMap[r.suggested_id] = r
  const priorRowMap: Record<string, any> = {}
  for (const r of priorBatchRows) priorRowMap[r.suggested_id] = r

  const suggestedProfiles = (suggestedIntros || [])
    // Read-side filter: drop targets that are deactivated. The intro_requests row stays in DB.
    .filter((intro: any) => intro.target && !matchedUserIds.has(intro.target.id) && !deactivatedIds.has(intro.target.id))
    .map((intro: any) => ({
      rowId: intro.id,
      profile: intro.target,
      matchReason: intro.match_reason || null,
      alreadyRequested: false,
      fromOnboarding: true,
    }))

  const currentBatchEntries = currentSuggestionIds
    .filter((id: string) => !deactivatedIds.has(id))
    .map((id: string) => ({
      rowId: currentRowMap[id]?.id,
      profile: profileMap[id],
      matchReason: currentRowMap[id]?.reason || null,
      alreadyRequested: requestedIds.has(id),
      fromOnboarding: false,
    }))
    .filter((r: any) => r.profile)

  const allSuggestions = Array.from(
    new Map(
      [...suggestedProfiles, ...currentBatchEntries]
        .filter((item: any) => item?.profile?.id)
        .map((item: any) => [item.profile.id, item])
    ).values()
  ).slice(0, tierCap)

  // Featured = first; additional = rest. If allSuggestions is empty, neither renders.
  const featuredSuggestion = allSuggestions[0] ?? null
  const additionalSuggestions = allSuggestions.slice(1)

  // Earlier (prior batch, untouched, minus current)
  const currentIds = new Set(allSuggestions.map((s: any) => s.profile.id))
  const earlierSuggestions = priorSuggestionIds
    .filter((id: string) => !deactivatedIds.has(id) && !currentIds.has(id))
    .map((id: string) => ({
      rowId: priorRowMap[id]?.id,
      profile: profileMap[id],
      matchReason: priorRowMap[id]?.reason || null,
      alreadyRequested: requestedIds.has(id),
      fromOnboarding: false,
      createdAt: priorRowMap[id]?.created_at,
    }))
    .filter((r: any) => r.profile)

  const staleThresholdMs = STALE_INTRODUCTION_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
  const oldestEarlierMs = earlierSuggestions.length > 0
    ? Math.min(...earlierSuggestions.map((s: any) => new Date(s.createdAt).getTime()))
    : Infinity
  const showBanner = Boolean(
    currentBatchId
    && !bannerDismissed
    && earlierSuggestions.length > 0
    && Date.now() - oldestEarlierMs > staleThresholdMs
  )

  // Reason render: prefer stored match_reason (rich prose from generateIntroReason),
  // fall back to computeMatchSignals at render, fall back to generic.
  const renderReasonBlock = (row: any) => {
    if (row.matchReason && typeof row.matchReason === 'string' && row.matchReason.trim().length > 0) {
      return <p className="text-xs text-slate-600 leading-relaxed">{row.matchReason}</p>
    }
    const match = computeMatchSignals(profileRow, row.profile)
    if (match.hasStrongSignals && match.signals.length > 0) {
      return (
        <ul className="list-disc list-inside text-xs text-slate-600 space-y-0.5">
          {match.signals.slice(0, 3).map((sig: string) => <li key={sig}>{sig}</li>)}
        </ul>
      )
    }
    if (match.sharedInterests.length > 0) {
      return (
        <ul className="list-disc list-inside text-xs text-slate-600 space-y-0.5">
          <li>Curated based on your profile and preferences</li>
          <li>Additional overlap: {match.sharedInterests.join(', ')}</li>
        </ul>
      )
    }
    return <p className="text-xs text-slate-600 leading-relaxed">Curated based on your profile and preferences.</p>
  }

  // Featured card — horizontal layout: avatar L / details C / reasons R / actions below.
  // Reference uses 4 bullets in the reasons panel; real data often = 1 prose sentence.
  // The reasons panel is set to a stable min/max width so it reads as intentional
  // whether renderReasonBlock yields 1 sentence or 4 bullets. Stacks on mobile.
  const renderFeatured = (row: any) => {
    const s = row.profile
    const headline = displayTitle(s)
    const interests = Array.isArray(s.interests)
      ? s.interests
      : typeof s.interests === 'string' && s.interests
        ? s.interests.split(',').map((i: string) => i.trim()).filter(Boolean)
        : []
    return (
      <IntroductionCard key={row.rowId || s.id} targetId={s.id} rowId={row.rowId}>
        <div className="relative bg-white rounded-2xl border-l-[3px] border-brand-gold shadow-[0_12px_40px_rgba(15,28,58,0.08)] hover:shadow-[0_20px_60px_rgba(15,28,58,0.12)] transition-all overflow-hidden">
          <div className="px-6 pt-6 pb-6 sm:px-9 sm:pt-8 sm:pb-7">
            {/* Eyebrow — inside the card, signs the curator */}
            <p className="text-[10px] uppercase tracking-[0.18em] text-brand-gold font-bold mb-6">Curated by Andrel Concierge</p>

            {/* Main row: avatar / details / reasons. Stacks below md. */}
            <div className="flex flex-col md:flex-row md:items-start gap-7 md:gap-8">
              {/* Avatar column — fixed natural width */}
              <div className="flex-shrink-0 relative">
                <div className="absolute -inset-1 rounded-full ring-2 ring-brand-gold/20 pointer-events-none" aria-hidden="true" />
                <div className="relative">
                  <Avatar profile={s} size="lg" />
                </div>
              </div>

              {/* Details column — executive-dossier density */}
              <div className="flex-1 min-w-0">
                <p className="text-3xl sm:text-[2.25rem] font-bold text-brand-navy leading-[1.05] tracking-tight">{s.full_name || 'New member'}</p>
                {(headline || s.company) && (
                  <div className="mt-3 flex items-baseline gap-2.5 text-base sm:text-[17px] text-slate-700 font-medium">
                    {headline && <span className="truncate">{headline}</span>}
                    {headline && s.company && <span className="text-brand-gold/50 flex-shrink-0">|</span>}
                    {s.company && <span className="truncate text-slate-600">{s.company}</span>}
                  </div>
                )}
                {s.location && (
                  <div className="flex items-center gap-1.5 text-sm text-slate-500 mt-2">
                    <MapPin className="w-3.5 h-3.5 flex-shrink-0 text-brand-gold/60" />
                    <span className="truncate">{s.location}</span>
                  </div>
                )}

                {s.bio && (
                  <>
                    <div className="mt-5 border-t border-slate-100" />
                    <p className="mt-4 text-[15px] text-slate-700 leading-relaxed line-clamp-3">{s.bio}</p>
                  </>
                )}

                <div className="mt-5 flex flex-wrap gap-1.5">
                  {s.seniority && <Tag color="indigo">{s.seniority}</Tag>}
                  {s.mentorship_role && <Tag color="emerald"><span className="flex items-center gap-1"><Star className="w-2.5 h-2.5" />{s.mentorship_role}</span></Tag>}
                </div>

                {interests.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {interests.slice(0, 5).map((tag: string) => <Tag key={tag}>{tag}</Tag>)}
                  </div>
                )}
              </div>

              {/* Reasons column — CSS-adaptive width. The panel collapses toward its content
                  for short prose (concierge-memo feel) and expands naturally for multi-bullet
                  computeMatchSignals output (premium-bullet feel) up to a 20rem cap. No JS
                  branching on content length; renderReasonBlock output is unchanged. */}
              <div className="flex-shrink-0 w-full md:w-fit md:max-w-[20rem] md:min-w-[15rem]">
                <div className="rounded-xl bg-gradient-to-br from-brand-gold-soft via-brand-gold-soft/70 to-brand-cream/40 border border-brand-gold/30 px-6 py-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]">
                  {/* Memo header — gold-tinted icon tile + uppercase eyebrow + thin gold rule */}
                  <div className="flex items-center gap-2.5 mb-3 pb-3 border-b border-brand-gold/15">
                    <div className="w-7 h-7 rounded-full bg-brand-gold/15 border border-brand-gold/35 flex items-center justify-center flex-shrink-0">
                      <Users className="w-3.5 h-3.5 text-brand-gold" />
                    </div>
                    <p className="text-[10px] uppercase tracking-[0.16em] text-brand-navy font-bold leading-tight">Why we&rsquo;re introducing you</p>
                  </div>
                  {/* Content — CSS-styles bullets as gold checkmarks; prose paragraphs render naturally */}
                  <div className="text-[13px] text-slate-700 leading-relaxed [&_ul]:list-none [&_ul]:pl-0 [&_ul]:space-y-2 [&_li]:relative [&_li]:pl-6 [&_li]:before:content-['✓'] [&_li]:before:absolute [&_li]:before:left-0 [&_li]:before:top-[1px] [&_li]:before:text-brand-gold [&_li]:before:font-bold [&_p]:m-0">
                    {renderReasonBlock(row)}
                  </div>
                </div>
              </div>
            </div>

            {/* Actions row — below the main 3-col, anchored bottom-left */}
            <div className="mt-7 pt-5 border-t border-slate-100">
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
                <RequestIntroButton targetId={s.id} alreadyRequested={false} rowId={row.rowId} />
              )}
            </div>
          </div>
        </div>
      </IntroductionCard>
    )
  }

  // Additional card — compact grid
  const renderAdditional = (row: any) => {
    const s = row.profile
    const headline = displayTitle(s)
    return (
      <IntroductionCard key={row.rowId || s.id} targetId={s.id} rowId={row.rowId}>
        <div className="relative bg-white border border-slate-100 border-l-2 border-l-brand-gold/60 rounded-2xl p-5 shadow-[0_6px_20px_rgba(15,28,58,0.06)] hover:shadow-[0_10px_32px_rgba(15,28,58,0.10)] hover:border-l-brand-gold transition-all flex flex-col gap-3.5">
          <div className="flex items-start gap-3.5">
            <Avatar profile={s} size="md" />
            <div className="flex-1 min-w-0">
              <p className="text-base font-bold text-brand-navy truncate leading-tight tracking-tight">{s.full_name || 'New member'}</p>
              {(headline || s.company) && (
                <div className="mt-1 flex items-baseline gap-1.5 text-xs text-slate-700 font-medium">
                  {headline && <span className="truncate">{headline}</span>}
                  {headline && s.company && <span className="text-brand-gold/40 flex-shrink-0">|</span>}
                  {s.company && <span className="truncate text-slate-500">{s.company}</span>}
                </div>
              )}
              {s.location && (
                <div className="flex items-center gap-1 text-[11px] text-slate-400 mt-1">
                  <MapPin className="w-3 h-3 flex-shrink-0 text-brand-gold/50" />
                  <span className="truncate">{s.location}</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {s.seniority && <Tag color="indigo">{s.seniority}</Tag>}
          </div>

          <div className="rounded-lg bg-gradient-to-br from-brand-gold-soft/60 via-brand-gold-soft/40 to-brand-cream/30 border border-brand-gold/25 px-3.5 py-3">
            <div className="flex items-center gap-2 mb-1.5 pb-1.5 border-b border-brand-gold/15">
              <Users className="w-3 h-3 text-brand-gold flex-shrink-0" />
              <p className="text-[9px] uppercase tracking-[0.14em] text-brand-navy font-bold leading-tight">Why we&rsquo;re introducing you</p>
            </div>
            <div className="text-[12px] text-slate-700 leading-snug line-clamp-3 [&_ul]:list-none [&_ul]:pl-0 [&_ul]:space-y-1 [&_li]:relative [&_li]:pl-4 [&_li]:before:content-['✓'] [&_li]:before:absolute [&_li]:before:left-0 [&_li]:before:top-0 [&_li]:before:text-brand-gold [&_li]:before:font-bold [&_p]:text-[12px] [&_p]:m-0">
              {renderReasonBlock(row)}
            </div>
          </div>

          <div>
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
              <RequestIntroButton targetId={s.id} alreadyRequested={false} rowId={row.rowId} />
            )}
          </div>
        </div>
      </IntroductionCard>
    )
  }

  // Opportunity panel — receiver side. Empty state = "Opportunity Concierge".
  const oppCount = (oppCandidateRows ?? []).length

  return (
    <div className="relative min-h-screen bg-[#FAF6EE] p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <div className="relative max-w-6xl mx-auto">

        {/* HERO — compact context band, supports the featured card */}
        <div className="mb-6">
          <p className="text-[10px] uppercase tracking-[0.18em] text-brand-gold font-semibold mb-2">Curated for you, {firstName}</p>
          <div className="flex items-start gap-3">
            <h1 className="text-2xl sm:text-3xl font-bold text-brand-navy tracking-tight leading-[1.1]">Your next valuable relationship</h1>
            {/* Small gold sparkle ornament beside the headline */}
            <Sparkles className="w-5 h-5 text-brand-gold flex-shrink-0 mt-1.5" aria-hidden="true" />
          </div>
          <p className="text-slate-600 text-sm sm:text-[15px] mt-2 leading-snug max-w-2xl">High-signal introductions across the Andrel network. We facilitate when interest is mutual.</p>
          {/* Slim gold rule below subhead — matches reference's understated decorator */}
          <div className="mt-3 w-24 h-px bg-gradient-to-r from-brand-gold via-brand-gold/40 to-transparent" />
        </div>

        <FoundingMemberWelcomeBanner show={showFoundingWelcome} />

        {!isPaid && !isFoundingMember && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-white/40 border border-brand-gold/15 px-4 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <Pill variant="gold" dot>Free</Pill>
              <span className="text-xs text-slate-500 truncate">Upgrade for priority matching and more introductions.</span>
            </div>
            <a href="/dashboard/billing" className="inline-flex items-center gap-0.5 text-xs font-semibold text-brand-navy/70 hover:text-brand-gold flex-shrink-0 transition-colors">Upgrade <ArrowRight className="w-3 h-3" /></a>
          </div>
        )}
        {isPaid && (
          <div className="mb-3 flex items-center gap-2 rounded-xl bg-white/40 border border-brand-navy/10 px-4 py-2">
            <Pill variant="navy" dot><span className="capitalize">{userTier}</span></Pill>
            <span className="text-xs text-slate-500">Priority matching active.</span>
          </div>
        )}

        {showBanner && currentBatchId && (
          <EarlierIntroductionsBanner
            count={earlierSuggestions.length}
            batchId={currentBatchId}
          />
        )}

        {/* TWO-COLUMN LAYOUT */}
        <div className="grid lg:grid-cols-3 gap-6 lg:gap-8">

          {/* MAIN COLUMN */}
          <div className="lg:col-span-2 space-y-8 min-w-0">

            {adminIntrosVisible.length > 0 && (
              <section className="p-5 rounded-xl border border-brand-gold/30 bg-brand-gold/5">
                <h3 className="text-sm font-semibold text-brand-navy mb-3">Introduced by Andrel</h3>
                <div className="grid sm:grid-cols-2 gap-4">
                  {adminIntrosVisible.map((intro: any) => (
                    <IntroductionCard key={intro.id} targetId={intro.other.id}>
                      <AdminIntroCard
                        introRequestId={intro.id}
                        otherUser={intro.other}
                        otherAlreadyApproved={intro.otherAlreadyApproved}
                        userAlreadyAccepted={intro.userAlreadyAccepted}
                      />
                    </IntroductionCard>
                  ))}
                </div>
              </section>
            )}

            {/* FEATURED + ADDITIONAL */}
            {featuredSuggestion ? (
              <section>
                {/* Eyebrow now lives inside the featured card — see renderFeatured */}
                {renderFeatured(featuredSuggestion)}

                {additionalSuggestions.length > 0 && (
                  <div className="mt-10">
                    <div className="flex items-end justify-between gap-4 mb-4">
                      <h3 className="text-base font-bold text-brand-navy tracking-tight">Additional curated introductions</h3>
                      <Pill variant="gold">{additionalSuggestions.length}</Pill>
                    </div>
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {additionalSuggestions.map(renderAdditional)}
                    </div>
                  </div>
                )}
              </section>
            ) : (
              <section className="relative overflow-hidden bg-gradient-to-br from-white via-white to-brand-cream/30 border border-brand-navy/10 rounded-2xl p-7 sm:p-10 shadow-lg">
                {/* Decorative gold ring in corner */}
                <div className="absolute -top-16 -right-16 w-48 h-48 rounded-full border border-brand-gold/15 pointer-events-none" />
                <div className="absolute -top-8 -right-8 w-24 h-24 rounded-full border border-brand-gold/20 pointer-events-none" />
                <div className="relative flex items-start gap-5">
                  <div className="w-14 h-14 rounded-2xl bg-brand-navy text-brand-gold flex items-center justify-center flex-shrink-0 shadow-md">
                    <Sparkles className="w-7 h-7" />
                  </div>
                  <div className="flex-1">
                    <p className="text-[11px] uppercase tracking-[0.15em] text-brand-gold font-semibold mb-1.5">Curating</p>
                    <h2 className="text-xl sm:text-2xl font-bold text-brand-navy tracking-tight leading-tight">Your next introduction is being curated.</h2>
                    <p className="text-sm sm:text-base text-slate-600 mt-3 leading-relaxed max-w-xl">
                      Andrel surfaces high-signal introductions only when there's a strong, mutual fit. Sharpen your signal in the meantime — most users see new matches within a week of completing these steps.
                    </p>

                    <div className="mt-6 space-y-3">
                      <Link href="/dashboard/profile" className="flex items-start gap-3 rounded-xl border border-slate-200 hover:border-brand-navy hover:bg-white px-4 py-3.5 transition-colors group">
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-brand-navy">Complete your profile</p>
                          <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">Exact title, expertise, and bio drive who you match with.</p>
                        </div>
                        <ArrowRight className="w-4 h-4 text-slate-400 mt-1 group-hover:text-brand-navy transition-colors" />
                      </Link>
                      <Link href="/dashboard/profile" className="flex items-start gap-3 rounded-xl border border-slate-200 hover:border-brand-navy hover:bg-white px-4 py-3.5 transition-colors group">
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-brand-navy">Update who you want to meet</p>
                          <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">Specify desired connections to focus the matcher.</p>
                        </div>
                        <ArrowRight className="w-4 h-4 text-slate-400 mt-1 group-hover:text-brand-navy transition-colors" />
                      </Link>
                      <TargetedRequestModalLauncher
                        premiumCredits={premiumCredits}
                        hasPendingRequest={hasPendingTargetedRequest}
                        variant="row"
                      />
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* EARLIER */}
            {earlierSuggestions.length > 0 && (
              <details id="earlier-introductions" className="group border-t border-slate-100 pt-6">
                <summary className="cursor-pointer flex items-center justify-between gap-4 list-none [&::-webkit-details-marker]:hidden">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">
                      Earlier introductions ({earlierSuggestions.length})
                    </h2>
                    <p className="text-sm text-slate-500 mt-1">Still waiting for a response. Review when you have a moment.</p>
                  </div>
                  <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0 transition-transform group-open:rotate-180" />
                </summary>
                <div className="grid sm:grid-cols-2 gap-4 mt-5">
                  {earlierSuggestions.map(renderAdditional)}
                </div>
              </details>
            )}

          </div>

          {/* RIGHT RAIL */}
          <aside className="space-y-5 lg:sticky lg:top-8 lg:self-start">

            {/* ANDREL CONCIERGE CARD — secondary to featured; lighter visual weight */}
            <section className="relative overflow-hidden bg-gradient-to-br from-[#162449] via-brand-navy to-[#0A1530] text-white rounded-2xl p-5 shadow-[0_8px_24px_rgba(15,28,58,0.12)] ring-1 ring-brand-gold/8">
              {/* Subtler gold ambient glow */}
              <div className="absolute -top-10 -right-10 w-32 h-32 bg-brand-gold/12 rounded-full blur-3xl pointer-events-none" aria-hidden="true" />
              <div className="absolute top-0 left-5 right-5 h-px bg-gradient-to-r from-transparent via-brand-gold/50 to-transparent" />
              <div className="relative">
                <div className="flex items-start gap-2.5">
                  <div className="w-9 h-9 rounded-lg bg-brand-gold text-brand-navy flex items-center justify-center flex-shrink-0">
                    <Send className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[9px] uppercase tracking-[0.18em] text-brand-gold font-bold mb-0.5">Premium</p>
                    <h3 className="text-sm font-bold text-white tracking-tight">Andrel Concierge</h3>
                    <p className="text-[11px] text-white/65 mt-1 leading-relaxed">Need a warm introduction to someone specific? Our team can help facilitate targeted introductions.</p>
                  </div>
                </div>
                <div className="mt-4 text-[11px] text-white/65 border-t border-white/10 pt-2.5 flex items-center justify-between gap-3">
                  <span>
                    Premium credits: <span className="font-bold text-brand-gold">{premiumCredits}</span>
                  </span>
                  {hasPendingTargetedRequest && (
                    <span className="text-brand-gold bg-brand-gold/15 border border-brand-gold/40 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider">pending</span>
                  )}
                </div>
                <div className="mt-3">
                  <TargetedRequestModalLauncher
                    premiumCredits={premiumCredits}
                    hasPendingRequest={hasPendingTargetedRequest}
                    variant="primary"
                  />
                </div>
              </div>
            </section>

            {/* OPPORTUNITIES PANEL */}
            <section className="relative overflow-hidden bg-white border border-slate-100 rounded-2xl p-6 shadow-md">
              <div className="absolute top-0 left-6 right-6 h-px bg-gradient-to-r from-transparent via-brand-gold/30 to-transparent" />
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.15em] text-brand-gold font-semibold mb-1">Network signals</p>
                  <h3 className="text-base font-bold text-brand-navy tracking-tight">Opportunities for you</h3>
                  <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">Hiring + business signals from across the network.</p>
                </div>
                {oppCount > 0 && <Pill variant="gold">{oppCount}</Pill>}
              </div>
              {oppCount > 0 ? (
                <div className="space-y-2.5">
                  {(oppCandidateRows as any[]).map((c: any) => {
                    const opp = c.opportunities
                    const creator = opp?.profiles
                    return (
                      <Link
                        key={c.id}
                        href={`/dashboard/opportunities`}
                        className="block rounded-xl border border-slate-200 hover:border-brand-navy hover:bg-brand-cream/30 px-3.5 py-3 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-brand-navy truncate">{opp?.title || 'Untitled'}</p>
                            {(creator?.full_name || creator?.company) && (
                              <p className="text-xs text-slate-500 truncate mt-0.5">
                                {[creator?.full_name, creator?.company].filter(Boolean).join(' · ')}
                              </p>
                            )}
                          </div>
                          {opp?.urgency && opp.urgency !== 'low' && (
                            <Pill variant={opp.urgency === 'urgent' ? 'gold' : 'navy'}>{opp.urgency}</Pill>
                          )}
                        </div>
                      </Link>
                    )
                  })}
                  <Link href="/dashboard/opportunities" className="block text-center text-xs font-semibold text-brand-navy hover:text-brand-gold pt-2 transition-colors">
                    See all opportunities &rarr;
                  </Link>
                </div>
              ) : (
                <div className="relative overflow-hidden rounded-xl bg-gradient-to-br from-brand-cream/40 via-white to-white border border-brand-gold/15 px-4 py-8 text-center">
                  {/* Concentric gold ring decoration */}
                  <div className="absolute -top-12 -right-12 w-32 h-32 rounded-full border border-brand-gold/15 pointer-events-none" aria-hidden="true" />
                  <div className="absolute -top-6 -right-6 w-16 h-16 rounded-full border border-brand-gold/20 pointer-events-none" aria-hidden="true" />
                  <div className="relative">
                    <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-navy text-brand-gold border border-brand-gold/30 mb-4 shadow-md">
                      <Zap className="w-7 h-7" />
                    </div>
                    <p className="text-[10px] uppercase tracking-[0.18em] text-brand-gold font-bold mb-1.5">Concierge</p>
                    <p className="text-sm font-bold text-brand-navy tracking-tight">Opportunity Concierge</p>
                    <p className="text-xs text-slate-500 mt-2 max-w-xs mx-auto leading-relaxed">
                      Tell us what you&rsquo;re looking for and we&rsquo;ll help surface opportunities through the Andrel network. {canCreateOpportunity
                        ? 'You can also signal a need directly to source the right people.'
                        : 'Upgrade to Professional to signal your own opportunities.'}
                    </p>
                    <div className="mt-5">
                      {canCreateOpportunity ? (
                        <Link
                          href="/dashboard/opportunities/new"
                          className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold rounded-lg bg-brand-navy text-white hover:bg-brand-navy/90 transition-colors shadow-md"
                        >
                          Submit an opportunity
                          <ArrowRight className="w-3 h-3" />
                        </Link>
                      ) : (
                        <Link
                          href="/dashboard/billing"
                          className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold rounded-lg bg-white border border-brand-navy text-brand-navy hover:bg-brand-navy hover:text-white transition-colors shadow-sm"
                        >
                          Upgrade to signal a need
                          <ArrowRight className="w-3 h-3" />
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* Credits are now rendered exclusively in the shared sidebar membership card; the
                meeting_credits.balance value lives in `const balance` above via the same query, but
                is no longer rendered here to avoid duplicate display. */}

          </aside>

        </div>

      </div>
    </div>
  )
}
