import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  preferenceMatchesRole, rolesSatisfying, PREFERENCE_TARGETS, UNMAPPED_PREFERENCES,
} from '@/lib/matching/introPreferenceMatch'
import { buildScoringContext, scoreMatch, BATCH_CONFIG } from '@/lib/matching/batch-scoring'

/**
 * intro_preferences stores CATEGORIES ('Legal') and relationships ('Founders'); role_type
 * stores TITLES ('General Counsel'). The old test was array membership on the lowercased
 * title, so the +30/+20 preference bonus — 50 of the 40 points needed to clear the relevance
 * floor — fired for essentially nobody.
 */
describe('intro_preferences → role_type vocabulary bridge', () => {
  it('the defect: a raw string compare never matches a real pair', () => {
    // This is what the scorer used to do.
    expect(['legal'].includes('general counsel')).toBe(false)
    expect(['executive / c-suite'].includes('law firm partner')).toBe(false)
  })

  it('"Legal" is satisfied by every legal title on the platform', () => {
    for (const role of ['General Counsel', 'In-House Counsel', 'Associate General Counsel',
                        'Deputy General Counsel', 'Chief Legal Officer', 'Law Firm Partner',
                        'Legal Operations'])
      expect(preferenceMatchesRole('Legal', role), role).toBe(true)
  })

  // ── Operator decisions, pinned so they cannot be silently reverted. ──
  it('Chief Legal Officer satisfies BOTH Legal and Executive / C-Suite', () => {
    expect(preferenceMatchesRole('Legal', 'Chief Legal Officer')).toBe(true)
    expect(preferenceMatchesRole('Executive / C-Suite', 'Chief Legal Officer')).toBe(true)
  })

  it('CISO satisfies Executive / C-Suite without leaving its own category', () => {
    expect(preferenceMatchesRole('Executive / C-Suite', 'CISO')).toBe(true)
  })

  it('Founders is title-level: Founder yes, CEO/COO/President no', () => {
    expect(preferenceMatchesRole('Founders', 'Founder')).toBe(true)
    for (const role of ['CEO', 'COO', 'President', 'Chief Strategy Officer'])
      expect(preferenceMatchesRole('Founders', role), role).toBe(false)
  })

  it('the picker aliases resolve to the taxonomy keys', () => {
    expect(preferenceMatchesRole('Investor / VC', 'Operating Partner')).toBe(true)
    expect(preferenceMatchesRole('Investors', 'General Partner')).toBe(true)
    expect(preferenceMatchesRole('Government / Policy', 'Public Policy Executive')).toBe(true)
  })

  it('relationship preferences match no role, deliberately', () => {
    for (const pref of Object.keys(UNMAPPED_PREFERENCES))
      for (const role of ['Founder', 'General Counsel', 'CEO', 'Investor'])
        expect(preferenceMatchesRole(pref, role), `${pref}/${role}`).toBe(false)
  })

  it('unknown preference values fall back to exact match — nothing that worked stops working', () => {
    expect(preferenceMatchesRole('Executive / C-Suite', 'Executive / C-Suite')).toBe(true)
    expect(preferenceMatchesRole('Some Future Value', 'Some Future Value')).toBe(true)
    expect(preferenceMatchesRole('Some Future Value', 'General Counsel')).toBe(false)
  })

  it('stored case differences still resolve', () => {
    expect(preferenceMatchesRole('legal', 'General Counsel')).toBe(true)
    expect(preferenceMatchesRole('LEGAL', 'Law Firm Partner')).toBe(true)
  })

  it('every mapped preference resolves to at least one role', () => {
    for (const pref of Object.keys(PREFERENCE_TARGETS))
      expect(rolesSatisfying(pref).length, pref).toBeGreaterThan(0)
  })

  // ── End to end: the bonus now actually fires, and it clears the floor. ──
  it('a Founder ↔ GC pair with reciprocal preferences now clears MIN_RELEVANCE_SCORE', () => {
    const base = (o: any) => ({
      account_status: 'active', profile_complete: true, is_test_account: false, is_admin: false,
      matching_paused: false, email: `${o.id}@x.test`, subscription_tier: 'free', boost_score: 0,
      is_priority: false, purposes: [], interests: [], expertise: [], looking_for: [],
      seniority: null, mentorship_role: null, company: `co-${o.id}`, ...o,
    })
    const f = base({ id: 'f', role_type: 'Founder',          intro_preferences: ['Legal'] })
    const g = base({ id: 'g', role_type: 'General Counsel',  intro_preferences: ['Founders'] })
    const ctx = buildScoringContext([f, g])
    const avg = (scoreMatch(f, g, ctx) + scoreMatch(g, f, ctx)) / 2
    expect(avg).toBeGreaterThanOrEqual(BATCH_CONFIG.minRelevanceScore)
  })

  it('scope: only batch-scoring is wired — the other engines are untouched', () => {
    expect(readFileSync('lib/matching/batch-scoring.ts', 'utf8')).toMatch(/preferenceMatchesRole/)
    for (const f of ['lib/generate-recommendations.ts',
                     'app/api/admin/batch/[batchId]/generate-replacements/route.ts'])
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/preferenceMatchesRole/)
  })
})
