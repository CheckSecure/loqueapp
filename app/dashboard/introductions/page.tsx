import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { listRolesForProfiles } from '@/lib/profileRoles'
import { getAuthUser } from '@/lib/supabase/authUser'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Briefcase, MapPin, Inbox, Star, Sparkles, ChevronDown, ArrowRight, Send, Zap } from 'lucide-react'
import IntroductionActions from '@/components/IntroductionActions'
import AdminIntroCard from '@/components/AdminIntroCard'
import WithdrawInterestButton from '@/components/WithdrawInterestButton'
import IntroductionCard from '@/components/IntroductionCard'
import HideSuggestionButton from '@/components/HideSuggestionButton'
import RequestIntroButton from '@/components/RequestIntroButton'
import { buildIntroSections } from '@/lib/introductions/andrelSection'
import FoundingMemberWelcomeBanner from '@/components/FoundingMemberWelcomeBanner'
import ThursdayCountdownBanner from '@/components/ThursdayCountdownBanner'
import { resolveThursdayBanner, canViewThursdayBanner, type ThursdayBannerView } from '@/lib/introductions/thursdayBanner'
import { getCurrentCycleRelease } from '@/lib/introductions/batchRelease'
import { currentCycleBatch } from '@/lib/introductions/thursdaySchedule'
import ImproveRecommendationsCard from '@/components/ImproveRecommendationsCard'
import IncomingInterestCard from '@/components/IncomingInterestCard'
import WaitingOnResponse from '@/components/introductions/WaitingOnResponse'
import RespondToIntroductionsNotice from '@/components/introductions/RespondToIntroductionsNotice'
import { AndrelConnectorBadge } from '@/components/ui/AndrelConnectorBadge'
import { isAndrelConnector } from '@/lib/recognition/andrelConnector'
import { shouldShowRespondNotice } from '@/lib/introductions/unresolved'
import PageHint from '@/components/PageHint'
import { Avatar as UIAvatar } from '@/components/ui/Avatar'
import { Pill } from '@/components/ui/Pill'
import { EmptyState } from '@/components/ui/EmptyState'
import { matchProfileCompletion } from '@/lib/matching/profile-completion'
import { RECOMMENDATIONS_PER_BATCH } from '@/lib/introductions/limits'
import { fetchActionableIncomingInterest } from '@/lib/introductions/incomingInterest'
import { getEffectiveTier } from '@/lib/tier-override'
import { toList } from '@/lib/match-signals'
import { buildMatchIntelligence } from '@/lib/matchIntelligence'
import MatchIntelligenceCard from '@/components/MatchIntelligenceCard'
import { professionalIdentity, professionalIdentityLine } from '@/lib/professionalIdentity'
import { expressedTargetIdSet } from '@/lib/introRequests/state'
import ConciergeLauncher from '@/components/ConciergeLauncher'
import DemoInterestButton from '@/components/DemoInterestButton'
import DemoPassButton from '@/components/DemoPassButton'
import DemoCardHider from '@/components/DemoCardHider'
import { DEMO_FEATURED, DEMO_ADDITIONAL } from './_demo-data'

export const metadata = { title: 'Introductions | Andrel' }

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

function Avatar({ profile, size = 'md' }: { profile: any; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
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

export default async function IntroductionsPage({ searchParams }: { searchParams?: { demo?: string } }) {
  const supabase = createClient()
  // Shares the layout's server-validated getUser() via React cache — no extra
  // auth round-trip for this page during the login navigation.
  const user = await getAuthUser()
  if (!user) redirect('/login')

  // UI Review Mode — triple gate (ALL required):
  //   (1) NODE_ENV === 'development' — kills the branch in production builds.
  //   (2) user.email === 'alexandra@horizoncapital.com' — read from the
  //       server-verified auth.getUser() result above; never from headers,
  //       cookies, searchParams, or any client-supplied value.
  //   (3) searchParams.demo === 'full' — explicit opt-in per request.
  // Each gate is independently sufficient to block; all three required for
  // defense in depth. When false, downstream effective* aliases resolve to
  // the real-data variables by reference and the render is byte-identical.
  const isDevReview =
    process.env.NODE_ENV === 'development' &&
    user.email === 'alexandra@horizoncapital.com' &&
    searchParams?.demo === 'full'

  // A3: server-component SELF read via service_role, scoped to the caller's own id (base-table SELECT is
  // revoked). Explicit columns only — includes the tier + dismissal fields this page needs that are not
  // in the minimal browser self RPC.
  const { data: myProfileRows } = await createAdminClient()
    .from('profiles')
    .select('id, full_name, subscription_tier, is_founding_member, founding_member_expires_at, expertise, interests, intro_preferences, purposes, intro_profile_prompt_dismissed_at, created_at, account_status, profile_complete, is_test_account, matching_paused, is_admin')
    .eq('id', user.id)
    .limit(1)
  const profileRow = (Array.isArray(myProfileRows) ? myProfileRows[0] : myProfileRows) ?? null
  // Single recommendation-improvement prompt: driven by the matching-relevant
  // fields (matchProfileCompletion), dismissible per member, and it retires
  // automatically once the matching profile is complete. The dismissal flag is read
  // fail-open so the page never breaks if migration 039 isn't applied yet.
  const mc = matchProfileCompletion(profileRow)
  // The dismissal flag lives on the same self row already fetched above (fail-open when the column /
  // migration 039 isn't present → undefined, treated as not-dismissed).
  const introPromptDismissed = (profileRow as any)?.intro_profile_prompt_dismissed_at != null
  const showImproveCard = mc.missing.length > 0 && !introPromptDismissed
  const profileId = profileRow?.id ?? user.id
  const firstName = profileRow?.full_name?.split(' ')[0] || 'there'
  const userTier = (profileRow as any)?.subscription_tier ?? 'free'
  const effectiveTier = profileRow ? getEffectiveTier(profileRow) : 'free'
  // Concierge UI gate — must mirror the server gate (lib/concierge/eligibility.ts),
  // which uses getEffectiveTier(). UI convenience only; the route is authoritative.
  const canUseConcierge = ['professional', 'executive', 'founding'].includes(effectiveTier)
  const isPaid = userTier !== 'free'
  const isFoundingMember = Boolean(profileRow && effectiveTier === 'founding')
  const canCreateOpportunity = effectiveTier !== 'free'
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
  const profileCreatedAt = (profileRow as any)?.created_at
  const accountAgeMs = profileCreatedAt ? Date.now() - new Date(profileCreatedAt).getTime() : null
  const showFoundingWelcome = Boolean(
    isFoundingMember && accountAgeMs !== null && accountAgeMs < THIRTY_DAYS_MS
  )
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
    { data: existingRequests },
    { data: creditRow },
    { data: pendingTargetedRequest },
    { data: oppCandidateRows },
    { data: activeConciergeRequest },
    { data: pendingIntrosRaw },
  ] = await Promise.all([
    supabase
      .from('matches')
      .select('user_a_id, user_b_id')
      .or(`user_a_id.eq.${profileId},user_b_id.eq.${profileId}`),
    supabase
      .from('intro_requests')
      .select('id, target_user_id, created_at, match_reason, pair_id')
      .eq('requester_id', profileId)
      .eq('status', 'suggested')
      .order('created_at', { ascending: false }),
    supabase
      .from('intro_requests')
      .select('id, requester_id, target_user_id, status, created_at, is_admin_initiated, match_reason')
      .eq('target_user_id', profileId)
      .eq('is_admin_initiated', true)
      .in('status', ['admin_pending', 'approved'])
      .order('created_at', { ascending: false }),
    supabase
      .from('intro_requests')
      .select('target_user_id, status, created_at')
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
    // A3: this nests profiles (the opportunity creator) through an embed; scoped to the viewer's own
    // candidate rows (user_id = user.id) → read server-side via service_role (base SELECT revoked).
    createAdminClient()
      .from('opportunity_candidates')
      .select('id, opportunity_id, role, opportunities!inner(id, creator_id, type, title, description, urgency, status, expires_at, profiles!opportunities_creator_id_fkey(full_name, company, exact_job_title, title, role_type))')
      .eq('user_id', user.id)
      .is('dismissed_at', null)
      .eq('opportunities.status', 'active')
      .order('shown_at', { ascending: false })
      .limit(3),
    // Active Concierge request (if any). RLS allows users to SELECT their own
    // concierge_requests rows; requester_id is the auth uid we insert with.
    supabase
      .from('concierge_requests')
      .select('id, status, created_at')
      .eq('requester_id', user.id)
      .in('status', ['pending', 'reviewing', 'match_found'])
      .maybeSingle(),
    // Outbound interests the viewer has expressed (pending/approved) that have
    // not yet become a match — the source for the "Interest expressed" / Pending
    // section. Independent of the 'suggested' recommendation rows, so a pair
    // stays visible even after its suggested row is gone.
    supabase
      .from('intro_requests')
      .select('id, target_user_id, status, created_at, match_reason, responds_to_id')
      .eq('requester_id', profileId)
      .in('status', ['pending', 'approved'])
      .order('created_at', { ascending: false }),
  ])

  // A3: the `target` profile is no longer embedded via profiles!target_user_id (authenticated SELECT on
  // public.profiles is revoked). These targets are the viewer's OWN suggested/pending intro counterparts
  // (rows scoped to profileId), so read their fields — including the internal account_status used by the
  // deactivated filter below — server-side via service_role, and join them back so every downstream
  // `.target` read is unchanged.
  const targetIds = [
    ...(((suggestedIntros as any[]) || []).map((r) => r.target_user_id)),
    ...(((pendingIntrosRaw as any[]) || []).map((r) => r.target_user_id)),
  ]
  const targetProfiles = new Map<string, any>()
  {
    const uniqTargetIds = Array.from(new Set(targetIds.filter(Boolean)))
    if (uniqTargetIds.length > 0) {
      const { data: tp } = await createAdminClient()
        .from('profiles')
        .select('id, full_name, title, exact_job_title, company, location, bio, interests, seniority, role_type, mentorship_role, avatar_url, expertise, purposes, account_status, is_andrel_connector')
        .in('id', uniqTargetIds)
      for (const p of (tp ?? []) as any[]) if (p?.id) targetProfiles.set(p.id, p)
    }
  }
  const attachTarget = (r: any) => {
    const p = r?.target_user_id ? targetProfiles.get(r.target_user_id) : null
    // Not discoverable / absent → target null, exactly matching a missing embed (downstream
    // code filters on target truthiness). Discoverable → the SAME fields the embed returned.
    r.target = p
      ? {
          id: p.id,
          full_name: p.full_name,
          title: p.title,
          exact_job_title: p.exact_job_title,
          company: p.company,
          location: p.location,
          bio: p.bio,
          interests: p.interests,
          seniority: p.seniority,
          role_type: p.role_type,
          mentorship_role: p.mentorship_role,
          avatar_url: p.avatar_url,
          expertise: p.expertise,
          purposes: p.purposes,
          account_status: p.account_status,
          // Carried explicitly, like every other field: this map is an allowlist, so a column added
          // to the select alone would never reach the card.
          is_andrel_connector: p.is_andrel_connector,
        }
      : null
  }
  for (const r of ((suggestedIntros as any[]) || [])) attachTarget(r)
  for (const r of ((pendingIntrosRaw as any[]) || [])) attachTarget(r)

  // A3: decouple the admin-initiated `other` (requester) embed the same way — server-side via
  // service_role incl account_status (rows scoped to profileId as the target).
  {
    const otherIds = Array.from(new Set(((adminIntrosRaw as any[]) || []).map((r) => r.requester_id).filter(Boolean)))
    const otherProfiles = new Map<string, any>()
    if (otherIds.length > 0) {
      const { data: op } = await createAdminClient()
        .from('profiles')
        .select('id, full_name, title, exact_job_title, company, location, bio, seniority, role_type, avatar_url, account_status, expertise, interests, mentorship_role, purposes')
        .in('id', otherIds)
      for (const p of (op ?? []) as any[]) if (p?.id) otherProfiles.set(p.id, p)
    }
    for (const r of ((adminIntrosRaw as any[]) || [])) r.other = r.requester_id ? (otherProfiles.get(r.requester_id) ?? null) : null
  }

  const balance = creditRow?.balance ?? 0
  const activeConciergeStatus =
    ((activeConciergeRequest as any)?.status as 'pending' | 'reviewing' | 'match_found' | undefined) ?? null

  // Unified queue: the member's ACTIVE batch is exactly their intro_requests rows
  // with status 'suggested' (read as `suggestedIntros` above). There is no second
  // member-facing source and no visible "prior/earlier" batch — only the active
  // batch is shown, and it holds at most RECOMMENDATIONS_PER_BATCH recommendations.

  const matchedUserIds = new Set(
    (existingMatches || []).flatMap((m: any) =>
      [m.user_a_id, m.user_b_id].filter(id => id !== profileId)
    )
  )

  // INCOMING INTEREST — members who expressed interest in the viewer and are
  // waiting on a response. Single source of truth shared with the reminder cron
  // (fetchActionableIncomingInterest). Read-only; drives the "Interested in you"
  // section. A person shown here is excluded from the suggestion/pending sections
  // below so they render in exactly one place.
  // A3: server component → read incoming-interest requesters server-side via service_role (they expressed
  // approved interest AT the viewer, so they are authorized to surface; requesterActive needs the
  // internal account_status, not in public_profiles).
  const incomingInterest = await fetchActionableIncomingInterest(createAdminClient(), profileId, { viaServiceRole: true })
  const incomingRequesterIds = new Set(incomingInterest.map((i) => i.requesterId))

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
  // Targets the viewer has an OUTBOUND expressed-interest request for (pending
  // or approved). Every intro surface derives its Pending / "Interest expressed"
  // state from THIS one persisted set (not from raw 'suggested' rows or terminal
  // declined/passed rows), so feed, batch, and earlier cards can never disagree.
  const requestedIds = expressedTargetIdSet(existingRequests as any)

  // Split visible batch suggestions into current vs prior, excluding matched users.
  // Read-side deactivated filter — drop targets whose account_status !== 'active'.
  // Operates on the joined-target profile in memory; NEVER mutates intro_requests rows.
  const allOtherPartyIds = Array.from(new Set([
    ...(adminIntrosRaw || []).map((i: any) => i.requester_id),
    ...(suggestedIntros || []).map((i: any) => i.target_user_id),
  ]))
  const deactivatedIds = new Set<string>()
  if (allOtherPartyIds.length > 0) {
    // A3: account_status is an internal field (removed from public_profiles) — read it server-side via
    // service_role for the viewer's own intro counterparts to compute the deactivated filter.
    const { data: statusRows } = await createAdminClient()
      .from('profiles')
      .select('id, account_status')
      .in('id', allOtherPartyIds)
      .neq('account_status', 'active')
    for (const r of statusRows || []) deactivatedIds.add(r.id)
  }

  const adminIntrosVisible = adminIntrosFiltered.filter(
    (intro: any) => !deactivatedIds.has(intro.requester_id)
  )

  // The ACTIVE batch — the ONLY member-facing recommendations. Sourced solely from
  // intro_requests status='suggested' (onboarding, weekly, and materialized admin
  // reciprocal batches all land here). Deactivated / matched targets are dropped in
  // memory; the DB rows are untouched.
  const suggestedProfiles = (suggestedIntros || [])
    .filter((intro: any) => intro.target && !matchedUserIds.has(intro.target.id) && !deactivatedIds.has(intro.target.id) && !incomingRequesterIds.has(intro.target.id))
    .map((intro: any) => ({
      rowId: intro.id,
      profile: intro.target,
      matchReason: intro.match_reason || null,
      // Structured label source: a reciprocal auto-pair carries pair_id → "Introduced by Andrel"
      // (independent of match_reason, which stays a genuine compatibility explanation).
      introducedByAndrel: !!intro.pair_id,
      // Derive from persisted outbound state so a suggested card whose target
      // already has a pending/approved interest shows Pending, not "Express
      // interest" (fixes duplicate-row reappearance).
      alreadyRequested: requestedIds.has(intro.target.id),
      fromOnboarding: true,
    }))

  // Pending / interest-expressed: OUTBOUND pending or approved requests that
  // have NOT become a match. Deduped by target so duplicate rows (or a suggested
  // + approved pair) render exactly one card. Excludes matched (Connections) and
  // inactive targets. This is what keeps an expressed interest visible even once
  // its 'suggested' row is gone.
  //
  // CORRELATED expressions (responds_to_id set — migration 080) are partitioned OUT of this section
  // and rendered as the compact, non-interactive waiting state instead, so the member sees exactly
  // ONE representation of "I answered this card" rather than two. Their targets still suppress the
  // suggestion, which is what makes the answered card disappear from the actionable list.
  const pendingByTarget = new Map<string, any>()
  const correlatedExpressions: any[] = []
  const correlatedTargetIds = new Set<string>()
  for (const intro of (pendingIntrosRaw as any[] | null) || []) {
    const t = intro.target
    if (!t || matchedUserIds.has(t.id) || (t.account_status && t.account_status !== 'active')) continue
    if (intro.responds_to_id) {
      correlatedExpressions.push(intro)
      correlatedTargetIds.add(t.id)
      continue
    }
    if (incomingRequesterIds.has(t.id)) continue // shown in "Interested in you" instead
    if (!pendingByTarget.has(t.id)) {
      pendingByTarget.set(t.id, { rowId: intro.id, profile: t, matchReason: intro.match_reason || null, status: intro.status })
    }
  }
  const pendingProfiles = Array.from(pendingByTarget.values())
  const pendingTargetIds = new Set<string>(pendingProfiles.map((p: any) => p.profile.id))
  correlatedTargetIds.forEach((id) => pendingTargetIds.add(id))

  // WAITING ON THEIR RESPONSE — derived ONLY from the viewer's own correlated, still-live expression.
  //
  // Liveness comes from the CARD, not from the expression: `suggestedIntros` is this member's
  // status='suggested' rows, so a card that has been passed, expired, matched or otherwise closed is
  // simply absent and the entry vanishes with it. That is also why a stale epoch cannot linger — an
  // expression from a previous recommendation points at a card id that is no longer suggested.
  // A released card (capacity_released_at set) is still 'suggested' and still answerable, so it
  // correctly keeps its waiting line while no longer consuming capacity.
  //
  // Nothing here reads or reveals the counterparty's state: the only inputs are the viewer's own two
  // rows. The section renders no control of any kind.
  const liveCardIds = new Set<string>(
    ((suggestedIntros as any[] | null) || []).filter((r: any) => r.pair_id).map((r: any) => r.id),
  )
  const seenWaitingCards = new Set<string>()
  const waitingEntries = correlatedExpressions
    .filter((r: any) => liveCardIds.has(r.responds_to_id))
    .filter((r: any) => {
      if (seenWaitingCards.has(r.responds_to_id)) return false
      seenWaitingCards.add(r.responds_to_id)
      return true
    })
    .map((r: any) => ({ id: r.responds_to_id as string, name: r.target?.full_name || 'A member' }))

  // Never more than RECOMMENDATIONS_PER_BATCH visible. The active batch already
  // holds at most that many 'suggested' rows by construction; the slice is a
  // belt-and-suspenders guard so the invariant holds even if stray rows exist.
  const allSuggestions = Array.from(
    new Map(
      suggestedProfiles
        // Never show a pair as a fresh suggestion once interest is expressed —
        // it belongs in the Pending section (no duplicate cards across sections).
        .filter((item: any) => item?.profile?.id && !pendingTargetIds.has(item.profile.id))
        .map((item: any) => [item.profile.id, item])
    ).values()
  ).slice(0, RECOMMENDATIONS_PER_BATCH)

  // Featured = first; additional = rest. If allSuggestions is empty, neither renders.
  const featuredSuggestion = allSuggestions[0] ?? null
  const additionalSuggestions = allSuggestions.slice(1)

  // STRUCTURAL split of the visible suggestions by pair_id (via introducedByAndrel) — never inferred
  // from match_reason or display text. Reciprocal Andrel pairs → "Introduced by Andrel"; ordinary/
  // legacy (pair_id NULL) → "Recommended for you". Each card is in EXACTLY ONE section.
  const introSections = buildIntroSections(allSuggestions as any[])

  // UI Review overlay — when isDevReview, swap to static demo data (routed into the Andrel section
  // for preview). In production these alias the real per-section splits by reference.
  const effectiveAndrelFeatured: any = isDevReview ? DEMO_FEATURED : introSections.andrel.featured
  const effectiveAndrelAdditional: any[] = isDevReview ? DEMO_ADDITIONAL : introSections.andrel.additional
  const effectiveOrdinaryFeatured: any = isDevReview ? null : introSections.ordinary.featured
  const effectiveOrdinaryAdditional: any[] = isDevReview ? [] : introSections.ordinary.additional

  // ── Match Intelligence (Phase B) context — bulk, fail-open, NO N+1 ──────────
  // One query per data type for EVERY profile shown on this page (viewer + all
  // suggested/admin/incoming others): focus areas + previous_roles from profiles
  // (fail-open to previous-only if migration 041 is unapplied), additional roles
  // via listRolesForProfiles (admin client — owner-only RLS; fail-open to {} if
  // migration 042 is unapplied). Display-only; reads nothing scoring uses.
  const miIds = Array.from(new Set<string>([
    profileId,
    ...allSuggestions.map((s: any) => s?.profile?.id).filter(Boolean),
    ...adminIntrosVisible.map((i: any) => i?.other?.id).filter(Boolean),
    ...incomingInterest.map((i) => i.requesterId),
  ]))
  const miAdmin = createAdminClient()
  const miFocusById: Record<string, unknown> = {}
  const miPrevById: Record<string, unknown> = {}
  if (miIds.length > 0) {
    const combined = await miAdmin.from('profiles').select('id, current_focus_areas, previous_roles').in('id', miIds)
    const rows: any[] = !combined.error
      ? ((combined.data as any[]) ?? [])
      : (((await miAdmin.from('profiles').select('id, previous_roles').in('id', miIds)).data as any[]) ?? [])
    for (const r of rows) { miFocusById[r.id] = r.current_focus_areas; miPrevById[r.id] = r.previous_roles }
  }
  const miRolesById = await listRolesForProfiles(miAdmin, miIds) // fail-open → {}
  const asPrevArray = (v: any): any[] =>
    Array.isArray(v) ? v : (typeof v === 'string' ? (() => { try { const j = JSON.parse(v); return Array.isArray(j) ? j : [] } catch { return [] } })() : [])
  const miContext = (otherId: string) => ({
    viewerFocus: miFocusById[profileId], viewedFocus: miFocusById[otherId],
    viewerRoles: (miRolesById[profileId] as any) ?? [], viewedRoles: (miRolesById[otherId] as any) ?? [],
    viewerPrev: asPrevArray(miPrevById[profileId]), viewedPrev: asPrevArray(miPrevById[otherId]),
  })
  // Build once per other (signals + conversation starters), memoized.
  const miCache = new Map<string, ReturnType<typeof buildMatchIntelligence>>()
  const miFor = (other: any, otherId: string) => {
    const hit = miCache.get(otherId)
    if (hit) return hit
    const built = buildMatchIntelligence(profileRow, other, miContext(otherId))
    miCache.set(otherId, built)
    return built
  }

  // Match Intelligence (display-only): structured signals when available, else the
  // stored match_reason (newline-bullet contract preserved by the card), else
  // generic. Structured signals REPLACE the stored reason when present, so the two
  // never show together (no duplicate concepts).
  const renderReasonBlock = (row: any) => {
    const { signals, starters } = miFor(row.profile, row.profile?.id)
    return <MatchIntelligenceCard variant="bare" signals={signals} starters={starters} fallbackReason={row.matchReason} />
  }

  // Expertise tags: up to 5 + "+N more". Uses toList to normalize the varied
  // stored shape (array / csv / jsonb). Presentation only — no data change.
  const renderExpertiseTags = (raw: any) => {
    const list = toList(raw)
    if (list.length === 0) return null
    const shown = list.slice(0, 5)
    const extra = list.length - shown.length
    return (
      <div className="mt-3 flex flex-wrap gap-1.5">
        {shown.map((tag) => (
          <span key={tag} className="rounded-full border border-brand-navy/10 bg-brand-navy/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-brand-navy/80">{tag}</span>
        ))}
        {extra > 0 && (
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-medium text-slate-500">+{extra} more</span>
        )}
      </div>
    )
  }

  // Common-ground chips are now superseded by Match Intelligence (renderReasonBlock
  // above already renders the structured signals), so this returns nothing to avoid
  // duplicating the same concepts. Kept as a no-op to preserve call sites.
  const renderCommonGround = (_row: any) => null

  // Tertiary "View full profile" link. Rendered as an <a>, which the
  // IntroductionCard click-wrapper deliberately ignores (closest('a')) — so no
  // nested navigation conflict.
  const renderViewProfileLink = (targetId: string) => (
    <Link
      href={`/dashboard/profile/${targetId}`}
      className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition-colors hover:text-brand-navy"
    >
      View full profile
      <span aria-hidden="true">→</span>
    </Link>
  )

  const renderFeatured = (row: any) => {
    const s = row.profile
    const interests = Array.isArray(s.interests)
      ? s.interests
      : typeof s.interests === 'string' && s.interests
        ? s.interests.split(',').map((i: string) => i.trim()).filter(Boolean)
        : []
    const innerCard = (
      <div className="relative bg-white border border-slate-100 rounded-2xl pl-6 pr-5 py-5 sm:pl-8 sm:pr-6 sm:py-6 shadow-[0_8px_30px_rgba(15,28,58,0.08)] hover:shadow-[0_12px_40px_rgba(15,28,58,0.12)] transition-all overflow-hidden">
          {/* Gold left-edge accent — thicker, more prominent */}
          <div className="absolute left-0 top-10 bottom-10 w-1 bg-gradient-to-b from-brand-gold via-brand-gold/70 to-brand-gold/30 rounded-r-full pointer-events-none" />
          {/* Soft cream radial accent in the top-right for depth */}
          <div className="absolute -top-16 -right-16 w-48 h-48 bg-brand-cream/40 rounded-full blur-3xl pointer-events-none" aria-hidden="true" />

          <div className="relative flex items-start gap-6 sm:gap-7">
            <div className="flex-shrink-0 relative">
              {/* Decorative gold halo behind the avatar */}
              <div className="absolute -inset-1.5 rounded-full bg-gradient-to-br from-brand-gold/20 via-brand-gold/5 to-transparent blur-sm pointer-events-none" aria-hidden="true" />
              <div className="relative">
                <Avatar profile={s} size="lg" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xl sm:text-2xl font-bold text-brand-navy truncate leading-[1.1] tracking-tight">{s.full_name || 'New member'}</p>
              {/* Andrel Connector — on the FEATURED card only. The compact additional/pending cards
                  are already dense, and the brief is explicit that this must not crowd the primary
                  information. On its own line below the name, so `truncate` above is untouched and
                  no name shortens because of it. */}
              {isAndrelConnector(s) && (
                <div className="mt-1.5">
                  <AndrelConnectorBadge size="sm" />
                </div>
              )}
              {(() => { const identity = professionalIdentity(s); return identity.primary ? (
                <div className="mt-1.5">
                  <div className="flex items-center gap-2 text-sm text-slate-700 font-medium">
                    <Briefcase className="w-4 h-4 flex-shrink-0 text-brand-gold/70" />
                    <span className="truncate">{identity.primary}</span>
                  </div>
                  {identity.secondary && (
                    <p className="ml-6 text-xs text-slate-500 truncate">{identity.secondary}</p>
                  )}
                </div>
              ) : null })()}
              {s.location && (
                <div className="flex items-center gap-2 text-sm text-slate-400 mt-1">
                  <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">{s.location}</span>
                </div>
              )}
            </div>
          </div>

          {s.bio && <p className="relative mt-3 text-sm text-slate-600 leading-relaxed line-clamp-2">{s.bio}</p>}

          <div className="relative">{renderExpertiseTags(s.expertise)}</div>

          <div className="relative mt-4 bg-gradient-to-br from-brand-gold-soft via-brand-gold-soft/60 to-white border border-brand-gold/30 rounded-xl px-3.5 py-2.5 shadow-[0_1px_2px_rgba(196,146,42,0.08)]">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">
                <Sparkles className="w-4 h-4 text-brand-gold" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] uppercase tracking-[0.14em] font-bold text-brand-gold mb-1.5">Why we recommended them</p>
                {renderReasonBlock(row)}
              </div>
            </div>
          </div>

          {renderCommonGround(row)}

          <div className="relative mt-4 flex flex-col gap-2">
            {row.isDemo ? (
              /* UI Review CTAs — both inert, local-state only. Mirrors the
                 real RequestIntroButton's Express interest + pass layout. */
              <div className="flex gap-2">
                <div className="flex-1 min-w-0">
                  <DemoInterestButton />
                </div>
                <DemoPassButton />
              </div>
            ) : row.alreadyRequested ? (
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
            {!row.isDemo && renderViewProfileLink(s.id)}
          </div>
        </div>
    )
    // Demo rows skip the IntroductionCard navigation wrapper — their IDs
    // (demo-sarah-whitman etc.) don't resolve to real profiles, so clicking
    // through would 404. They wrap in DemoCardHider so the X/pass button can
    // unmount the card locally via React Context. Real rows get the
    // IntroductionCard wrapper and continue navigating to /dashboard/profile
    // on card-body click (RequestIntroButton + passOnSuggestion unchanged).
    if (row.isDemo) {
      return <DemoCardHider key={row.rowId || s.id}>{innerCard}</DemoCardHider>
    }
    return (
      <IntroductionCard key={row.rowId || s.id} targetId={s.id} rowId={row.rowId}>
        {innerCard}
      </IntroductionCard>
    )
  }

  // Additional card — compact grid
  const renderAdditional = (row: any) => {
    const s = row.profile
    const innerCard = (
      <div className="relative bg-white border border-slate-100 border-l-2 border-l-brand-gold/60 rounded-2xl p-5 shadow-[0_6px_20px_rgba(15,28,58,0.06)] hover:shadow-[0_10px_32px_rgba(15,28,58,0.10)] hover:border-l-brand-gold transition-all flex flex-col gap-3.5">
          <div className="flex items-start gap-3.5">
            <Avatar profile={s} size="md" />
            <div className="flex-1 min-w-0">
              <p className="text-base font-bold text-brand-navy truncate leading-tight tracking-tight">{s.full_name || 'New member'}</p>
              {(() => { const identity = professionalIdentity(s); return (<>
                {identity.primary && (
                  <p className="mt-1 text-xs font-medium text-slate-700 truncate leading-tight">{identity.primary}</p>
                )}
                {identity.secondary && (
                  <p className="mt-0.5 text-xs text-slate-500 truncate leading-tight">{identity.secondary}</p>
                )}
              </>) })()}
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

          {renderExpertiseTags(s.expertise)}

          <div className="rounded-lg bg-gradient-to-br from-brand-gold-soft via-brand-gold-soft/60 to-white border border-brand-gold/25 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <Sparkles className="w-3.5 h-3.5 text-brand-gold flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-[10px] uppercase tracking-[0.14em] font-bold text-brand-gold mb-1 leading-tight">Why we recommended them</p>
                <div className="text-[12px] text-slate-600 leading-snug line-clamp-2 [&_p]:m-0 [&_p]:text-[12px]">
                  {renderReasonBlock(row)}
                </div>
              </div>
            </div>
          </div>

          {renderCommonGround(row)}

          <div className="flex flex-col gap-2">
            {row.isDemo ? (
              /* UI Review CTAs — both inert, local-state only. Compact for the smaller weekly card. */
              <div className="flex gap-2">
                <div className="flex-1 min-w-0">
                  <DemoInterestButton compact />
                </div>
                <DemoPassButton compact />
              </div>
            ) : row.alreadyRequested ? (
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
            {!row.isDemo && renderViewProfileLink(s.id)}
          </div>
        </div>
    )
    // Demo rows skip IntroductionCard (would 404 on demo IDs) and wrap in
    // DemoCardHider for local pass behavior. Real rows keep IntroductionCard
    // navigation untouched.
    if (row.isDemo) {
      return <DemoCardHider key={row.rowId || s.id}>{innerCard}</DemoCardHider>
    }
    return (
      <IntroductionCard key={row.rowId || s.id} targetId={s.id} rowId={row.rowId}>
        {innerCard}
      </IntroductionCard>
    )
  }

  // Pending / interest-expressed card: the viewer has expressed interest and is
  // awaiting the other side. Withdraw stays reachable here (independent of any
  // 'suggested' row), and the pair leaves this section automatically once a
  // match forms (matched targets are excluded from pendingProfiles).
  const renderPending = (row: any) => {
    const s = row.profile
    const identity = professionalIdentity(s)
    return (
      <IntroductionCard key={row.rowId || s.id} targetId={s.id} rowId={row.rowId}>
        <div className="relative bg-white border border-slate-100 rounded-2xl p-5 shadow-[0_6px_20px_rgba(15,28,58,0.06)] flex flex-col gap-3">
          <div className="flex items-start gap-3.5">
            <Avatar profile={s} size="md" />
            <div className="flex-1 min-w-0">
              <p className="text-base font-bold text-brand-navy truncate leading-tight tracking-tight">{s.full_name || 'New member'}</p>
              {identity.primary && (
                <p className="mt-0.5 text-xs font-medium text-slate-700 truncate leading-tight">{identity.primary}</p>
              )}
              {s.location && (
                <div className="flex items-center gap-1 text-[11px] text-slate-400 mt-1">
                  <MapPin className="w-3 h-3 flex-shrink-0 text-brand-gold/50" />
                  <span className="truncate">{s.location}</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1.5">
              <svg className="w-3 h-3 text-emerald-600" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/></svg>
              <span className="text-xs font-medium text-emerald-700">Interest expressed · awaiting response</span>
            </div>
            <WithdrawInterestButton targetId={s.id} />
          </div>
          {renderViewProfileLink(s.id)}
        </div>
      </IntroductionCard>
    )
  }

  // Opportunity panel — receiver side. Empty state = "Opportunity Concierge".
  const oppCount = (oppCandidateRows ?? []).length

  // ── Weekly Thursday introduction countdown ──────────────────────────────────────────────────
  // Banner VISIBILITY (canViewThursdayBanner) is decided SERVER-SIDE and is deliberately SEPARATE
  // from matching eligibility (isEligibleForMatching). Ordinary members must be matching-eligible;
  // admins may see a READ-ONLY schedule preview (even if flagged as a test account) when active +
  // complete + not matching-paused, but are NEVER matching-eligible and only ever see the neutral
  // schedule state. Only a state kind, copy strings, and an absolute target instant reach the browser.
  const bannerNow = new Date()
  const bannerFacts = {
    accountStatus: (profileRow as any)?.account_status,
    profileComplete: (profileRow as any)?.profile_complete,
    isTestAccount: (profileRow as any)?.is_test_account,
    matchingPaused: (profileRow as any)?.matching_paused,
    isAdmin: (profileRow as any)?.is_admin,
  }
  const isAdminViewer = (profileRow as any)?.is_admin === true
  let thursdayBanner: ThursdayBannerView | null = null
  if (canViewThursdayBanner(bannerFacts)) {
    // DURABLE RELEASE EVIDENCE (migration 074), read once, server-side, for every viewer including
    // admins. The countdown used to be computed from the calendar alone, so it rolled forward every
    // Thursday whether or not a batch had been approved. `null` (a failed read) is deliberately NOT
    // treated as released: a countdown claims this week's batch went out, and a failed read is not
    // evidence of that.
    let releasedThisCycle: boolean | null = null
    try {
      releasedThisCycle = (await getCurrentCycleRelease(createAdminClient(), bannerNow)) !== null
    } catch {
      releasedThisCycle = null
    }

    if (isAdminViewer) {
      // Admin: read-only schedule preview. Do NOT query admin suggestions (admins are excluded from
      // candidate pools) and force the neutral schedule state — never "New introductions are here".
      // Admin: schedule-only preview. It reflects the SAME release truth every member sees —
      // scheduleOnly suppresses only the member-specific 'New introductions are here' state.
      thursdayBanner = resolveThursdayBanner({ now: bannerNow, canView: true, receivedThisCycle: false, releasedThisCycle, scheduleOnly: true })
    } else {
      // Durable "new suggestion arrived" evidence: does an ACTIVE suggestion created at/after THIS
      // cycle's Thursday window exist? Read authoritatively via service_role (independent of RLS).
      // Only a proven TRUE upgrades the banner to "New introductions are here"; false OR a query ERROR
      // (null) both fall back to the neutral Thursday countdown — never a false "new introductions" and
      // never a "still looking" negative (absence of a card is not proof the run completed).
      let receivedThisCycle: boolean | null = null
      try {
        const cycleStartIso = currentCycleBatch(bannerNow).toISOString()
        const { data: cycleSuggested, error: evErr } = await createAdminClient()
          .from('intro_requests')
          .select('id')
          .eq('requester_id', profileId)
          .eq('status', 'suggested')
          .gte('created_at', cycleStartIso)
          .limit(1)
        receivedThisCycle = evErr ? null : (cycleSuggested?.length ?? 0) > 0
      } catch {
        receivedThisCycle = null
      }
      thursdayBanner = resolveThursdayBanner({ now: bannerNow, canView: true, receivedThisCycle, releasedThisCycle, scheduleOnly: false })
    }
  }

  return (
    <div className="relative min-h-screen bg-[#FAF6EE] p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <div className="relative max-w-content mx-auto">

        {/* HERO — quiet page title (dashboard, not landing page) */}
        <div className="mb-8">
          <p className="text-[10px] uppercase tracking-[0.18em] text-brand-gold font-semibold mb-2">Curated for you, {firstName}</p>
          <h1 className="text-2xl sm:text-3xl font-bold text-brand-navy tracking-tight leading-[1.1]">Your next valuable relationship</h1>
          <p className="text-slate-600 text-sm sm:text-[15px] mt-2 leading-snug max-w-2xl">High-signal introductions across the Andrel network. We facilitate when interest is mutual.</p>
        </div>

        {thursdayBanner && (
          <ThursdayCountdownBanner
            kind={thursdayBanner.kind}
            title={thursdayBanner.title}
            subtitle={thursdayBanner.subtitle}
            targetIso={thursdayBanner.targetIso}
            showCountdown={thursdayBanner.showCountdown}
            initialCountdownText={thursdayBanner.initialCountdownText}
          />
        )}

        <FoundingMemberWelcomeBanner show={showFoundingWelcome} />

        {/* At most ONE prompt: shown only when recommendation-relevant profile
            fields are missing AND the member hasn't dismissed it. Retires
            automatically once the matching profile is complete. */}
        {showImproveCard && (
          <ImproveRecommendationsCard missing={mc.missing.map((f) => ({ key: f.key, label: f.label }))} />
        )}

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


        {/* The old low-match / under-served notices were removed: they fired on a
            temporary empty-queue state (visible intros below the tier limit), not on
            real candidate scarcity, so they could not reliably justify a warning. The
            single card above covers the actionable case (missing recommendation
            fields); the neutral empty state covers the rest. */}

        {/* RESPOND-TO-STAY-ELIGIBLE — derived from the SAME array that renders the cards, so the
            notice and the cards can never disagree. allSuggestions has already excluded correlated
            waiting entries, capacity-released rows, queued rows, terminal rows, matched and
            deactivated targets, and incoming-interest targets. Directly above the grid, in normal
            flow: above the fold on both breakpoints and incapable of covering the fixed MobileNav. */}
        {shouldShowRespondNotice(allSuggestions) && <RespondToIntroductionsNotice />}

        {/* TWO-COLUMN LAYOUT */}
        <div className="grid lg:grid-cols-3 gap-6 lg:gap-8">

          {/* MAIN COLUMN */}
          <div className="lg:col-span-2 space-y-8 min-w-0">

            {/* INTERESTED IN YOU — members who expressed interest and are waiting on
                the viewer. Highest-priority actionable item; the "Someone is waiting
                on your response" reminder links here. */}
            {incomingInterest.length > 0 && (
              <section className="p-5 rounded-xl border border-brand-gold/30 bg-brand-gold/5">
                <div className="flex items-end justify-between gap-4 mb-1.5">
                  <h3 className="text-base font-bold text-brand-navy tracking-tight">Interested in you</h3>
                  <Pill variant="gold">{incomingInterest.length}</Pill>
                </div>
                <p className="text-xs text-slate-500 mb-4">These members expressed interest and are waiting on your response. Accept to review, then connect.</p>
                <div className="grid sm:grid-cols-2 gap-4">
                  {incomingInterest.map((item) => (
                    <IntroductionCard key={item.introRequestId} targetId={item.requesterId}>
                      <IncomingInterestCard
                        introRequestId={item.introRequestId}
                        requester={item.requester}
                        matchReason={item.matchReason}
                        signals={miFor(item.requester, item.requesterId).signals}
                        starters={miFor(item.requester, item.requesterId).starters}
                      />
                    </IntroductionCard>
                  ))}
                </div>
              </section>
            )}

            {adminIntrosVisible.length > 0 && (
              <section className="p-5 rounded-xl border border-brand-gold/30 bg-brand-gold/5">
                <h3 className="text-sm font-semibold text-brand-navy mb-3">Andrel Concierge</h3>
                <div className="grid sm:grid-cols-2 gap-4">
                  {adminIntrosVisible.map((intro: any) => (
                    <IntroductionCard key={intro.id} targetId={intro.other.id}>
                      <AdminIntroCard
                        introRequestId={intro.id}
                        otherUser={intro.other}
                        otherAlreadyApproved={intro.otherAlreadyApproved}
                        userAlreadyAccepted={intro.userAlreadyAccepted}
                        matchReason={intro.match_reason}
                        signals={miFor(intro.other, intro.other.id).signals}
                        starters={miFor(intro.other, intro.other.id).starters}
                      />
                    </IntroductionCard>
                  ))}
                </div>
              </section>
            )}

            {/* INTEREST EXPRESSED / PENDING — outbound pending/approved, no match yet */}
            {pendingProfiles.length > 0 && (
              <section>
                <div className="flex items-end justify-between gap-4 mb-1.5">
                  <h3 className="text-base font-bold text-brand-navy tracking-tight">Interest expressed</h3>
                  <Pill variant="gold">{pendingProfiles.length}</Pill>
                </div>
                <p className="text-xs text-slate-500 mb-4">Awaiting their response — we&rsquo;ll connect you the moment interest is mutual.</p>
                <div className="grid sm:grid-cols-2 gap-4">
                  {pendingProfiles.map(renderPending)}
                </div>
              </section>
            )}

            {/* WAITING ON THEIR RESPONSE — compact, non-interactive, outside the actionable count */}
            <WaitingOnResponse entries={waitingEntries} />

            {/* FEATURED + ADDITIONAL */}
            {/* INTRODUCED BY ANDREL — reciprocal pair_id cards ONLY (featured + additional in one
                clearly-labeled section). Rendered only when a reciprocal card exists (no empty section). */}
            {effectiveAndrelFeatured && (
              <section className="p-5 sm:p-6 rounded-2xl border border-brand-gold/30 bg-brand-gold/[0.04]">
                <div className="mb-4">
                  <h3 className="text-base font-bold text-brand-navy tracking-tight">Introduced by Andrel</h3>
                  <p className="text-xs text-slate-500 mt-1">Andrel recommended you to each other. Your interest stays private&mdash;we connect you only when it&rsquo;s mutual.</p>
                </div>
                {renderFeatured(effectiveAndrelFeatured)}
                {effectiveAndrelAdditional.length > 0 && (
                  <div className="mt-8">
                    <div className="grid sm:grid-cols-2 gap-4">
                      {effectiveAndrelAdditional.map(renderAdditional)}
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* RECOMMENDED FOR YOU — ordinary/legacy suggestions (pair_id IS NULL) ONLY. */}
            {effectiveOrdinaryFeatured && (
              <section>
                {renderFeatured(effectiveOrdinaryFeatured)}
                {effectiveOrdinaryAdditional.length > 0 && (
                  <div className="mt-10">
                    <div className="flex items-end justify-between gap-4 mb-1.5">
                      <h3 className="text-base font-bold text-brand-navy tracking-tight">Recommended for you</h3>
                      <Pill variant="gold">{effectiveOrdinaryAdditional.length}</Pill>
                    </div>
                    <p className="text-xs text-slate-500 mb-4">People we think you should meet.</p>
                    <div className="grid sm:grid-cols-2 gap-4">
                      {effectiveOrdinaryAdditional.map(renderAdditional)}
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* Empty state — ONLY when neither section renders and there is no incoming interest. */}
            {!effectiveAndrelFeatured && !effectiveOrdinaryFeatured && incomingInterest.length === 0 && (
              <section className="rounded-2xl border border-slate-200/70 bg-white p-6 sm:p-7">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-xl bg-brand-navy/[0.04] text-brand-gold flex items-center justify-center flex-shrink-0">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] uppercase tracking-[0.15em] text-brand-gold font-semibold mb-1.5">Curating</p>
                    <h2 className="text-lg sm:text-xl font-bold text-brand-navy tracking-tight leading-tight">Your next introduction is being curated</h2>
                    <p className="text-sm text-slate-600 mt-2 leading-relaxed max-w-xl">
                      Check back Thursday for the next curated introduction batch.
                    </p>
                  </div>
                </div>
              </section>
            )}

          </div>

          {/* RIGHT RAIL — quiet secondaries */}
          <aside className="space-y-6 lg:sticky lg:top-8 lg:self-start">

            {/* LIVE OPPORTUNITIES — functional; only when present */}
            {oppCount > 0 && (
              <section className="bg-white border border-slate-200/70 rounded-2xl p-5">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <h3 className="text-sm font-semibold text-brand-navy tracking-tight">Opportunities for you</h3>
                  <Pill variant="gold">{oppCount}</Pill>
                </div>
                <div className="space-y-0.5">
                  {(oppCandidateRows as any[]).map((c: any) => {
                    const opp = c.opportunities
                    const creator = opp?.profiles
                    return (
                      <Link
                        key={c.id}
                        href={`/dashboard/opportunities`}
                        className="block rounded-lg -mx-1 px-3 py-2.5 hover:bg-slate-50 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-brand-navy truncate">{opp?.title || 'Untitled'}</p>
                            {(() => { const line = [creator?.full_name, professionalIdentityLine(creator)].filter(Boolean).join(' · '); return line ? (
                              <p className="text-xs text-slate-500 truncate mt-0.5">{line}</p>
                            ) : null })()}
                          </div>
                          {opp?.urgency && opp.urgency !== 'low' && (
                            <Pill variant={opp.urgency === 'urgent' ? 'gold' : 'navy'}>{opp.urgency}</Pill>
                          )}
                        </div>
                      </Link>
                    )
                  })}
                </div>
                <Link href="/dashboard/opportunities" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-navy hover:text-brand-gold transition-colors">
                  See all opportunities <ArrowRight className="w-3 h-3" />
                </Link>
              </section>
            )}

            {/* CONCIERGE — one card, three supporting actions (was three separate cards) */}
            <section className="bg-white border border-slate-200/70 rounded-2xl p-5">
              <p className="text-[10px] uppercase tracking-[0.15em] text-brand-gold font-semibold mb-1">Concierge</p>
              <h3 className="text-base font-bold text-brand-navy tracking-tight">Ask Andrel</h3>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">Andrel can personally facilitate the right connection, opportunity, or nomination for you.</p>
              <div className="mt-4 space-y-2">
                <ConciergeLauncher
                  canUseConcierge={canUseConcierge}
                  activeStatus={activeConciergeStatus}
                  variant="row"
                />
                <Link
                  href={canCreateOpportunity ? '/dashboard/opportunities/new' : '/dashboard/billing'}
                  className="flex w-full items-start gap-3 rounded-lg border border-slate-200 hover:border-brand-navy hover:bg-slate-50 px-4 py-3 transition-colors text-left group"
                >
                  <Zap className="w-4 h-4 text-brand-gold flex-shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-brand-navy">Signal an opportunity</p>
                    <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{canCreateOpportunity
                      ? 'Tell us what you’re looking for and we’ll source the right people.'
                      : 'Upgrade to Professional to signal your own opportunities.'}</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-slate-400 mt-0.5 group-hover:text-brand-navy transition-colors" />
                </Link>
                <Link
                  href="/dashboard/referrals"
                  className="flex w-full items-start gap-3 rounded-lg border border-slate-200 hover:border-brand-navy hover:bg-slate-50 px-4 py-3 transition-colors text-left group"
                >
                  <Send className="w-4 h-4 text-brand-gold flex-shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-brand-navy">Nominate someone</p>
                    <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">Help shape Andrel — nominate leaders who would add value.</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-slate-400 mt-0.5 group-hover:text-brand-navy transition-colors" />
                </Link>
              </div>
            </section>

            {/* Credits are rendered in the shared sidebar membership card (unchanged). */}

          </aside>

        </div>

      </div>
    </div>
  )
}
