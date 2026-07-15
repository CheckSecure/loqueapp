import { describe, it, expect } from 'vitest'
import {
  buildIntroReasons,
  introReasonText,
  GENERIC_INTRO_FALLBACK,
} from '@/lib/match-signals'

// Any gendered pronoun as a whole word. Names are allowed (they are not
// pronouns) — this catches he/she/his/her inference, which must never appear.
const GENDERED = /\b(he|him|his|she|her|hers)\b/i

describe('intro reasons — no gender inference', () => {
  it('never emits gendered pronouns, even for names the old code special-cased', () => {
    // "Sarah", "Priya", "Alexandra" and any name ending in "a" were forced to
    // "She" by the old engine; "John" fell through to "He".
    for (const full_name of ['Sarah Chen', 'Priya Patel', 'Alexandra Reed', 'Joshua Kim', 'John Doe']) {
      const reasons = buildIntroReasons(
        { expertise: ['AI'], role_type: 'Software Engineer', seniority: 'Senior' },
        { full_name, expertise: ['AI', 'ML'], role_type: 'Software Engineer', seniority: 'Senior' },
      )
      expect(reasons.length).toBeGreaterThan(0)
      for (const r of reasons) expect(r).not.toMatch(GENDERED)
    }
  })

  it('uses the candidate name (not a guessed pronoun) for directional reasons', () => {
    const reasons = buildIntroReasons(
      { expertise: ['Marketing'] },
      { full_name: 'Dana Alvarez', expertise: ['Data Science'] },
    )
    expect(reasons.some((r) => r.startsWith('Dana '))).toBe(true)
    for (const r of reasons) expect(r).not.toMatch(GENDERED)
  })
})

describe('intro reasons — specific signals', () => {
  it('shared expertise produces a specific reason', () => {
    const reasons = buildIntroReasons(
      { expertise: ['Litigation', 'M&A'] },
      { full_name: 'Alex Kim', expertise: ['M&A', 'Litigation', 'Tax'] },
    )
    expect(reasons.some((r) => r.includes('You share expertise in') && r.includes('Litigation'))).toBe(true)
  })

  it('complementary expertise produces a specific reason when nothing is shared', () => {
    const reasons = buildIntroReasons(
      { expertise: ['Brand Marketing'] },
      { full_name: 'Sam Ford', expertise: ['Data Engineering'] },
    )
    expect(reasons.some((r) => r === 'Sam brings expertise in Data Engineering')).toBe(true)
    // ...and never both a "brings expertise" and a "share expertise" bullet.
    expect(reasons.some((r) => r.includes('You share expertise'))).toBe(false)
  })

  it('reflects a stated hiring goal', () => {
    const reasons = buildIntroReasons(
      { purposes: ['Hiring'] },
      { full_name: 'Robin Vale', open_to_roles: true },
    )
    expect(reasons).toContain('Robin is open to new roles')
  })

  it('reflects a business-development goal', () => {
    const reasons = buildIntroReasons(
      { open_to_business_solutions: true },
      { full_name: 'Lee Ono', purposes: ['Business Development'] },
    )
    expect(reasons).toContain('Lee works in business development')
  })

  it('reflects complementary mentorship intent', () => {
    const reasons = buildIntroReasons(
      { mentorship_role: 'mentee' },
      { full_name: 'Kai Ross', mentorship_role: 'mentor' },
    )
    expect(reasons.some((r) => r.startsWith('Mentorship fit'))).toBe(true)
  })
})

describe('intro reasons — robustness & ranking', () => {
  it('a missing company still yields a useful, non-generic reason', () => {
    const text = introReasonText(
      { expertise: ['Product Strategy'], location: 'New York' },
      { full_name: 'Noa Berg', expertise: ['Product Strategy'], location: 'New York' /* no company */ },
    )
    expect(text).not.toBe(GENERIC_INTRO_FALLBACK)
    expect(text).toContain('Product Strategy')
  })

  it('seniority is never the sole reason when a stronger signal exists', () => {
    const reasons = buildIntroReasons(
      { expertise: ['Cybersecurity'], seniority: 'Executive' },
      { full_name: 'Jo Park', expertise: ['Cybersecurity'], seniority: 'Executive' },
    )
    // A stronger signal (shared expertise) leads; seniority may support but is
    // never alone.
    expect(reasons[0]).toContain('You share expertise in')
    expect(reasons.length === 1 && /career stage/.test(reasons[0])).toBe(false)
  })

  it('seniority alone is allowed as a meaningful (weak) reason', () => {
    const reasons = buildIntroReasons(
      { seniority: 'Senior' },
      { full_name: 'Ira Vance', seniority: 'Senior' },
    )
    expect(reasons).toEqual(["You're at a similar career stage"])
  })

  it('caps at three reasons and removes duplicates/overlap', () => {
    const rich = {
      full_name: 'Max Stone',
      expertise: ['AI', 'Privacy'],
      purposes: ['Mentorship'],
      role_type: 'Software Engineer',
      industry: 'Fintech',
      seniority: 'Senior',
      location: 'Austin',
    }
    const viewer = {
      expertise: ['AI', 'Privacy'],
      purposes: ['Mentorship'],
      role_type: 'Software Engineer',
      industry: 'Fintech',
      seniority: 'Senior',
      location: 'Austin',
    }
    const reasons = buildIntroReasons(viewer, rich)
    expect(reasons.length).toBeLessThanOrEqual(3)
    expect(new Set(reasons).size).toBe(reasons.length) // no duplicates
  })
})

describe('intro reasons — fallback & determinism', () => {
  it('uses the restrained fallback only when no meaningful signal exists', () => {
    // Genuinely no overlapping or usable signal: different role/seniority/
    // location, no shared or complementary expertise, no goals.
    const nothing = introReasonText(
      { role_type: 'Accountant', seniority: 'Junior', location: 'Denver' },
      { full_name: 'Pat Roe', role_type: 'Researcher', seniority: 'Executive', location: 'Oslo' },
    )
    expect(nothing).toBe(GENERIC_INTRO_FALLBACK)
  })

  it('is deterministic — same pair produces identical reasons every call', () => {
    const viewer = { expertise: ['AI', 'ML'], role_type: 'Data Scientist', seniority: 'Senior' }
    const cand = { full_name: 'Quinn Ito', expertise: ['ML', 'AI'], role_type: 'Data Scientist', seniority: 'Senior' }
    const first = buildIntroReasons(viewer, cand)
    for (let i = 0; i < 8; i++) expect(buildIntroReasons(viewer, cand)).toEqual(first)
  })

  it('different pairs with different data receive different explanations', () => {
    const viewer = { expertise: ['AI'], purposes: ['Hiring'] }
    const a = introReasonText(viewer, { full_name: 'Ada Lore', expertise: ['AI'] })
    const b = introReasonText(viewer, { full_name: 'Ben Cole', open_to_roles: true })
    expect(a).not.toBe(b)
  })
})

describe('intro reasons — mutual (symmetric) mode for admin intros', () => {
  it('drops direction-specific reasons and never leads with a candidate name', () => {
    const a = {
      full_name: 'Dana Alvarez',
      expertise: ['Marketing'],
      desired_connections: { Engineering: [] },
      purposes: ['Hiring'],
    }
    const b = {
      full_name: 'Sam Ford',
      expertise: ['Data Engineering'],
      role_type: 'Software Engineer',
      open_to_roles: true,
      location: 'Remote',
    }
    const mutual = buildIntroReasons(a, b, { mutual: true, max: 1 })
    // No "Sam ..." / "Dana ..." directional phrasing, and never a "You asked
    // to meet" (viewer-specific) reason.
    for (const r of mutual) {
      expect(r.startsWith('Sam')).toBe(false)
      expect(r.startsWith('Dana')).toBe(false)
      expect(r).not.toMatch(/You asked to meet/)
    }
  })
})
