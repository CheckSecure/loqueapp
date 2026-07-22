import { describe, it, expect } from 'vitest'
import { matchProfileCompletion } from '@/lib/matching/profile-completion'

describe('matchProfileCompletion', () => {
  it('is 100% when all four matchable fields are populated', () => {
    const m = matchProfileCompletion({
      intro_preferences: ['In-House Counsel'], purposes: ['Fundraising'],
      expertise: ['M&A'], interests: ['Travel'],
    })
    expect(m.percent).toBe(100)
    expect(m.complete).toBe(true)
    expect(m.missing).toHaveLength(0)
  })

  it('is 0% for an empty profile and lists every field as missing with a prompt', () => {
    const m = matchProfileCompletion({})
    expect(m.percent).toBe(0)
    expect(m.complete).toBe(false)
    expect(m.missing.map(f => f.key).sort()).toEqual(['expertise', 'interests', 'intro_preferences', 'purposes'])
    for (const f of m.missing) expect(f.prompt.length).toBeGreaterThan(0)
  })

  it('computes partial completion and identifies exactly the missing fields', () => {
    // Alexander Arato's real shape: 1 purpose, some expertise, no interests, no intro prefs.
    const m = matchProfileCompletion({ purposes: ['Networking'], expertise: ['contracts', 'commercial'], interests: [], intro_preferences: [] })
    expect(m.completedCount).toBe(2)
    expect(m.percent).toBe(50)
    expect(m.missing.map(f => f.key).sort()).toEqual(['interests', 'intro_preferences'])
  })

  it('counts a field done regardless of storage format (array / JSON / pg-array / csv)', () => {
    expect(matchProfileCompletion({ expertise: '["M&A","Tax"]', purposes: '{Fundraising}', interests: 'Travel, Food', intro_preferences: ['Investor'] }).percent).toBe(100)
  })

  it('treats empty/blank collections as not done', () => {
    const m = matchProfileCompletion({ intro_preferences: [], purposes: '', expertise: '[]', interests: '{}' })
    expect(m.percent).toBe(0)
  })

  it('fields are returned in priority order (intro preferences first)', () => {
    expect(matchProfileCompletion({}).fields.map(f => f.key)).toEqual(['intro_preferences', 'purposes', 'expertise', 'interests'])
  })

  it('handles null/undefined profile', () => {
    expect(matchProfileCompletion(null).percent).toBe(0)
    expect(matchProfileCompletion(undefined).complete).toBe(false)
  })
})
