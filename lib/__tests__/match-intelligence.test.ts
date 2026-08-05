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

// ── Phase B extractors: focus areas, additional roles, previous employers ────
describe('Phase B — focus areas', () => {
  it('exact overlap → concise line (viewer casing)', () => {
    const s = buildMatchIntelligence({}, {}, { viewerFocus: ['Nuclear energy'], viewedFocus: ['nuclear energy'] }).signals
    expect(s[0]).toMatchObject({ category: 'focus', label: "You're both currently focused on Nuclear energy." })
  })
  it('is case-insensitive', () => {
    const s = buildMatchIntelligence({}, {}, { viewerFocus: ['NUCLEAR ENERGY'], viewedFocus: ['nuclear energy'] }).signals
    expect(s).toHaveLength(1)
  })
  it('does NOT match near-synonyms', () => {
    const s = buildMatchIntelligence({}, {}, { viewerFocus: ['nuclear energy'], viewedFocus: ['nuclear power'] }).signals
    expect(s).toEqual([])
  })
  it('caps focus reasons at 2', () => {
    const s = buildMatchIntelligence({}, {}, { viewerFocus: ['a', 'b', 'c'], viewedFocus: ['a', 'b', 'c'] }).signals
    expect(s.filter((x) => x.category === 'focus')).toHaveLength(2)
  })
})

describe('Phase B — additional roles', () => {
  it('same organization → "active in {Org} leadership" (board/committee)', () => {
    const s = buildMatchIntelligence({}, {}, {
      viewerRoles: [{ organization_name: 'ACC', role_category: 'committee_leadership' }],
      viewedRoles: [{ organization_name: 'acc', role_category: 'board_member' }],
    }).signals
    expect(s[0]).toMatchObject({ category: 'affiliation', label: "You're both active in ACC leadership." })
  })
  it('same organization (non-leadership) → "active in {Org}"', () => {
    const s = buildMatchIntelligence({}, {}, {
      viewerRoles: [{ organization_name: 'Rotary Club', role_category: 'nonprofit' }],
      viewedRoles: [{ organization_name: 'rotary club', role_category: 'nonprofit' }],
    }).signals
    expect(s[0].label).toBe("You're both active in Rotary Club.")
  })
  it('category overlap WITHOUT shared org → category phrase', () => {
    const s = buildMatchIntelligence({}, {}, {
      viewerRoles: [{ organization_name: 'Fund A', role_category: 'investor_fund' }],
      viewedRoles: [{ organization_name: 'Fund B', role_category: 'investor_fund' }],
    }).signals
    expect(s[0]).toMatchObject({ category: 'affiliation', label: 'You share experience in investment-fund governance.' })
  })
  it('board+advisory mix → board-or-advisory line', () => {
    const s = buildMatchIntelligence({}, {}, {
      viewerRoles: [{ organization_name: 'X', role_category: 'board_member' }],
      viewedRoles: [{ organization_name: 'Y', role_category: 'advisor' }],
    }).signals
    expect(s[0].label).toBe('You both serve in board or advisory roles.')
  })
  it('fails open when roles are absent (missing ctx → no crash, no signal)', () => {
    expect(buildMatchIntelligence({}, {}, {}).signals).toEqual([])
    expect(buildMatchIntelligence({}, {}, { viewerRoles: undefined, viewedRoles: undefined }).signals).toEqual([])
  })
})

describe('Phase B — previous employers', () => {
  it('exact organization overlap only', () => {
    const s = buildMatchIntelligence({}, {}, {
      viewerPrev: [{ company: 'Microsoft', title: 'PM' }],
      viewedPrev: [{ company: 'microsoft', title: 'Engineer' }],
    }).signals
    expect(s[0]).toMatchObject({ category: 'previous', label: 'You both previously worked at Microsoft.' })
  })
  it('does NOT infer from title similarity (different companies)', () => {
    const s = buildMatchIntelligence({}, {}, {
      viewerPrev: [{ company: 'Google', title: 'General Counsel' }],
      viewedPrev: [{ company: 'Amazon', title: 'General Counsel' }],
    }).signals
    expect(s).toEqual([])
  })
})

describe('Phase B — concept dedup + ordering', () => {
  it('a focus term suppresses a redundant expertise line (no duplicate concepts)', () => {
    const s = buildMatchIntelligence(
      { expertise: ['Nuclear energy'] }, { expertise: ['nuclear energy'] },
      { viewerFocus: ['Nuclear energy'], viewedFocus: ['nuclear energy'] },
    ).signals
    const cats = s.map((x) => x.category)
    expect(cats).toContain('focus')
    expect(cats).not.toContain('expertise') // deduped by concept
  })

  it('priority ordering across Phase A+B (role→focus→affiliation→expertise→previous)', () => {
    const s = buildMatchIntelligence(
      { role_type: 'General Counsel', expertise: ['contracts'] },
      { role_type: 'General Counsel', expertise: ['contracts'] },
      {
        viewerFocus: ['solar'], viewedFocus: ['solar'],
        viewerRoles: [{ organization_name: 'ACC', role_category: 'professional_association' }],
        viewedRoles: [{ organization_name: 'acc', role_category: 'professional_association' }],
        viewerPrev: [{ company: 'IBM' }], viewedPrev: [{ company: 'ibm' }],
      },
    ).signals
    expect(s.map((x) => x.category)).toEqual(['role', 'focus', 'affiliation', 'expertise', 'previous'])
  })

  it('still caps the combined set at five', () => {
    const s = buildMatchIntelligence(
      { role_type: 'General Counsel', expertise: ['contracts'], seniority: 'Senior', location: 'DC', purposes: ['Networking'], mentorship_role: 'Mentor' },
      { role_type: 'General Counsel', expertise: ['contracts'], seniority: 'Senior', location: 'DC', purposes: ['networking'], mentorship_role: 'Mentee' },
      { viewerFocus: ['solar'], viewedFocus: ['solar'] },
    ).signals
    expect(s).toHaveLength(5)
  })
})

// ── Phase C — conversation starters ──────────────────────────────────────────
import { generateConversationStarters } from '@/lib/matchIntelligence'

describe('Phase C — conversation starters', () => {
  const starters = (ctx: any, viewer: any = {}, viewed: any = {}) => buildMatchIntelligence(viewer, viewed, ctx).starters

  it('focus-area starter', () => {
    expect(starters({ viewerFocus: ['Nuclear energy'], viewedFocus: ['nuclear energy'] }))
      .toContain("Ask how they're approaching nuclear energy right now.")
  })

  it('affiliation starter (named org)', () => {
    const s = starters({
      viewerRoles: [{ organization_name: 'ACC', role_category: 'board_member' }],
      viewedRoles: [{ organization_name: 'acc', role_category: 'committee_leadership' }],
    })
    expect(s).toContain('Ask how they got involved with ACC.')
  })

  it('affiliation starter (category, no shared org)', () => {
    const s = starters({
      viewerRoles: [{ organization_name: 'Fund A', role_category: 'investor_fund' }],
      viewedRoles: [{ organization_name: 'Fund B', role_category: 'investor_fund' }],
    })
    expect(s).toContain('Compare notes on fund governance.')
  })

  it('expertise starter', () => {
    const s = starters({}, { expertise: ['Cybersecurity'] }, { expertise: ['cybersecurity'] })
    expect(s).toContain('Compare your approaches to cybersecurity.')
  })

  it('mentorship starter', () => {
    const s = starters({}, { mentorship_role: 'Mentor' }, { mentorship_role: 'Mentee' })
    expect(s).toContain('Ask what kinds of professionals they enjoy mentoring most.')
  })

  it('previous-employer starter', () => {
    const s = starters({ viewerPrev: [{ company: 'Microsoft' }], viewedPrev: [{ company: 'microsoft' }] })
    expect(s).toContain('Ask what their time at Microsoft was like.')
  })

  it('purpose starter', () => {
    const s = starters({}, { purposes: ['Networking'] }, { purposes: ['networking'] })
    expect(s).toContain('Compare how you each grow your networks.')
  })

  it('never fabricates — no overlap → no starters', () => {
    expect(starters({}, { role_type: 'CFO' }, { role_type: 'CTO' })).toEqual([])
    expect(starters({})).toEqual([])
  })

  it('produces nothing for role/geography/seniority-only overlaps (no starter category)', () => {
    const s = starters({}, { role_type: 'GC', location: 'DC', seniority: 'Senior' }, { role_type: 'GC', location: 'DC', seniority: 'Senior' })
    expect(s).toEqual([])
  })

  it('no duplicates and at most 3', () => {
    const s = buildMatchIntelligence(
      { expertise: ['contracts'], purposes: ['Networking'], mentorship_role: 'Mentor' },
      { expertise: ['contracts'], purposes: ['networking'], mentorship_role: 'Mentee' },
      {
        viewerFocus: ['solar', 'wind'], viewedFocus: ['solar', 'wind'],
        viewerRoles: [{ organization_name: 'ACC', role_category: 'board_member' }],
        viewedRoles: [{ organization_name: 'acc', role_category: 'board_member' }],
        viewerPrev: [{ company: 'IBM' }], viewedPrev: [{ company: 'ibm' }],
      },
    ).starters
    expect(s.length).toBeLessThanOrEqual(3)
    expect(new Set(s).size).toBe(s.length) // no duplicates
  })

  it('every starter stays under ~90 chars and never echoes a "why" line', () => {
    const built = buildMatchIntelligence(
      { expertise: ['cybersecurity'] }, { expertise: ['cybersecurity'] },
      { viewerFocus: ['nuclear energy'], viewedFocus: ['nuclear energy'] },
    )
    const labels = new Set(built.signals.map((s) => s.label))
    for (const st of built.starters) {
      expect(st.length).toBeLessThanOrEqual(90)
      expect(labels.has(st)).toBe(false)
    }
  })

  it('generateConversationStarters is pure — empty signals → []', () => {
    expect(generateConversationStarters({}, {}, [], {})).toEqual([])
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

  it('surfaces pass structured signals + starters (+ Phase B context) + keep match_reason fallback', () => {
    expect(page).toContain('miFor(intro.other, intro.other.id).signals')
    expect(page).toContain('miFor(item.requester, item.requesterId).signals')
    expect(page).toContain('starters={miFor(intro.other, intro.other.id).starters}')
    expect(page).toContain('starters={miFor(item.requester, item.requesterId).starters}')
    expect(adminCard).toContain('fallbackReason={matchReason}')
    expect(incomingCard).toContain('fallbackReason={matchReason}')
  })

  it('the card renders a Conversation starters section (Phase C)', () => {
    const card = readFileSync('components/MatchIntelligenceCard.tsx', 'utf8')
    expect(card).toContain('Conversation starters')
    expect(card).toContain('ConversationStarters')
  })

  it('Phase B data is fetched in bulk (no N+1) and fail-open', () => {
    // one roles query for all ids, one profiles query for focus+previous
    expect(page).toContain('listRolesForProfiles(miAdmin, miIds)')
    expect(page).toContain(".in('id', miIds)")
    expect(page).toContain('miContext')
    // fail-open fallback to previous-only when 041 is unapplied
    expect(page).toContain("select('id, previous_roles')")
  })

  it('no duplicate chips: the old commonGround render is neutralized', () => {
    expect(page).toContain('const renderCommonGround = (_row: any) => null')
  })
})
