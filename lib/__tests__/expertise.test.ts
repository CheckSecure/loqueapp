import { describe, it, expect } from 'vitest'
import { normalizeExpertise, filterExpertiseOptions } from '@/lib/expertise'
import { EXPERTISE_OPTIONS } from '@/lib/profile-options'

describe('normalizeExpertise — loading legacy saved expertise into the unified list', () => {
  it('loads CSV values, including legacy ones, into one selected list', () => {
    expect(normalizeExpertise('Business Development, Legal Technology, Networking')).toEqual([
      'Business Development',
      'Legal Technology',
      'Networking',
    ])
  })

  it('loads a real string array', () => {
    expect(normalizeExpertise(['Legal', 'AI', 'Networking'])).toEqual(['Legal', 'AI', 'Networking'])
  })

  it('loads a JSON-stringified array', () => {
    expect(normalizeExpertise('["Privacy","Business Development"]')).toEqual(['Privacy', 'Business Development'])
  })

  it('loads a Postgres array literal (quoted multi-word values)', () => {
    expect(normalizeExpertise('{Legal,"Legal Technology"}')).toEqual(['Legal', 'Legal Technology'])
  })

  it('returns [] for null / empty / empty-container forms', () => {
    expect(normalizeExpertise(null)).toEqual([])
    expect(normalizeExpertise('')).toEqual([])
    expect(normalizeExpertise('{}')).toEqual([])
    expect(normalizeExpertise('[]')).toEqual([])
  })
})

describe('normalizeExpertise — dedupe + clean display capitalization', () => {
  it('maps case/whitespace variants to the canonical spelling', () => {
    expect(normalizeExpertise('  networking , BUSINESS DEVELOPMENT ')).toEqual([
      'Networking',
      'Business Development',
    ])
  })

  it('de-duplicates case-insensitively (first occurrence wins)', () => {
    expect(normalizeExpertise('AI, ai, Ai')).toEqual(['AI'])
  })

  it('preserves a non-canonical legacy value (trimmed) so it stays manageable', () => {
    expect(normalizeExpertise('  Some Bespoke Skill ')).toEqual(['Some Bespoke Skill'])
  })
})

describe('canonical option source now contains the three values', () => {
  it('includes Business Development, Legal Technology, Networking', () => {
    expect(EXPERTISE_OPTIONS).toContain('Business Development')
    expect(EXPERTISE_OPTIONS).toContain('Legal Technology')
    expect(EXPERTISE_OPTIONS).toContain('Networking')
  })
})

describe('filterExpertiseOptions — search finds the three values', () => {
  it('typing "business" finds Business Development', () => {
    expect(filterExpertiseOptions('business', [])).toContain('Business Development')
  })
  it('typing "legal" finds Legal Technology', () => {
    expect(filterExpertiseOptions('legal', [])).toContain('Legal Technology')
  })
  it('typing "network" finds Networking', () => {
    expect(filterExpertiseOptions('network', [])).toContain('Networking')
  })
})

describe('filterExpertiseOptions — already-selected values are not offered as duplicates', () => {
  it('excludes an exact selected value from the dropdown', () => {
    expect(filterExpertiseOptions('network', ['Networking'])).not.toContain('Networking')
  })
  it('excludes selected case-insensitively', () => {
    expect(filterExpertiseOptions('', ['networking'])).not.toContain('Networking')
  })
})

describe('removing a previously saved value, then adding it back', () => {
  it('a removed canonical value becomes available in the dropdown again', () => {
    let selected = ['Legal', 'Networking']

    // Remove (same op the chip X performs)
    selected = selected.filter((t) => t !== 'Networking')
    expect(selected).toEqual(['Legal'])

    // Dropdown now offers it again (not selected)
    expect(filterExpertiseOptions('network', selected)).toContain('Networking')

    // Add it back (same op the dropdown performs)
    selected = [...selected, 'Networking']
    expect(selected).toEqual(['Legal', 'Networking'])
  })
})

describe('saving the final expertise array', () => {
  it('serializes the unified selected list to the stored comma form', () => {
    const selected = normalizeExpertise('{Legal,"Business Development"}')
    expect(selected.join(',')).toBe('Legal,Business Development')
  })
})
