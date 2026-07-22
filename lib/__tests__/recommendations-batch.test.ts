import { describe, it, expect } from 'vitest'
import { RECOMMENDATIONS_PER_BATCH, ACTIVE_INTRO_CAP, getActiveIntroCap } from '@/lib/introductions/limits'
import { BATCH_CONFIG, effectiveTierDistribution } from '@/lib/matching/batch-scoring'
import { perRecipientIntroLimit } from '@/lib/matching/batch-limits'
import {
  isLawFirmLawyer, applyLawFirmCompositionPolicy,
  countUnresolvedRecommendations, releaseNextBatchIfComplete,
} from '@/lib/generate-recommendations'

describe('RECOMMENDATIONS_PER_BATCH — one central constant drives every path', () => {
  it('is 2 and is the single source of truth', () => {
    expect(RECOMMENDATIONS_PER_BATCH).toBe(2)
    expect(ACTIVE_INTRO_CAP).toBe(RECOMMENDATIONS_PER_BATCH)
    expect(getActiveIntroCap()).toBe(RECOMMENDATIONS_PER_BATCH)
    expect(getActiveIntroCap('executive')).toBe(RECOMMENDATIONS_PER_BATCH)
  })
  it('the admin reciprocal batch references the same constant', () => {
    expect(BATCH_CONFIG.introductionsPerMemberCap).toBe(RECOMMENDATIONS_PER_BATCH)
    // every tier is capped to the constant, so admin batches also deliver exactly this many
    expect(effectiveTierDistribution('free').total).toBe(RECOMMENDATIONS_PER_BATCH)
    expect(effectiveTierDistribution('executive').total).toBe(RECOMMENDATIONS_PER_BATCH)
    expect(perRecipientIntroLimit('free')).toBe(RECOMMENDATIONS_PER_BATCH)
  })
})

describe('law-firm composition policy — never two law-firm lawyers', () => {
  const viewer = { role_type: 'Law Firm Partner', city: 'Washington', expertise: ['Litigation', 'Legal'] }
  const gc = { id: 'gc', role_type: 'General Counsel' }
  const exec = { id: 'exec', role_type: 'COO' }
  const clonePeer = { id: 'clone', role_type: 'Law Firm Partner', city: 'Washington', expertise: ['Litigation', 'Compliance', 'Legal'] } // overlapping practice
  const strategicPeer = { id: 'strat', role_type: 'Law Firm Attorney', city: 'Washington', expertise: ['Regulatory', 'Legal'] } // complementary + same city
  const outOfTownPeer = { id: 'far', role_type: 'Law Firm Partner', city: 'Denver', expertise: ['Antitrust'] } // complementary but different city

  it('two clients when available → zero law-firm in the top 2', () => {
    const out = applyLawFirmCompositionPolicy([clonePeer, strategicPeer, gc, exec], viewer)
    const top2 = out.slice(0, 2)
    expect(top2.filter((c) => isLawFirmLawyer(c))).toHaveLength(0)
  })
  it('admits ONE strategic peer (complementary practice + same city) into slot 2', () => {
    const out = applyLawFirmCompositionPolicy([gc, strategicPeer, exec], viewer)
    const top2 = out.slice(0, 2)
    expect(isLawFirmLawyer(top2[0])).toBe(false)          // slot 1 is always a client
    expect(top2.filter((c) => isLawFirmLawyer(c))).toHaveLength(1)
    expect(top2[1].id).toBe('strat')
  })
  it('excludes a same-practice clone even if higher-ranked', () => {
    const out = applyLawFirmCompositionPolicy([clonePeer, gc, exec], viewer)
    const top2 = out.slice(0, 2)
    expect(top2.map((c) => c.id)).toEqual(['gc', 'exec'])   // clone demoted below the batch
  })
  it('excludes a complementary peer that lacks the local (same-city) signal', () => {
    const out = applyLawFirmCompositionPolicy([gc, outOfTownPeer, exec], viewer)
    expect(out.slice(0, 2).filter((c) => isLawFirmLawyer(c))).toHaveLength(0)
  })
  it('never places a peer in slot 1 (always ≥1 client)', () => {
    const out = applyLawFirmCompositionPolicy([strategicPeer, gc, exec], viewer)
    expect(isLawFirmLawyer(out[0])).toBe(false)
  })
  it('leaves a non-law-firm viewer’s ranking unchanged', () => {
    const gcViewer = { role_type: 'General Counsel' }
    const input = [clonePeer, gc, strategicPeer, exec]
    expect(applyLawFirmCompositionPolicy(input, gcViewer)).toEqual(input)
  })
})

// ---- batch-completion mock client ----
function makeAdmin(rows: any[]) {
  const build = () => {
    const eqs: Record<string, any> = {}
    const ins: Record<string, Set<any>> = {}
    let update: any = null
    const b: any = {
      select: () => b,
      update: (u: any) => { update = u; return b },
      eq: (k: string, v: any) => { eqs[k] = v; return b },
      in: (k: string, arr: any[]) => { ins[k] = new Set(arr); return b },
      then: (res: any, rej: any) => {
        const match = rows.filter((r) =>
          Object.entries(eqs).every(([k, v]) => r[k] === v) &&
          Object.entries(ins).every(([k, s]) => s.has(r[k])))
        if (update) { for (const r of match) Object.assign(r, update); return Promise.resolve({ data: null, error: null }).then(res, rej) }
        return Promise.resolve({ data: match.map((r) => ({ target_user_id: r.target_user_id })), error: null }).then(res, rej)
      },
    }
    return b
  }
  return { from: () => build() } as any
}

describe('batch completion — interest OR pass resolves; both must resolve', () => {
  it('counts an unacted suggestion as unresolved', async () => {
    const admin = makeAdmin([
      { requester_id: 'u', target_user_id: 'A', status: 'suggested' },
      { requester_id: 'u', target_user_id: 'B', status: 'suggested' },
    ])
    expect(await countUnresolvedRecommendations(admin, 'u')).toBe(2)
  })
  it('expressed interest resolves a suggestion even while pending (row left in place)', async () => {
    const admin = makeAdmin([
      { requester_id: 'u', target_user_id: 'A', status: 'suggested' },
      { requester_id: 'u', target_user_id: 'A', status: 'pending' }, // expressed interest
      { requester_id: 'u', target_user_id: 'B', status: 'suggested' },
    ])
    expect(await countUnresolvedRecommendations(admin, 'u')).toBe(1) // only B unresolved
  })
  it('a passed suggestion is no longer suggested → resolved; batch complete when both acted', async () => {
    const admin = makeAdmin([
      { requester_id: 'u', target_user_id: 'A', status: 'suggested' },
      { requester_id: 'u', target_user_id: 'A', status: 'pending' }, // interest
      { requester_id: 'u', target_user_id: 'B', status: 'passed' },  // passed → not 'suggested'
    ])
    expect(await countUnresolvedRecommendations(admin, 'u')).toBe(0)
  })
  it('no suggestions → complete (0 unresolved)', async () => {
    expect(await countUnresolvedRecommendations(makeAdmin([]), 'u')).toBe(0)
  })
})

describe('release gating — no new batch while the current one is open', () => {
  it('does NOT release (and does not archive) when a recommendation is unresolved', async () => {
    const rows = [
      { requester_id: 'u', target_user_id: 'A', status: 'suggested' },
      { requester_id: 'u', target_user_id: 'B', status: 'suggested' },
    ]
    const admin = makeAdmin(rows)
    const out = await releaseNextBatchIfComplete(admin, 'u')
    expect(out.released).toBe(false)
    expect(out.count).toBe(0)
    // the open suggestions were left intact (not archived)
    expect(rows.every((r) => r.status === 'suggested')).toBe(true)
  })
})
