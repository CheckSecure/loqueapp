/**
 * READ-ONLY analytics for the existing referral campaign. Computes campaign-attributed
 * activity (recommendations submitted AFTER a member's referral_campaign_sent_at) and
 * all-time referral activity — kept strictly separate — plus the funnel and derived
 * metrics. Derives everything from existing tables (profiles + referrals + waitlist);
 * writes nothing and changes no campaign behavior.
 *
 * Definitions (per the spec):
 *   • Campaign-attributed rec: referrals.created_at > profiles.referral_campaign_sent_at
 *   • Invitation:  waitlist.invited_at IS NOT NULL (durable; referral.status may change)
 *   • Activation:  referrals.status = 'activated' OR referrals.activated_at IS NOT NULL
 *   • Internal (excluded by default): is_admin, operator email, or is_test_account
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { computeReferralCampaignEligibility, OPERATOR_EMAIL_LOWER } from '@/lib/referralCampaign/eligibility'

export type AnalyticsOptions = { includeInternal?: boolean }

export type MemberAnalyticsRow = {
  id: string
  full_name: string | null
  email: string | null
  campaignSentAt: string | null
  campaignRecCount: number
  allTimeRecCount: number
  firstCampaignRecAt: string | null
  latestRecAt: string | null
  campaignInvitations: number
  campaignActivations: number
}

export type CampaignFunnel = {
  available: boolean                 // false when nobody has been sent the campaign → render "Not available yet"
  sent: number                       // members with referral_campaign_sent_at set
  recommended: number                // members who recommended AFTER receiving it
  recommendations: number            // total campaign-attributed recommendations (context)
  invited: number                    // campaign-attributed nominees invited (waitlist.invited_at)
  joined: number                     // campaign-attributed nominees joined (activated)
  pct: { recommended: number | null; invited: number | null; joined: number | null }
}

export type CampaignAnalytics = {
  includeInternal: boolean
  summary: {
    eligibleToReceive: number
    originalSent: number
    campaignParticipants: number
    campaignAttributedRecommendations: number
    allTimeParticipatingMembers: number
    allTimeRecommendations: number
    membersWithMultipleRecommendations: number
    invitationsFromCampaign: number
    activatedFromCampaign: number
  }
  funnel: CampaignFunnel
  derived: {
    participationRate: number | null            // null → "Not available yet"
    avgCampaignRecsPerParticipant: number | null
    medianDaysToFirstRec: number | null
    topCampaignRecommenders: Array<{ name: string | null; email: string | null; count: number }>
    topAllTimeRecommenders: Array<{ name: string | null; email: string | null; count: number }>
  }
  members: MemberAnalyticsRow[]
}

const isInternal = (p: any): boolean =>
  p?.is_admin === true || p?.is_test_account === true || (p?.email ?? '').toLowerCase() === OPERATOR_EMAIL_LOWER

function median(nums: number[]): number | null {
  if (nums.length === 0) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const round1 = (n: number) => Math.round(n * 10) / 10
const pct = (num: number, den: number): number | null => (den > 0 ? round1((num / den) * 100) : null)

export async function computeCampaignAnalytics(opts: AnalyticsOptions = {}): Promise<CampaignAnalytics> {
  const includeInternal = opts.includeInternal === true
  const admin = createAdminClient()

  const { data: profiles } = await admin.from('profiles')
    .select('id, email, full_name, account_status, is_test_account, is_admin, profile_complete, referral_campaign_sent_at')
  const { data: referrals } = await admin.from('referrals')
    .select('id, referrer_user_id, waitlist_id, status, created_at, activated_at')
  const { data: waitlist } = await admin.from('waitlist').select('id, invited_at')

  const invitedByWl = new Map<string, boolean>()
  for (const w of (waitlist ?? []) as any[]) invitedByWl.set(w.id, w.invited_at != null)
  const profById = new Map<string, any>()
  for (const p of (profiles ?? []) as any[]) profById.set(p.id, p)

  // Group referrals by referrer, honoring the internal filter.
  const byRef = new Map<string, any[]>()
  for (const r of (referrals ?? []) as any[]) {
    const p = profById.get(r.referrer_user_id)
    if (!p) continue                                   // orphan referrer (no profile) → skip
    if (!includeInternal && isInternal(p)) continue    // exclude operator/admin/test by default
    const arr = byRef.get(r.referrer_user_id) ?? []
    arr.push(r); byRef.set(r.referrer_user_id, arr)
  }

  // "Eligible to receive the original" — from the existing helper (already excludes internal;
  // does not vary with the toggle, since internal accounts can never receive the campaign).
  const elig = await computeReferralCampaignEligibility()

  const population = (profiles ?? []).filter((p: any) => includeInternal || !isInternal(p))
  const originalSent = population.filter((p: any) => p.referral_campaign_sent_at != null).length

  const members: MemberAnalyticsRow[] = []
  let campaignAttributedRecommendations = 0
  let allTimeRecommendations = 0
  let membersWithMultipleRecommendations = 0
  let invitationsFromCampaign = 0
  let activatedFromCampaign = 0
  const campaignParticipantIds = new Set<string>()
  const allTimeParticipantIds = new Set<string>()
  const daysToFirst: number[] = []

  for (const [refId, refs] of Array.from(byRef.entries())) {
    const p = profById.get(refId)
    const sentAt: string | null = p.referral_campaign_sent_at
    // Campaign-attributed = strictly AFTER the member's own send timestamp.
    const campaignRecs = sentAt ? refs.filter((r) => r.created_at > sentAt) : []
    const campaignRecCount = campaignRecs.length
    const allTimeRecCount = refs.length

    allTimeRecommendations += allTimeRecCount
    campaignAttributedRecommendations += campaignRecCount
    allTimeParticipantIds.add(refId)
    if (allTimeRecCount >= 2) membersWithMultipleRecommendations++
    if (campaignRecCount > 0) campaignParticipantIds.add(refId)

    const firstCampaignRecAt = campaignRecCount
      ? campaignRecs.reduce((m, r) => (r.created_at < m ? r.created_at : m), campaignRecs[0].created_at)
      : null
    const latestRecAt = refs.reduce((m, r) => (r.created_at > m ? r.created_at : m), refs[0].created_at)

    const campaignInvitations = campaignRecs.filter((r) => invitedByWl.get(r.waitlist_id) === true).length
    const campaignActivations = campaignRecs.filter((r) => r.status === 'activated' || r.activated_at != null).length
    invitationsFromCampaign += campaignInvitations
    activatedFromCampaign += campaignActivations

    if (campaignRecCount > 0 && sentAt && firstCampaignRecAt) {
      daysToFirst.push((new Date(firstCampaignRecAt).getTime() - new Date(sentAt).getTime()) / 86_400_000)
    }

    members.push({
      id: refId, full_name: p.full_name, email: p.email, campaignSentAt: sentAt,
      campaignRecCount, allTimeRecCount, firstCampaignRecAt, latestRecAt, campaignInvitations, campaignActivations,
    })
  }

  members.sort((a, b) => b.allTimeRecCount - a.allTimeRecCount)

  const available = originalSent > 0
  const funnel: CampaignFunnel = {
    available,
    sent: originalSent,
    recommended: campaignParticipantIds.size,
    recommendations: campaignAttributedRecommendations,
    invited: invitationsFromCampaign,
    joined: activatedFromCampaign,
    pct: available
      ? {
          recommended: pct(campaignParticipantIds.size, originalSent),
          invited: pct(invitationsFromCampaign, campaignAttributedRecommendations),
          joined: pct(activatedFromCampaign, invitationsFromCampaign),
        }
      : { recommended: null, invited: null, joined: null },
  }

  const topBy = (key: 'campaignRecCount' | 'allTimeRecCount') =>
    [...members].filter((m) => (m as any)[key] > 0).sort((a, b) => (b as any)[key] - (a as any)[key]).slice(0, 5)
      .map((m) => ({ name: m.full_name, email: m.email, count: (m as any)[key] as number }))

  const med = median(daysToFirst)

  return {
    includeInternal,
    summary: {
      eligibleToReceive: elig.eligible.length,
      originalSent,
      campaignParticipants: campaignParticipantIds.size,
      campaignAttributedRecommendations,
      allTimeParticipatingMembers: allTimeParticipantIds.size,
      allTimeRecommendations,
      membersWithMultipleRecommendations,
      invitationsFromCampaign,
      activatedFromCampaign,
    },
    funnel,
    derived: {
      participationRate: available ? pct(campaignParticipantIds.size, originalSent) : null,
      avgCampaignRecsPerParticipant: campaignParticipantIds.size > 0
        ? Math.round((campaignAttributedRecommendations / campaignParticipantIds.size) * 100) / 100 : null,
      medianDaysToFirstRec: med != null ? round1(med) : null,
      topCampaignRecommenders: topBy('campaignRecCount'),
      topAllTimeRecommenders: topBy('allTimeRecCount'),
    },
    members,
  }
}
