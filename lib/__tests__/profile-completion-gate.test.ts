import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { matchProfileCompletion } from '@/lib/matching/profile-completion'
import { parseMultiSelectField, serializeMultiSelectField } from '@/lib/profile/multiSelect'

/**
 * Phase A — the matching-profile completion gate is exactly THREE fields
 * (intro_preferences, purposes, expertise). `interests` was removed because the
 * primary onboarding flow never collects it, which left fully-onboarded members
 * permanently flagged "incomplete". `interests` remains real, optional profile
 * data; it just no longer gates completion.
 */

const full = { intro_preferences: ['Founders'], purposes: ['Hiring'], expertise: ['AI'] }

describe('completion gate — exactly 3 fields, interests excluded', () => {
  it('interests missing does NOT make a profile incomplete', () => {
    const mc = matchProfileCompletion({ ...full }) // no interests key at all
    expect(mc.complete).toBe(true)
    expect(mc.missing).toHaveLength(0)
    expect(mc.totalCount).toBe(3)
    expect(mc.fields.map((f) => f.key)).toEqual(['intro_preferences', 'purposes', 'expertise'])
    expect(mc.fields.map((f) => f.key)).not.toContain('interests')
  })

  it('a profile with all 3 gate fields is complete even with empty interests', () => {
    expect(matchProfileCompletion({ ...full, interests: [] }).complete).toBe(true)
    expect(matchProfileCompletion({ ...full, interests: null }).complete).toBe(true)
  })

  it('intro_preferences missing still makes it incomplete', () => {
    const mc = matchProfileCompletion({ purposes: ['Hiring'], expertise: ['AI'] })
    expect(mc.complete).toBe(false)
    expect(mc.missing.map((f) => f.key)).toEqual(['intro_preferences'])
  })

  it('purposes missing still makes it incomplete', () => {
    const mc = matchProfileCompletion({ intro_preferences: ['Founders'], expertise: ['AI'] })
    expect(mc.complete).toBe(false)
    expect(mc.missing.map((f) => f.key)).toEqual(['purposes'])
  })

  it('expertise missing still makes it incomplete', () => {
    const mc = matchProfileCompletion({ intro_preferences: ['Founders'], purposes: ['Hiring'] })
    expect(mc.complete).toBe(false)
    expect(mc.missing.map((f) => f.key)).toEqual(['expertise'])
  })

  it('an interests-only profile is still incomplete (interests never counts toward the gate)', () => {
    const mc = matchProfileCompletion({ interests: ['Sailing', 'Music'] })
    expect(mc.complete).toBe(false)
    expect(mc.missing.map((f) => f.key)).toEqual(['intro_preferences', 'purposes', 'expertise'])
  })

  it('a completed member yields no missing fields → the Introductions reminder is not shown', () => {
    // showImproveCard = mc.missing.length > 0 && !dismissed → false when complete,
    // so a completed member never sees the card regardless of dismissal state.
    const mc = matchProfileCompletion(full)
    expect(mc.missing.length > 0).toBe(false)
  })

  it('the completion gate contains none of the optional future fields', () => {
    const keys = matchProfileCompletion(full).fields.map((f) => f.key) as string[]
    for (const optional of ['interests', 'current_focus_areas', 'additional_roles', 'looking_for', 'desired_connections']) {
      expect(keys).not.toContain(optional)
    }
  })

  it('completion accepts the CSV-string storage form for the gate fields (no false-incomplete)', () => {
    // A gate field stored as a comma string still reads as present.
    const mc = matchProfileCompletion({ intro_preferences: 'Founders,VCs', purposes: 'Hiring', expertise: 'AI,Law' })
    expect(mc.complete).toBe(true)
  })
})

// ── intro_preferences write normalization ────────────────────────────────────
describe('intro_preferences normalization — always a clean string[]', () => {
  it('CSV string normalizes to an array', () => {
    expect(parseMultiSelectField('Founders,VCs,Operators')).toEqual(['Founders', 'VCs', 'Operators'])
  })

  it('trims and drops empties around commas', () => {
    expect(parseMultiSelectField('  Founders , , VCs ,')).toEqual(['Founders', 'VCs'])
  })

  it('array round-trips (serialize→parse) back to the same array', () => {
    const arr = ['Founders', 'VCs']
    expect(parseMultiSelectField(serializeMultiSelectField(arr))).toEqual(arr)
  })

  it('empty / null inputs stay empty', () => {
    expect(parseMultiSelectField('')).toEqual([])
    expect(parseMultiSelectField(null)).toEqual([])
    expect(parseMultiSelectField(undefined)).toEqual([])
  })
})

// ── Structural: save paths revalidate Introductions ──────────────────────────
describe('profile save revalidates the Introductions reminder', () => {
  const actions = readFileSync('app/actions.ts', 'utf8')
  const apiRoute = readFileSync('app/api/profile/update/route.ts', 'utf8')
  const completion = readFileSync('lib/matching/profile-completion.ts', 'utf8')
  const profileForm = readFileSync('components/ProfileForm.tsx', 'utf8')

  it('updateProfile (server action) revalidates both /dashboard/profile and /dashboard/introductions', () => {
    const block = actions.slice(actions.indexOf('export async function updateProfile'), actions.indexOf('export async function submitIntroRequest'))
    expect(block).toContain("revalidatePath('/dashboard/profile')")
    expect(block).toContain("revalidatePath('/dashboard/introductions')")
  })

  it('the /api/profile/update route revalidates /dashboard/introductions', () => {
    expect(apiRoute).toContain("revalidatePath('/dashboard/introductions')")
  })

  it('ProfileForm refreshes the Router Cache after a successful save', () => {
    expect(profileForm).toContain('router.refresh()')
  })

  it('completeOnboarding + updateProfile store intro_preferences via the shared array normalizer', () => {
    expect(actions).toContain("parseMultiSelectField(formData.get('intro_preferences'))")
    expect(actions).not.toMatch(/intro_preferences.*\)\s*\n\s*\.split\(','\)/) // no inline CSV write left
  })

  it('the completion module documents interests as intentionally excluded', () => {
    expect(completion).toContain("'intro_preferences' | 'purposes' | 'expertise'")
    expect(completion).not.toMatch(/key:\s*'interests'/) // interests not a gate field
  })
})
