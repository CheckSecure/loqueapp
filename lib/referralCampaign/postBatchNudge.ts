import { computeReferralCampaignEligibility } from '@/lib/referralCampaign/eligibility'
import { countUnresolvedRecommendations } from '@/lib/introductions/queue'
import { createNotificationSafe } from '@/lib/notifications'

/**
 * Ask a member to recommend people ONCE THEY HAVE SEEN THE PRODUCT WORK — not after N days.
 *
 * THE DURABLE MARKER IS member_pairs, not a card. An intro_requests row moves to
 * passed/expired/matched as soon as the member acts, so "do they have a card" answers a different
 * question than "have they ever received an introduction". member_pairs is described in
 * lib/introductions/activeReciprocalOpportunity.ts as "a PERMANENT audit record", is never deleted
 * by application code, and carries first_recommended_at. A member who acted on their card and
 * cleared it still has the row, so they still count — which is the requirement.
 *
 * SOURCE FILTER. member_pairs.source is one of reciprocal | onboarding | weekly | admin | backfill.
 * BATCH_SOURCES is the curated batch reading of "placed in a batch": the Thursday admin batch and
 * the weekly coverage pass. Onboarding pairs are deliberately excluded — they are generated the
 * moment a member finishes onboarding, so gating on them would be barely distinguishable from
 * gating on signup, which is exactly the "ask before they have seen anything" failure this exists
 * to avoid.
 */
export const BATCH_SOURCES = ['weekly', 'admin'] as const

/**
 * The SAME key the manual broadcast uses. This is what makes the two campaigns one campaign:
 * migration 006's unique index on (user_id, type, data->>'dedupeKey') has NO time window, so a
 * member notified by the manual run is permanently ineligible for the automatic one, and vice
 * versa. Changing this value re-notifies everybody.
 */
export const REFERRAL_CAMPAIGN_KEY = 'referral_campaign_2026_09'

export interface PostBatchCandidate {
  id: string
  email: string
  full_name: string | null
  firstBatchAt: string | null
  unresolvedCards: number
  verdict: 'would_notify' | 'holding_unactioned_cards' | 'no_batch_yet'
}

export interface PostBatchSelection {
  candidates: PostBatchCandidate[]
  counts: {
    eligibleMembers: number
    withBatchIntroduction: number
    holdingUnactionedCards: number
    wouldNotify: number
  }
}

/**
 * Read-only. Who currently qualifies, and why the rest do not.
 *
 * `skipUnactioned` defaults TRUE: asking someone to recommend people while they have not responded
 * to their own introductions is backwards, and the same members are already receiving a reminder
 * about those cards from this very cron. It is a parameter rather than a constant so the cost of
 * the rule is measurable — the dry run reports how many it holds back.
 */
export async function selectPostBatchNudgeTargets(
  admin: any,
  opts: { skipUnactioned?: boolean; limit?: number } = {},
): Promise<PostBatchSelection> {
  const skipUnactioned = opts.skipUnactioned !== false
  const limit = opts.limit ?? 200

  // Base population: active, onboarded, real email, not opted out, not internal. respectEmailSentStamp
  // is false because that column is the EMAIL channel's bookkeeping — a member who received the
  // referral email should still get the in-app nudge once the product has demonstrably worked.
  const { eligible } = await computeReferralCampaignEligibility({
    respectEmailSentStamp: false,
    respectEmailOptOut: true,
  })
  const byId = new Map(eligible.map((m) => [m.id, m]))

  // One query for the whole cohort. first_recommended_at is the earliest introduction; the row
  // survives whatever the member did with the card.
  const { data: pairs, error } = await admin
    .from('member_pairs')
    .select('user_a_id, user_b_id, source, first_recommended_at, created_at')
    .in('source', BATCH_SOURCES as unknown as string[])
  if (error) throw new Error(`member_pairs read failed: ${error.message}`)

  const firstBatchAt = new Map<string, string>()
  for (const p of (pairs ?? []) as any[]) {
    const at: string = p.first_recommended_at ?? p.created_at
    for (const uid of [p.user_a_id, p.user_b_id]) {
      if (!byId.has(uid)) continue
      const prev = firstBatchAt.get(uid)
      if (!prev || at < prev) firstBatchAt.set(uid, at)
    }
  }

  const candidates: PostBatchCandidate[] = []
  let holding = 0
  for (const m of eligible) {
    const at = firstBatchAt.get(m.id)
    if (!at) continue // no batch introduction yet — not a candidate, and not reported as one

    // Per-member, and only for members who already cleared every earlier gate, so this is a small
    // number of RPC calls rather than one per member in the network.
    const unresolved = skipUnactioned ? await countUnresolvedRecommendations(admin, m.id) : 0
    if (skipUnactioned && unresolved > 0) {
      holding++
      candidates.push({ id: m.id, email: m.email, full_name: m.full_name, firstBatchAt: at,
        unresolvedCards: unresolved, verdict: 'holding_unactioned_cards' })
      continue
    }
    candidates.push({ id: m.id, email: m.email, full_name: m.full_name, firstBatchAt: at,
      unresolvedCards: unresolved, verdict: 'would_notify' })
  }

  const wouldNotify = candidates.filter((c) => c.verdict === 'would_notify')
  return {
    candidates: candidates.slice(0, limit),
    counts: {
      eligibleMembers: eligible.length,
      withBatchIntroduction: firstBatchAt.size,
      holdingUnactionedCards: holding,
      wouldNotify: wouldNotify.length,
    },
  }
}

/**
 * Notify everyone who qualifies. Safe to run every day: the dedupeKey means a member is notified
 * at most once ever, so this converges rather than repeating.
 */
export async function runPostBatchReferralNudge(
  admin: any,
  opts: { skipUnactioned?: boolean; limit?: number } = {},
): Promise<{ notified: number; deduped: number; held: number; considered: number }> {
  const sel = await selectPostBatchNudgeTargets(admin, opts)
  let notified = 0
  let deduped = 0
  for (const c of sel.candidates) {
    if (c.verdict !== 'would_notify') continue
    const row = await createNotificationSafe({
      userId: c.id,
      type: 'referral_campaign',
      dedupeKey: REFERRAL_CAMPAIGN_KEY,
    })
    if (row) notified++
    else deduped++
  }
  return {
    notified,
    deduped,
    held: sel.counts.holdingUnactionedCards,
    considered: sel.counts.withBatchIntroduction,
  }
}
