// Typed database-boundary mapping for scoring signals. The generator previously read camelCase
// properties (`networkValueScore` / `responsivenessScore`) off raw `profiles` rows, but the real
// columns are snake_case (`network_value_score` / `responsiveness_score`) — so those reads were
// always undefined and collapsed 45% of the fit score to a constant 50 for every candidate. This
// maps the real columns explicitly (falling back to the neutral 50 only when genuinely absent).

export interface ScoringSignals {
  networkValueScore: number
  responsivenessScore: number
}

export const NEUTRAL_SIGNAL = 50

export function readScoringSignals(row: {
  network_value_score?: number | null
  responsiveness_score?: number | null
} | null | undefined): ScoringSignals {
  const nv = row?.network_value_score
  const rs = row?.responsiveness_score
  return {
    networkValueScore: typeof nv === 'number' && Number.isFinite(nv) ? nv : NEUTRAL_SIGNAL,
    responsivenessScore: typeof rs === 'number' && Number.isFinite(rs) ? rs : NEUTRAL_SIGNAL,
  }
}
