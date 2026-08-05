// Match Intelligence — the builder (Phases A + B, display-only).
//
// Runs every registered extractor over two profiles (+ context), de-dupes by key
// AND by concept (a higher-priority "focus: nuclear energy" suppresses a redundant
// "expertise: nuclear energy"), ranks, and caps. Pure and side-effect-free; reads
// only data the surface already fetched. Completely independent of scoring/ranking
// — it never influences who is matched, only how a recommendation is EXPLAINED.

import { EXTRACTORS, type MatchSignal, type MatchContext } from './extractors'
import { generateConversationStarters } from './conversationStarters'

export type { MatchSignal, SignalCategory, MatchContext, RoleLite, PrevRoleLite } from './extractors'
export { generateConversationStarters } from './conversationStarters'

/** Max reasons shown on a card. */
export const MAX_MATCH_SIGNALS = 5

/**
 * De-dupe (by key, then by concept), sort by priority ASC (category order) and
 * specificity DESC (more specific first within a tie), and cap. Pure — unit-tested.
 *
 * Concept de-dupe: walking in final priority order, a signal whose `terms` are ALL
 * already claimed by a higher-priority signal is dropped as redundant.
 */
export function rankSignals(signals: MatchSignal[]): MatchSignal[] {
  const byKey = new Map<string, MatchSignal>()
  for (const s of signals) {
    if (!s || !s.label) continue
    if (!byKey.has(s.key)) byKey.set(s.key, s) // first wins on duplicate key
  }
  const sorted = Array.from(byKey.values()).sort(
    (a, b) => (a.priority - b.priority) || (b.specificity - a.specificity),
  )

  const claimed = new Set<string>()
  const kept: MatchSignal[] = []
  for (const s of sorted) {
    if (s.terms && s.terms.length > 0) {
      const fresh = s.terms.filter((t) => !claimed.has(t))
      if (fresh.length === 0) continue // fully redundant with a higher-priority line
      for (const t of s.terms) claimed.add(t)
    }
    kept.push(s)
    if (kept.length >= MAX_MATCH_SIGNALS) break
  }
  return kept
}

/**
 * Build the ranked, capped signal list explaining why `viewer` and `viewed` were
 * recommended. `ctx` carries the Phase B data (focus areas, additional roles,
 * previous employers) the surface fetched in bulk. Returns `{ signals }` (possibly
 * empty — the card then falls back to the stored match_reason). Never throws.
 */
export function buildMatchIntelligence(
  viewer: any,
  viewed: any,
  ctx: MatchContext = {},
): { signals: MatchSignal[]; starters: string[] } {
  if (!viewer || !viewed) return { signals: [], starters: [] }
  const raw: MatchSignal[] = []
  for (const extract of EXTRACTORS) {
    try { raw.push(...extract(viewer, viewed, ctx)) } catch { /* a bad extractor never breaks the card */ }
  }
  const signals = rankSignals(raw)
  // Conversation starters (Phase C) derive purely from the shown signals.
  const starters = generateConversationStarters(viewer, viewed, signals, ctx)
  return { signals, starters }
}
