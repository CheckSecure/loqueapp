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

export type ThursdayBannerKind = 'before' | 'after_received'

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

export interface ResolveThursdayBannerInput {
  now: Date
  /** Server-decided (isEligibleForMatching). */
  eligible: boolean
  /**
   * Did the member get a newly-created ACTIVE suggestion in the current cycle?
   *   true  → a suggestion created at/after this cycle's window exists (server-proven, durable)
   *   false → none found (query succeeded)
   *   null  → could not be determined (query error / unavailable)
   * ONLY `true` upgrades the banner to "New introductions are here". false AND null both fall back to
   * the neutral Thursday countdown — absence is never treated as a completed-run negative outcome.
   */
  receivedThisCycle: boolean | null
}

const COPY = {
  before: {
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
 */
export function resolveThursdayBanner(input: ResolveThursdayBannerInput): ThursdayBannerView | null {
  if (!input.eligible) return null

  const target = nextBatch(input.now)
  const targetIso = target.toISOString()

  // Only a PROVEN new active suggestion upgrades the banner. Everything else (false or null) shows
  // the neutral Thursday countdown — never a "still looking" negative.
  if (input.receivedThisCycle === true) {
    return {
      kind: 'after_received', ...COPY.received,
      targetIso, showCountdown: false, initialCountdownText: '',
    }
  }

  const cd = countdownState(input.now, target)
  return {
    kind: 'before', ...COPY.before,
    targetIso, showCountdown: true, initialCountdownText: formatCountdown(cd),
  }
}
