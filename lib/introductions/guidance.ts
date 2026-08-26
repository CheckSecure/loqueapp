/**
 * WHICH piece of Introductions guidance a member sees, and — just as importantly — which they do not.
 *
 * Three states, mutually exclusive by construction so two banners can never compete:
 *
 *   FIRST_BATCH   a newly enrolled member is looking at their first real introductions.
 *                 Richer, one-time, dismissible. Replaces the compact reminder while it shows,
 *                 because it already says everything the reminder says.
 *   REMINDER      the member has actionable introductions and is not in the first-batch case.
 *                 Compact, not dismissible while cards remain, disappears the moment the count is 0.
 *   CAUGHT_UP     the member has received introductions before and has none awaiting a response.
 *   NONE          a brand-new member who has never received a card keeps the existing waiting state.
 *
 * ─── ENROLLMENT, AND WHY NO EXISTING MEMBER IS AFFECTED ───────────────────────────────────────
 * `enrolledAt` is profiles.intro_guidance_enrolled_at (migration 084). It is stamped ONLY by the
 * two profile-completion writers, going forward, and migration 084 performs NO backfill — so every
 * profile that existed before 084 has NULL and can never enter the first-batch case. That is the
 * whole mechanism: the explainer is gated on a column that is, by construction, empty for history.
 *
 * ─── WHAT NONE OF THIS MAY REVEAL ─────────────────────────────────────────────────────────────
 * Every input is the viewer's OWN state: their actionable count, their enrollment stamp, their
 * dismissal stamp, and whether they have ever received a card. Nothing here reads, encodes, or can
 * imply the counterparty's interest, who is waiting on whom, or the effect of a pass.
 */

export type GuidanceState = 'first_batch' | 'reminder' | 'caught_up' | 'none'

export interface GuidanceFacts {
  /** Cards awaiting this member's response — the SAME array length the page renders. */
  actionableCount: number
  /** True when the member has ever been sent an introduction, including terminal ones. */
  hasEverReceivedIntroduction: boolean
  /** profiles.intro_guidance_enrolled_at — NULL for every member that predates migration 084. */
  enrolledAt?: string | null
  /** profiles.intro_first_batch_explainer_dismissed_at — the member closed the explainer. */
  explainerDismissedAt?: string | null
}

/**
 * The one decision function. Order matters and encodes the hierarchy:
 * first-batch outranks the reminder; the reminder outranks caught-up; caught-up requires history.
 */
export function resolveGuidanceState(f: GuidanceFacts): GuidanceState {
  const actionable = Math.max(0, f.actionableCount | 0)

  if (actionable > 0) {
    // The explainer needs BOTH an enrollment stamp and real cards on screen. It therefore cannot
    // appear during onboarding (no cards yet) or on an empty page (no cards), and cannot appear for
    // a member enrolled before the column existed (stamp is NULL).
    const enrolled = !!f.enrolledAt
    const dismissed = !!f.explainerDismissedAt
    return enrolled && !dismissed ? 'first_batch' : 'reminder'
  }

  // Zero actionable cards. "All caught up" is a statement about the past, so it requires a past:
  // a member who has never received an introduction keeps the existing waiting/preparation state.
  //
  // A stale row pointing at an unavailable member deliberately does NOT change this answer. Since
  // migration 085 such a row costs the member nothing: it is excluded from the unresolved gate AND
  // from usable visible capacity (public.count_usable_visible_cards), so their full allocation is
  // available whether or not maintenance has physically neutralised it yet. They really are caught
  // up, and withholding the message until a cleanup job runs would be a fiction of our own making.
  return f.hasEverReceivedIntroduction ? 'caught_up' : 'none'
}

/**
 * ─── COPY ─────────────────────────────────────────────────────────────────────────────────────
 *
 * AUDITED POLICY: STRICT. Migration 081 gates all four production writers
 * (create_reciprocal_suggestion, place_batch_rows, promote_queued_rows, materialize_admin_pair) on
 * public.count_unresolved_introductions() > 0. A member holding even one unanswered actionable card
 * from a prior release receives no new introduction from any path. The one exception is internal and
 * invisible to the member: sibling cards of the SAME release do not block each other, which is what
 * lets one release deliver up to the visible cap at once.
 *
 * So the strict wording is accurate and the capacity-based wording would NOT be. Every string below
 * is checked by lib/__tests__/introduction-guidance.test.ts against the banned words as well:
 * "must", "unlock", "release", and "guaranteed" appear nowhere in member-facing copy.
 *
 * NOT INCLUDED: "Passing is completely fine and is not shared with the other member." A pass writes
 * status 'passed' / 'hidden_permanent' on the member's own row and sends nothing to the other
 * member — but on a reciprocal pair the counterpart's card is closed by the same transaction, so
 * their card disappears. We cannot claim the other member observes nothing, so the sentence is
 * omitted rather than shaded. See the audit report.
 */
export const GUIDANCE_COPY = {
  firstBatch: {
    heading: 'Your introductions are ready',
    body:
      'Review each person when you have time and let us know whether you’d like to connect or pass. ' +
      'Responding keeps your introduction queue moving and helps Andrel make better introductions.',
    dismissLabel: 'Got it',
  },
  reminder: {
    heading: 'You have introductions waiting',
    body:
      'Take your time reviewing them, then let us know whether you’d like to connect or pass. ' +
      'Once you’ve responded to your current introductions, you’ll be eligible for ' +
      'consideration in the next weekly round.',
    actionLabel: 'Review introductions',
  },
  caughtUp: {
    heading: 'You’re all caught up',
    body: 'You’ve responded to your current introductions. We’ll consider you for the next weekly round.',
  },
} as const

/** Words that would over-promise or apply pressure. Asserted absent from every string above. */
export const BANNED_GUIDANCE_WORDS = ['must', 'unlock', 'release', 'guaranteed'] as const

/** Screen-reader sentence for the reminder. Carries the count and nothing about the counterparty. */
export function actionableAnnouncement(count: number): string {
  const n = Math.max(0, count | 0)
  return n === 1
    ? '1 introduction is waiting for your response.'
    : `${n} introductions are waiting for your response.`
}

/**
 * The DOM id carried by the first actionable card, and the only thing the reminder's action targets.
 * Exported so the page that stamps it and the component that looks it up cannot drift apart.
 */
export const ACTIONABLE_ANCHOR_ID = 'first-actionable-introduction'

/**
 * Statuses that only ever exist because a card was PLACED for this member.
 *
 * Used for one question: "has this member ever received an introduction?" — which decides whether
 * an empty page says "You're all caught up" (they answered everything) or keeps the existing
 * waiting state (they have never been sent anything).
 *
 * 'pending' / 'approved' / 'accepted' are deliberately ABSENT: a member-initiated intro request
 * produces those too, so counting them would tell a brand-new member who requested an introduction
 * themselves that they are caught up on introductions they never received. A member who expressed
 * interest on a real card still qualifies, because migration 080 leaves that card 'suggested'.
 */
export const CARD_LIFECYCLE_STATUSES = [
  'suggested', 'queued', 'passed', 'hidden_permanent', 'archived', 'expired',
] as const

/** Whether a card has ever been placed for this member, from their own intro_requests rows. */
export function hasEverReceivedIntroduction(
  ownRequestRows: ReadonlyArray<{ status?: string | null }> | null | undefined,
): boolean {
  const set = new Set<string>(CARD_LIFECYCLE_STATUSES as readonly string[])
  return (ownRequestRows ?? []).some((r) => !!r?.status && set.has(r.status))
}
