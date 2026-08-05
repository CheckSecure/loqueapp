// Match Intelligence — the builder (Phase A, display-only).
//
// Runs every registered extractor over two profiles, de-dupes, ranks, and caps.
// Pure and side-effect-free; reads only fields the surfaces already have. It is
// completely independent of scoring/ranking — it never influences who is matched,
// only how an existing recommendation is EXPLAINED.

import { EXTRACTORS, type MatchSignal } from './extractors'

export type { MatchSignal, SignalCategory } from './extractors'

/** Max reasons shown on a card. */
export const MAX_MATCH_SIGNALS = 5

/**
 * De-dupe (by key), then sort by priority ASC (category order) and specificity
 * DESC (more specific first within a tie), then cap. Pure — unit-tested directly.
 */
export function rankSignals(signals: MatchSignal[]): MatchSignal[] {
  const byKey = new Map<string, MatchSignal>()
  for (const s of signals) {
    if (!s || !s.label) continue
    if (!byKey.has(s.key)) byKey.set(s.key, s) // first wins on duplicate key
  }
  return Array.from(byKey.values())
    .sort((a, b) => (a.priority - b.priority) || (b.specificity - a.specificity))
    .slice(0, MAX_MATCH_SIGNALS)
}

/**
 * Build the ranked, capped signal list explaining why `viewer` and `viewed` were
 * recommended. Returns `{ signals }` (possibly empty — the card then falls back to
 * the stored match_reason). Never throws on missing/partial profiles.
 */
export function buildMatchIntelligence(viewer: any, viewed: any): { signals: MatchSignal[] } {
  if (!viewer || !viewed) return { signals: [] }
  const raw: MatchSignal[] = []
  for (const extract of EXTRACTORS) {
    try { raw.push(...extract(viewer, viewed)) } catch { /* a bad extractor never breaks the card */ }
  }
  return { signals: rankSignals(raw) }
}
