import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Regression guard for the "goals + interests silently dropped on save" bug.
 * The bug was a pure OMISSION — the fields were collected by the form but never
 * written by the server. These assertions fail loudly if any write path stops
 * parsing OR persisting purposes/interests, so the fields can never silently
 * drop again. They also confirm every path uses the shared parser and writes
 * present-only (so a partial save can never wipe a field).
 */
const actions = readFileSync('app/actions.ts', 'utf8')
const route = readFileSync('app/api/profile/update/route.ts', 'utf8')

describe('every profile-save path parses goals + interests with the shared normalizer', () => {
  it("updateProfile + completeOnboarding parse both fields (2 occurrences each in actions.ts)", () => {
    expect((actions.match(/parseMultiSelectField\(formData\.get\('purposes'\)\)/g) || []).length).toBeGreaterThanOrEqual(2)
    expect((actions.match(/parseMultiSelectField\(formData\.get\('interests'\)\)/g) || []).length).toBeGreaterThanOrEqual(2)
  })
  it('/api/profile/update parses both fields', () => {
    expect(route).toContain("parseMultiSelectField(formData.get('purposes'))")
    expect(route).toContain("parseMultiSelectField(formData.get('interests'))")
  })
})

describe('every profile-save path PERSISTS goals + interests', () => {
  it('updateProfile writes both (present-only, cannot wipe)', () => {
    expect(actions).toContain("...(formData.has('purposes') && { purposes })")
    expect(actions).toContain("...(formData.has('interests') && { interests })")
  })
  it('completeOnboarding writes purposes and interests (present-only for interests)', () => {
    expect(actions).toContain('purposes: purposes,')
    expect(actions).toContain("...(formData.has('interests') && { interests })")
  })
  it('/api/profile/update writes both present-only', () => {
    expect(route).toContain("...(formData.has('purposes') && { purposes })")
    expect(route).toContain("...(formData.has('interests') && { interests })")
  })
})

describe('the two goals+interests client surfaces load & serialize identically', () => {
  const profileForm = readFileSync('components/ProfileForm.tsx', 'utf8')
  const onboardingStep2 = readFileSync('components/OnboardingStep2.tsx', 'utf8')

  it('both LOAD from profile.purposes / profile.interests the same way', () => {
    for (const src of [profileForm, onboardingStep2]) {
      expect(src).toContain('useState<string[]>(profile?.purposes || [])')
      expect(src).toContain('useState<string[]>(profile?.interests || [])')
    }
  })
  it('both SERIALIZE via the shared serializer (no ad-hoc join drift)', () => {
    for (const src of [profileForm, onboardingStep2]) {
      expect(src).toContain("formData.set('purposes', serializeMultiSelectField(purposes))")
      expect(src).toContain("formData.set('interests', serializeMultiSelectField(interests))")
    }
  })
})
