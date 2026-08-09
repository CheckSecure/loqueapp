import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { usablePreviousRoles } from '@/lib/profile/previousRoles'

describe('usablePreviousRoles — only complete roles are career history', () => {
  it('a blank/partial entry is NOT a role (this is the "Counsel at Acme" placeholder bug)', () => {
    // A stray blank entry left in the JSON — its input placeholders would read as
    // "General Counsel at Acme Corp"; it must never render as a saved role.
    expect(usablePreviousRoles([{ company: '', title: '', start_date: '', end_date: '' }])).toEqual([])
    expect(usablePreviousRoles([{ company: 'Acme Corp', title: '' }])).toEqual([])      // company only
    expect(usablePreviousRoles([{ company: '', title: 'General Counsel' }])).toEqual([]) // title only
    expect(usablePreviousRoles([{ company: '   ', title: '  ' }])).toEqual([])           // whitespace only
  })
  it('a complete saved role is kept and trimmed', () => {
    expect(usablePreviousRoles([{ company: '  Globex  ', title: '  Deputy GC ', start_date: '2019', end_date: '2022' }]))
      .toEqual([{ company: 'Globex', title: 'Deputy GC', start_date: '2019', end_date: '2022' }])
  })
  it('mixed list drops blanks, keeps complete ones (order preserved)', () => {
    const out = usablePreviousRoles([
      { company: 'Globex', title: 'Deputy GC' },
      { company: '', title: '' },
      { company: 'Initech', title: 'Counsel' },
    ])
    expect(out.map((r) => r.company)).toEqual(['Globex', 'Initech'])
  })
  it('non-array / null / undefined → [] (clean empty state, no fake entry)', () => {
    expect(usablePreviousRoles(null)).toEqual([])
    expect(usablePreviousRoles(undefined)).toEqual([])
    expect(usablePreviousRoles('nope')).toEqual([])
    expect(usablePreviousRoles([])).toEqual([])
  })
  it('REGRESSION: a profile with no usable previous roles yields zero entries → no "Counsel at Acme"', () => {
    // primary identity (Founder at Andrel) lives on profiles.title/company and is untouched here.
    const rendered = usablePreviousRoles([{ company: '', title: '' }])
    expect(rendered).toHaveLength(0)
    expect(JSON.stringify(rendered)).not.toMatch(/counsel|acme/i)
  })
})

describe('editor + read-only profile use the SAME previous-roles rule (structural)', () => {
  const editor = readFileSync('components/ProfileEditForm.tsx', 'utf8')
  const profilePage = readFileSync('app/dashboard/profile/[id]/page.tsx', 'utf8')

  it('ProfileEditForm seeds AND saves through usablePreviousRoles (no blank row shown or stored)', () => {
    expect(editor).toContain("import { usablePreviousRoles } from '@/lib/profile/previousRoles'")
    expect(editor).toContain('usablePreviousRoles(initialData.previous_roles)')          // load: no stray blank row
    expect(editor).toContain('usablePreviousRoles(previousRoles)')                       // save: never persist blanks
  })
  it('the read-only profile page uses the same helper (admin/edit ↔ profile agree)', () => {
    expect(profilePage).toContain('usablePreviousRoles(profile.previous_roles)')
  })
  it('previous-role placeholders are unmistakable input hints, not saved-looking values', () => {
    expect(editor).toContain('placeholder="e.g. Acme Corp"')
    expect(editor).toContain('placeholder="e.g. General Counsel"')
    // the old bare placeholders (which read as a saved "Counsel at Acme") are gone
    expect(editor).not.toContain('placeholder="Acme Corp"')
    expect(editor).not.toContain('placeholder="General Counsel"')
  })
})
