/**
 * thursdayBanner — pure resolver that turns SERVER-ESTABLISHED facts into the member-facing
 * countdown-banner view. No DB, no IO: eligibility and the "new suggestion arrived" fact are decided
 * by the caller (server component) and passed in; this module only picks the state + copy. The
 * browser therefore receives a state kind, two copy strings, and an absolute target instant — never
 * IDs, scores, reasons, timestamps, or candidate data.
 *
 * TRUST RULES (Hobby-plan honest version):
 *  - Ineligible members (paused / inactive / incomplete / test / admin) get NO banner (null).
 *  - "New introductions are here" is shown ONLY when the server proved a newly-active suggestion
 *    exists this cycle (receivedThisCycle === true) — a real, durable artifact, never a passed clock.
 *  - We DO NOT show "we're still looking" / any negative outcome. Absence of a card is NOT proof the
 *    weekly run completed and considered this member (the single Hobby cron may be pending, delayed,
 *    or failed, and we keep no durable completion record). When there is no proven new suggestion we
 *    fall back to the neutral Thursday countdown.
 *  - No copy promises every member a match, and no copy claims an exact release time.
 */
import { nextBatch, countdownState, formatCountdown } from './thursdaySchedule'

/**
 * The weekly state model.
 *   pre_release   — no release durably recorded for THIS Thursday window. Neutral, no countdown.
 *   post_release  — this week's release IS recorded. Countdown to the next window.
 *   after_received— this member holds a card created in this cycle (their own proof).
 * `before` is retired: it counted down on the strength of the calendar alone.
 */
export type ThursdayBannerKind = 'pre_release' | 'post_release' | 'after_received'

export interface ThursdayBannerView {
  kind: ThursdayBannerKind
  title: string
  subtitle: string | null
  /** Absolute next-batch-window instant (ISO) for the client's live recompute. */
  targetIso: string
  /** Whether the live countdown line is shown for this state. */
  showCountdown: boolean
  /** Server-computed initial text — the client renders THIS first (identical markup on server + first
   *  client render → no hydration mismatch), then updates it live after mount. */
  initialCountdownText: string
}

/** Facts (all server-read) that decide whether a member is in the matching pool at all. */
export interface MatchingEligibilityFacts {
  accountStatus?: string | null
  profileComplete?: boolean | null
  isTestAccount?: boolean | null
  matchingPaused?: boolean | null
  isAdmin?: boolean | null
}

/**
 * Mirror of the REAL matching gate (see migration 050 member_pairs + the weekly-refresh cron
 * selector), PLUS an explicit admin exclusion: active account, complete profile, not a permanent
 * test account, not matching-paused, and not an admin account. A member who fails any of these is
 * not eligible for a Thursday batch and must not see a countdown.
 */
export function isEligibleForMatching(f: MatchingEligibilityFacts): boolean {
  return (
    f.accountStatus === 'active' &&
    f.profileComplete === true &&
    f.isTestAccount !== true &&
    f.matchingPaused !== true &&
    f.isAdmin !== true
  )
}

/**
 * Whether a member may VIEW the read-only Thursday schedule banner. This is DELIBERATELY separate
 * from isEligibleForMatching (matching eligibility) and must never be read as "eligible for matching":
 *  - Ordinary members: identical to matching eligibility (active + complete + not test + not paused).
 *  - Admins (is_admin === true): may see the banner as a read-only schedule preview EVEN IF flagged as
 *    a test account — but only when active + complete + not matching-paused. An admin is still NOT
 *    matching-eligible (isEligibleForMatching stays false for them) and only ever sees the neutral
 *    schedule state (the caller passes scheduleOnly: true so they never get "New introductions are
 *    here" and are never queried against a candidate pool).
 */
export function canViewThursdayBanner(f: MatchingEligibilityFacts): boolean {
  if (f.isAdmin === true) {
    return f.accountStatus === 'active' && f.profileComplete === true && f.matchingPaused !== true
  }
  return isEligibleForMatching(f)
}

export interface ResolveThursdayBannerInput {
  now: Date
  /** Server-decided banner VISIBILITY (canViewThursdayBanner) — NOT matching eligibility. */
  canView: boolean
  /**
   * Did the member get a newly-created ACTIVE suggestion in the current cycle?
   *   true  → a suggestion created at/after this cycle's window exists (server-proven, durable)
   *   false → none found (query succeeded)
   *   null  → could not be determined (query error / unavailable)
   * ONLY `true` upgrades the banner to "New introductions are here". false AND null both fall back to
   * the neutral Thursday countdown — absence is never treated as a completed-run negative outcome.
   */
  receivedThisCycle: boolean | null
  /**
   * Has THIS cycle's batch been DURABLY RECORDED as released? (migration 074)
   *   true  → a weekly_batch_releases row exists for this Thursday window
   *   false → none exists (query succeeded)
   *   null  → could not be determined (query error / unavailable)
   *
   * ONLY `true` starts a countdown. false AND null both hold the neutral preparation state, because
   * a countdown is a claim that this week's batch went out, and neither an unreleased week nor a
   * failed read is evidence of that.
   */
  releasedThisCycle: boolean | null
  /**
   * Schedule-only view: never "New introductions are here", regardless of receivedThisCycle. Used
   * for admins, who may preview the schedule but are not matching-eligible. It does NOT change the
   * release truth — an admin sees the same pre/post-release state everyone else does.
   */
  scheduleOnly?: boolean
}

const COPY = {
  /** No release recorded for this week yet. Neutral, promises nothing, counts down to nothing. */
  pre_release: {
    title: "This week's introduction batch is being prepared",
    subtitle: 'Check back after the next batch is released.',
  },
  /** This week's batch really went out. NOW a countdown to the next window is a truthful claim. */
  post_release: {
    title: 'Next introduction batch: Thursday',
    subtitle: 'The next curated introduction batch is being prepared.',
  },
  received: {
    title: 'New introductions are here',
    subtitle: 'Review your latest curated connections.',
  },
}

/**
 * Resolve the banner view, or null when the banner must be hidden entirely (ineligible member).
 *
 * ── PRECEDENCE, STATED EXPLICITLY ──────────────────────────────────────────────────────────────
 *
 *   1. after_received  — the member holds a card CREATED IN THIS CYCLE, proven server-side from
 *                        committed intro_requests. That card is itself proof a release reached
 *                        them, so it stands on its own evidence. Never shown in a schedule-only
 *                        (admin) view, and never from a draft or failed batch, because a draft
 *                        writes no 'suggested' row for the member to hold.
 *   2. post_release    — a release is durably recorded for THIS cycle. The member may have received
 *                        nothing; the release event is platform-wide, and requirement 8 is explicit
 *                        that such a member still sees the next-batch countdown.
 *   3. pre_release     — anything else, including a failed read. Neutral copy, NO countdown.
 *
 * The countdown target is the next Thursday window strictly after the current one, computed by
 * nextBatch(), which holds this Thursday throughout its whole [14:00,15:00) UTC invocation window
 * before rolling forward — so it never claims a batch already ran while Vercel might still invoke.
 *
 * TERMINATION: `releasedThisCycle` is keyed on the CURRENT cycle. When the next Thursday window
 * opens the key advances, no release exists for it yet, and this returns to pre_release on its own.
 * Nothing here can advance from Thursday to Thursday without new release evidence.
 */
export function resolveThursdayBanner(input: ResolveThursdayBannerInput): ThursdayBannerView | null {
  if (!input.canView) return null

  const target = nextBatch(input.now)
  const targetIso = target.toISOString()

  // 1. The member's own committed card outranks everything. Their evidence is stronger than the
  //    platform-wide record, and it cannot come from draft or failed work.
  if (!input.scheduleOnly && input.receivedThisCycle === true) {
    return {
      kind: 'after_received', ...COPY.received,
      targetIso, showCountdown: false, initialCountdownText: '',
    }
  }

  // 2. A countdown requires PROOF that this week went out. `false` and `null` are both "not proven".
  if (input.releasedThisCycle === true) {
    const cd = countdownState(input.now, target)
    return {
      kind: 'post_release', ...COPY.post_release,
      targetIso, showCountdown: true, initialCountdownText: formatCountdown(cd),
    }
  }

  // 3. Neutral. No countdown, no claim that introductions were sent, no promise anyone receives one.
  return {
    kind: 'pre_release', ...COPY.pre_release,
    targetIso, showCountdown: false, initialCountdownText: '',
  }
}
