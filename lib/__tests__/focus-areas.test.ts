import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  normalizeFocusAreas,
  persistFocusAreas,
  MAX_FOCUS_AREAS,
  MAX_FOCUS_AREA_LEN,
} from '@/lib/profile/focusAreas'
import { matchProfileCompletion } from '@/lib/matching/profile-completion'

// ── Normalization ────────────────────────────────────────────────────────────
describe('normalizeFocusAreas', () => {
  it('accepts an array', () => {
    expect(normalizeFocusAreas(['Nuclear energy', 'Energy policy'])).toEqual(['Nuclear energy', 'Energy policy'])
  })

  it('accepts a CSV string', () => {
    expect(normalizeFocusAreas('Nuclear energy, Energy policy')).toEqual(['Nuclear energy', 'Energy policy'])
  })

  it('accepts a JSON-string array', () => {
    expect(normalizeFocusAreas('["Nuclear energy","Energy policy"]')).toEqual(['Nuclear energy', 'Energy policy'])
  })

  it('accepts a pg-array literal', () => {
    expect(normalizeFocusAreas('{Nuclear energy,"Energy policy"}')).toEqual(['Nuclear energy', 'Energy policy'])
  })

  it('empty / null / undefined → []', () => {
    for (const v of ['', '   ', '[]', '{}', null, undefined]) expect(normalizeFocusAreas(v)).toEqual([])
  })

  it('trims and collapses internal whitespace, drops blanks', () => {
    expect(normalizeFocusAreas(['  Nuclear   energy  ', '', '  ', 'Energy policy'])).toEqual(['Nuclear energy', 'Energy policy'])
  })

  it('de-duplicates case-insensitively, preserving the first-seen casing', () => {
    expect(normalizeFocusAreas(['Nuclear Energy', 'nuclear energy', 'NUCLEAR ENERGY'])).toEqual(['Nuclear Energy'])
  })

  it('caps the list at MAX_FOCUS_AREAS (10)', () => {
    const many = Array.from({ length: 15 }, (_, i) => `Area ${i}`)
    const out = normalizeFocusAreas(many)
    expect(out).toHaveLength(MAX_FOCUS_AREAS)
    expect(out[0]).toBe('Area 0')
  })

  it('truncates an over-long value to MAX_FOCUS_AREA_LEN (defensive; does not rewrite legit short terms)', () => {
    const long = 'x'.repeat(MAX_FOCUS_AREA_LEN + 40)
    expect(normalizeFocusAreas([long])[0]).toHaveLength(MAX_FOCUS_AREA_LEN)
    // a legitimate custom term is preserved verbatim
    expect(normalizeFocusAreas(['Small modular reactors'])).toEqual(['Small modular reactors'])
  })

  it('preserves arbitrary custom free-text terms', () => {
    expect(normalizeFocusAreas(['Grid-scale storage', 'AI regulation'])).toEqual(['Grid-scale storage', 'AI regulation'])
  })
})

// ── Fail-open persistence ────────────────────────────────────────────────────
function fakeDb(updateResult: { error: any }) {
  const calls: any[] = []
  const db = {
    from(table: string) {
      const b: any = {
        update(payload: any) { calls.push({ table, payload }); return b },
        eq() { return Promise.resolve(updateResult) },
      }
      return b
    },
  }
  return { db, calls }
}

describe('persistFocusAreas — fail-open, writes only its column', () => {
  it('writes the normalized array on the profiles row when the column exists', async () => {
    const { db, calls } = fakeDb({ error: null })
    const r = await persistFocusAreas(db as any, 'u1', 'Nuclear energy, nuclear energy')
    expect(r).toEqual({ persisted: true, value: ['Nuclear energy'] })
    expect(calls).toHaveLength(1)
    expect(calls[0].table).toBe('profiles')
    expect(Object.keys(calls[0].payload)).toEqual(['current_focus_areas']) // touches nothing else
    expect(calls[0].payload.current_focus_areas).toEqual(['Nuclear energy'])
  })

  it('fails open when migration 041 is not applied (missing column → persisted:false, no throw)', async () => {
    const { db } = fakeDb({ error: { code: '42703', message: 'column profiles.current_focus_areas does not exist' } })
    const r = await persistFocusAreas(db as any, 'u1', ['AI regulation'])
    expect(r.persisted).toBe(false)
    expect(r.value).toEqual(['AI regulation']) // normalized value still returned
  })
})

// ── Completion never counts focus areas ──────────────────────────────────────
describe('profile completion ignores current focus areas', () => {
  it('a profile with ONLY focus areas is still incomplete', () => {
    const mc = matchProfileCompletion({ current_focus_areas: ['Nuclear energy'] } as any)
    expect(mc.complete).toBe(false)
    expect(mc.fields.map((f) => f.key)).not.toContain('current_focus_areas')
  })

  it('a complete profile stays complete whether focus areas are empty or populated', () => {
    const base = { intro_preferences: ['Founders'], purposes: ['Hiring'], expertise: ['AI'] }
    expect(matchProfileCompletion({ ...base } as any).complete).toBe(true)
    expect(matchProfileCompletion({ ...base, current_focus_areas: [] } as any).complete).toBe(true)
    expect(matchProfileCompletion({ ...base, current_focus_areas: ['Nuclear energy'] } as any).complete).toBe(true)
  })
})

// ── Structural: migration, health, wiring, display, fail-open reads ──────────
describe('Phase B wiring', () => {
  const migration = readFileSync('supabase/migrations/041_profiles_current_focus_areas.sql', 'utf8')
  const health = readFileSync('lib/db/migrationHealth.ts', 'utf8')
  const actions = readFileSync('app/actions.ts', 'utf8')
  const apiRoute = readFileSync('app/api/profile/update/route.ts', 'utf8')
  const profileForm = readFileSync('components/ProfileForm.tsx', 'utf8')
  const onboarding = readFileSync('components/OnboardingForm.tsx', 'utf8')
  const profilePage = readFileSync('app/dashboard/profile/[id]/page.tsx', 'utf8')
  const adminPage = readFileSync('app/dashboard/admin/members/page.tsx', 'utf8')
  const adminClient = readFileSync('components/AdminMembersClient.tsx', 'utf8')

  it('migration 041 is additive, idempotent, non-destructive', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS current_focus_areas jsonb NOT NULL DEFAULT '\[\]'::jsonb/)
    expect(migration).not.toMatch(/DROP|DELETE|TRUNCATE/i)
  })

  it('migration-health registers 041', () => {
    expect(health).toContain("041_profiles_current_focus_areas.sql")
    expect(health).toContain("column: 'current_focus_areas'")
  })

  it('write paths persist via the fail-open helper (present-only)', () => {
    expect((actions.match(/persistFocusAreas\(/g) || []).length).toBeGreaterThanOrEqual(2) // updateProfile + completeOnboarding
    expect(actions).toContain("formData.has('current_focus_areas')")
    expect(apiRoute).toContain('persistFocusAreas')
    expect(apiRoute).toContain("formData.has('current_focus_areas')")
  })

  it('profile edit + onboarding render the input', () => {
    expect(profileForm).toContain('<CurrentFocusAreasInput')
    expect(onboarding).toContain('CurrentFocusAreasInput')
  })

  it('profile display shows chips only when values exist', () => {
    expect(profilePage).toContain('normalizeFocusAreas(profile.current_focus_areas).length > 0')
    expect(profilePage).toContain('Current focus areas')
  })

  it('admin members view reads focus areas fail-open (separate select, not the main one)', () => {
    expect(adminPage).toContain('focusByMember')
    expect(adminPage).toContain('if (!focusErr)')
    // main select must NOT include the column (would break pre-migration)
    const mainSelect = adminPage.slice(adminPage.indexOf(".from('profiles')"), adminPage.indexOf('.order('))
    expect(mainSelect).not.toContain('current_focus_areas')
    expect(adminClient).toContain('normalizeFocusAreas')
  })
})
