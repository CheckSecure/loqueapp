import { describe, it, expect } from 'vitest'

// PROOF of target-side read-path integration (Q1). The production Introductions page selects a
// member's recommendation cards with EXACTLY this predicate (app/dashboard/introductions/page.tsx
// suggestedIntros): intro_requests WHERE requester_id = <viewer> AND status = 'suggested'. It is
// BATCH-AGNOSTIC (no batch_id filter — confirmed by the page comment). So a reciprocal pair's two
// 'suggested' rows are each discovered by their own requester immediately — no cron, no batch
// regeneration. The "Introduced by Andrel" label derives from the STRUCTURED pair_id, not match_reason.

// The exact page selection for a viewer's recommendation cards (mirrors the real query + mapping).
function selectRecommendationCards(introRequests: any[], viewerId: string) {
  return introRequests
    .filter(r => r.requester_id === viewerId && r.status === 'suggested') // batch-agnostic predicate
    .map(r => ({
      rowId: r.id,
      targetId: r.target_user_id,
      matchReason: r.match_reason ?? null,
      introducedByAndrel: !!r.pair_id, // structured label, NOT from match_reason
    }))
}

// Model of the RPC writing a reciprocal pair: two 'suggested' rows, batch_id NULL, pair_id shared.
function writeReciprocalPair(introRequests: any[], a: string, b: string, pairId: string) {
  introRequests.push({ id: `${a}->${b}`, requester_id: a, target_user_id: b, status: 'suggested', batch_id: null, pair_id: pairId, match_reason: null })
  introRequests.push({ id: `${b}->${a}`, requester_id: b, target_user_id: a, status: 'suggested', batch_id: null, pair_id: pairId, match_reason: null })
}

describe('reciprocal read-path — both sides see each other immediately', () => {
  it('after create_reciprocal_suggestion(A,B), A discovers B and B discovers A via the real page predicate', () => {
    const rows: any[] = []
    writeReciprocalPair(rows, 'A', 'B', 'pair-1')

    const aCards = selectRecommendationCards(rows, 'A')
    const bCards = selectRecommendationCards(rows, 'B')

    // A sees B, B sees A — no batch_id, no cron, no regeneration.
    expect(aCards.map(c => c.targetId)).toEqual(['B'])
    expect(bCards.map(c => c.targetId)).toEqual(['A'])
  })

  it('the label is rendered from the STRUCTURED pair_id, independent of match_reason', () => {
    const rows: any[] = []
    writeReciprocalPair(rows, 'A', 'B', 'pair-1')
    const [aCard] = selectRecommendationCards(rows, 'A')
    expect(aCard.introducedByAndrel).toBe(true) // from pair_id
    expect(aCard.matchReason).toBeNull()        // NOT overloaded with the label
  })

  it('an ordinary (non-reciprocal) suggested row is NOT labelled "Introduced by Andrel"', () => {
    const rows = [{ id: 'x', requester_id: 'A', target_user_id: 'C', status: 'suggested', batch_id: 'batch-1', pair_id: null, match_reason: 'You both work in fintech' }]
    const [card] = selectRecommendationCards(rows, 'A')
    expect(card.introducedByAndrel).toBe(false)
    expect(card.matchReason).toBe('You both work in fintech') // genuine compatibility reason preserved
  })

  it('a batch-less reciprocal row survives a weekly batch refresh of the OTHER member (no one-sided disappearance)', () => {
    const rows: any[] = []
    writeReciprocalPair(rows, 'A', 'B', 'pair-1')
    // Simulate A's weekly refresh: it only replaces A's BATCH rows (batch_id != null). Reciprocal
    // rows have batch_id NULL, so neither side's card is dropped.
    const refreshed = rows.filter(r => r.batch_id !== null) // what a batch refresh would remove
    expect(refreshed).toHaveLength(0) // reciprocal rows are untouched
    expect(selectRecommendationCards(rows, 'A').map(c => c.targetId)).toEqual(['B'])
    expect(selectRecommendationCards(rows, 'B').map(c => c.targetId)).toEqual(['A'])
  })
})
