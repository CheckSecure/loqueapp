import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildMatchIntelligence, rankSignals, MAX_MATCH_SIGNALS, type MatchSignal } from '@/lib/matchIntelligence'

// ── Extractors (via the builder) ─────────────────────────────────────────────
const A = {
  role_type: 'General Counsel', seniority: 'Senior',
  expertise: ['Cybersecurity', 'Investigations', 'M&A'], purposes: ['Networking'],
  mentorship_role: 'Mentor', location: 'Washington, DC',
}

describe('extractors produce concise, member-friendly signals', () => {
  it('role framing (shared role_type → field phrase, not "Same role type")', () => {
    const s = buildMatchIntelligence({ role_type: 'General Counsel' }, { role_type: 'General Counsel' }).signals
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ category: 'role', label: 'You both work in legal.' })
    expect(s[0].label).not.toContain('Same role type')
  })

  it('expertise overlap (lists shared skills)', () => {
    const s = buildMatchIntelligence({ expertise: ['Cybersecurity', 'Investigations'] }, { expertise: ['cybersecurity', 'investigations'] }).signals
    expect(s[0]).toMatchObject({ category: 'expertise' })
    expect(s[0].label).toBe('Shared expertise in cybersecurity and investigations.')
  })

  it('purposes overlap (friendly phrasing, not "Shared purposes")', () => {
    const s = buildMatchIntelligence({ purposes: ['Networking'] }, { purposes: ['networking'] }).signals
    expect(s[0]).toMatchObject({ category: 'purpose', label: "You're both looking to expand your professional network." })
    expect(s[0].label).not.toContain('Shared purposes')
  })

  it('mentorship alignment (complementary vs aligned)', () => {
    expect(buildMatchIntelligence({ mentorship_role: 'Mentor' }, { mentorship_role: 'Mentee' }).signals[0].label)
      .toBe('Your mentorship interests are complementary.')
    expect(buildMatchIntelligence({ mentorship_role: 'Both' }, { mentorship_role: 'Both' }).signals[0].label)
      .toBe('Your mentorship preferences align.')
  })

  it('exact geography overlap', () => {
    const s = buildMatchIntelligence({ location: 'Washington, DC' }, { location: 'washington, dc' }).signals
    expect(s[0]).toMatchObject({ category: 'geography', label: "You're both based in Washington, DC." })
  })

  it('seniority phrased as career stage (not "Similar seniority")', () => {
    const s = buildMatchIntelligence({ seniority: 'Senior' }, { seniority: 'Senior' }).signals
    expect(s[0].label).toBe("You're at a similar career stage.")
    expect(s[0].label).not.toContain('Similar seniority')
  })

  it('no overlap → no signals (card then falls back to match_reason)', () => {
    expect(buildMatchIntelligence({ role_type: 'CFO' }, { role_type: 'CTO' }).signals).toEqual([])
    expect(buildMatchIntelligence(null, {}).signals).toEqual([])
  })
})

// ── Ordering / dedup / cap ───────────────────────────────────────────────────
describe('ranking rules', () => {
  it('priority ordering (role → expertise → mentorship → purpose → geography)', () => {
    const cats = buildMatchIntelligence(A, {
      role_type: 'General Counsel', expertise: ['cybersecurity'], purposes: ['networking'],
      mentorship_role: 'Mentee', location: 'Washington, DC', seniority: 'Senior',
    }).signals.map((s) => s.category)
    expect(cats).toEqual(['role', 'expertise', 'mentorship', 'purpose', 'geography']) // seniority (prio 60) dropped by the cap
  })

  it('five-item cap', () => {
    const s = buildMatchIntelligence(A, {
      role_type: 'General Counsel', expertise: ['cybersecurity'], purposes: ['networking'],
      mentorship_role: 'Mentee', location: 'Washington, DC', seniority: 'Senior',
    }).signals
    expect(s.length).toBe(MAX_MATCH_SIGNALS)
    expect(s.map((x) => x.category)).not.toContain('seniority') // lowest priority, cut
  })

  it('specificity ordering breaks priority ties (higher specificity first)', () => {
    const mk = (key: string, specificity: number): MatchSignal => ({ key, category: 'expertise', label: key, priority: 10, specificity })
    const ranked = rankSignals([mk('low', 30), mk('high', 90)])
    expect(ranked.map((s) => s.key)).toEqual(['high', 'low'])
  })

  it('deduplicates by key (first wins)', () => {
    const dup = (label: string): MatchSignal => ({ key: 'role', category: 'role', label, priority: 10, specificity: 50 })
    const ranked = rankSignals([dup('first'), dup('second')])
    expect(ranked).toHaveLength(1)
    expect(ranked[0].label).toBe('first')
  })

  it('caps a large set at five', () => {
    const many: MatchSignal[] = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, category: 'expertise', label: `k${i}`, priority: i, specificity: 50 }))
    expect(rankSignals(many)).toHaveLength(5)
  })
})

// ── Signal shape ─────────────────────────────────────────────────────────────
describe('structured signal shape', () => {
  it('every signal has key/category/label/priority/specificity', () => {
    for (const s of buildMatchIntelligence(A, { ...A }).signals) {
      expect(s).toHaveProperty('key')
      expect(s).toHaveProperty('category')
      expect(typeof s.label).toBe('string')
      expect(typeof s.priority).toBe('number')
      expect(typeof s.specificity).toBe('number')
    }
  })
})

// ── Structural: card fallback + isolation + wiring ───────────────────────────
describe('card fallback + isolation + wiring', () => {
  const extractors = readFileSync('lib/matchIntelligence/extractors.ts', 'utf8')
  const index = readFileSync('lib/matchIntelligence/index.ts', 'utf8')
  const card = readFileSync('components/MatchIntelligenceCard.tsx', 'utf8')
  const page = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
  const adminCard = readFileSync('components/AdminIntroCard.tsx', 'utf8')
  const incomingCard = readFileSync('components/IncomingInterestCard.tsx', 'utf8')

  it('the card preserves the newline-bullet fallback contract + generic fallback', () => {
    expect(card).toContain("text.split('\\n')")
    expect(card).toMatch(/lines\.length > 1/)
    expect(card).toContain('<ul')
    expect(card).toContain('Curated based on your profile and preferences.')
  })

  it('the framework reads NO focus areas / roles / previous_roles / scoring', () => {
    for (const src of [extractors, index]) {
      expect(src).not.toContain('current_focus_areas')
      expect(src).not.toContain('profile_roles')
      expect(src).not.toContain('previous_roles')
      expect(src).not.toContain('generate-recommendations')
      expect(src).not.toContain('batch-scoring')
      expect(src).not.toContain('lib/scoring')
    }
  })

  it('all three pre-connection surfaces use MatchIntelligenceCard', () => {
    expect(page).toContain('<MatchIntelligenceCard')
    expect(adminCard).toContain('<MatchIntelligenceCard')
    expect(incomingCard).toContain('<MatchIntelligenceCard')
  })

  it('surfaces pass structured signals + keep match_reason as fallback', () => {
    expect(page).toContain('buildMatchIntelligence(profileRow, intro.other).signals')
    expect(page).toContain('buildMatchIntelligence(profileRow, item.requester).signals')
    expect(adminCard).toContain('fallbackReason={matchReason}')
    expect(incomingCard).toContain('fallbackReason={matchReason}')
  })

  it('no duplicate chips: the old commonGround render is neutralized', () => {
    expect(page).toContain('const renderCommonGround = (_row: any) => null')
  })
})
