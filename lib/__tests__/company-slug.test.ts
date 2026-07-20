import { describe, it, expect } from 'vitest'
import {
  normalizeCompanyName,
  companySlug,
  isLinkableCompany,
  titleCaseSlug,
  companyInitials,
} from '@/lib/company/slug'

describe('company normalization — formatting variants collapse to one slug', () => {
  it('strips legal suffixes so variants share a slug', () => {
    const slug = companySlug('Google')
    expect(slug).toBe('google')
    for (const v of ['Google LLC', 'Google, Inc.', 'Google Inc', 'google  llc', 'GOOGLE, LLC.']) {
      expect(companySlug(v)).toBe(slug)
    }
  })
  it('handles multi-word names, punctuation, and ampersands', () => {
    expect(companySlug('Foo & Bar Co.')).toBe('foo-bar')
    expect(companySlug('Acme Corporation')).toBe('acme')
    expect(companySlug('Andreessen Horowitz')).toBe('andreessen-horowitz')
    expect(companySlug('Point72 Asset Management')).toBe('point72-asset-management')
  })
  it('does NOT strip meaningful trailing words', () => {
    expect(companySlug('Blackstone Group')).toBe('blackstone-group')  // "group" kept
    expect(companySlug('Costco')).toBe('costco')                      // "co" inside a word is not a suffix
    expect(normalizeCompanyName('Sequoia Capital')).toBe('sequoia capital')
  })
  it('empty / whitespace / null → empty slug (not linkable)', () => {
    for (const v of ['', '   ', null, undefined]) {
      expect(companySlug(v)).toBe('')
      expect(isLinkableCompany(v)).toBe(false)
    }
  })
})

describe('isLinkableCompany excludes placeholders', () => {
  it('placeholder situations never link', () => {
    for (const v of ['Independent', 'Confidential', 'Stealth', 'Stealth Startup', 'Self-employed', 'Retired']) {
      // These describe a situation, not a company — no page.
      expect(isLinkableCompany(v)).toBe(false)
    }
  })
  it('a real company is linkable', () => {
    expect(isLinkableCompany('Stripe')).toBe(true)
    expect(isLinkableCompany('Google LLC')).toBe(true)
  })
})

describe('display helpers', () => {
  it('titleCaseSlug produces a readable fallback name', () => {
    expect(titleCaseSlug('foo-bar')).toBe('Foo Bar')
    expect(titleCaseSlug('google')).toBe('Google')
  })
  it('companyInitials returns up to two letters, with a dash fallback', () => {
    expect(companyInitials('Google')).toBe('G')
    expect(companyInitials('Foo Bar Baz')).toBe('FB')
    expect(companyInitials('')).toBe('—')
  })
})
