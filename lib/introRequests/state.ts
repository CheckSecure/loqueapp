/**
 * Shared, pure helpers for deriving introduction-interest state from persisted
 * intro_requests rows. Used by both the server write path (createIntroRequest
 * idempotency) and the introductions feed (Pending vs "Express interest"), so
 * every surface derives from the SAME definition of "interest already expressed."
 */

/** Outbound statuses that mean the viewer has already expressed interest.
 *  ('suggested' is a recommendation, not an expressed interest; declined/
 *  passed/hidden are terminal and must NOT count.) */
export const EXPRESSED_STATUSES = ['pending', 'approved'] as const

export function isExpressedStatus(status: string | null | undefined): boolean {
  return status === 'pending' || status === 'approved'
}

/**
 * Set of target user ids the viewer has an OUTBOUND expressed-interest request
 * for (status pending or approved). The feed uses this to render the Pending /
 * "Interest expressed" state instead of a fresh "Express interest" button.
 */
export function expressedTargetIdSet(
  outbound: Array<{ target_user_id: string; status: string }> | null | undefined,
): Set<string> {
  const out = new Set<string>()
  for (const r of outbound ?? []) {
    if (r?.target_user_id && isExpressedStatus(r.status)) out.add(r.target_user_id)
  }
  return out
}

/**
 * From the viewer's outbound rows for ONE target, pick the row to reuse for an
 * idempotent express-interest (the earliest pending/approved), or null when
 * none exists yet. Guarantees repeated clicks never create a second row.
 */
export function findReusableOutboundIntro<T extends { status: string; created_at?: string | null }>(
  rows: T[] | null | undefined,
): T | null {
  const active = (rows ?? []).filter((r) => isExpressedStatus(r.status))
  if (active.length === 0) return null
  return active
    .slice()
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))[0]
}

/**
 * Intro statuses that exclude a pair from NEW batch/recommendation generation
 * (applied bidirectionally). A pending or connected pair can therefore never be
 * re-introduced as a fresh suggestion. Consumed by lib/generate-recommendations.ts.
 */
export const BATCH_EXCLUDING_STATUSES = ['suggested', 'pending', 'accepted', 'admin_pending', 'approved'] as const

export function isBatchExcludingStatus(status: string | null | undefined): boolean {
  return (BATCH_EXCLUDING_STATUSES as readonly string[]).includes(status ?? '')
}

/**
 * The state a suggested card should render for a target, from persisted data.
 * Every intro surface uses this so feed / pending / connected never disagree.
 *   connected — an active match exists (shown in the network, not as a suggestion)
 *   pending   — the viewer has an outbound pending/approved interest
 *   express   — no interest yet; show the "Express interest" button
 */
export type IntroCardState = 'connected' | 'pending' | 'express'

export function suggestedCardState(args: {
  targetId: string
  expressedTargetIds: Set<string>
  matchedUserIds: Set<string>
}): IntroCardState {
  if (args.matchedUserIds.has(args.targetId)) return 'connected'
  if (args.expressedTargetIds.has(args.targetId)) return 'pending'
  return 'express'
}

/**
 * Which introductions-page SECTION a target belongs in, from persisted state.
 * Precedence (mirrors app/dashboard/introductions/page.tsx exactly):
 *   connected — an active match exists (shown in Connections / network, not here)
 *   pending   — the viewer has an OUTBOUND pending/approved request, no match yet
 *   suggested — a bare recommendation row with no expressed interest
 *   none      — only terminal rows (declined/passed/hidden) or nothing → shown nowhere active
 * A target is placed in exactly ONE section, so no card is ever duplicated.
 */
export type IntroSection = 'connected' | 'pending' | 'suggested' | 'none'

export function introSectionFor(args: {
  isMatched: boolean
  hasOutboundExpressed: boolean // an outbound pending/approved request exists
  hasSuggestedRow: boolean
}): IntroSection {
  if (args.isMatched) return 'connected'
  if (args.hasOutboundExpressed) return 'pending'
  if (args.hasSuggestedRow) return 'suggested'
  return 'none'
}
