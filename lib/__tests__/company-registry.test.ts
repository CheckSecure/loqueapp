import { describe, it, expect } from 'vitest'
import { companySlug, normalizeCompanyName, resolveCanonicalCompany, isLinkableCompany } from '@/lib/company/slug'
import { RegistryDiscovery } from '@/lib/company/enrichment/discovery'

describe('canonical company registry resolution', () => {
  it('resolves acronyms / short-forms to the canonical company + authoritative domain', () => {
    const cases: Array<[string, string, string]> = [
      ['DWT', 'Davis Wright Tremaine LLP', 'dwt.com'],
      ['BD', 'Becton, Dickinson and Company', 'bd.com'],
      ['Hughes Hubbard', 'Hughes Hubbard & Reed LLP', 'hugheshubbard.com'],
      ['Verizon', 'Verizon Communications', 'verizon.com'],
      ['Eversheds', 'Eversheds Sutherland', 'eversheds-sutherland.com'],
      ['TKO', 'TKO Group Holdings', 'tkogrp.com'],
      ['Manatt Phelps', 'Manatt, Phelps & Phillips', 'manatt.com'],
      ['T-Mobile', 'T-Mobile US', 't-mobile.com'],
      ['FedEx', 'FedEx Corporation', 'fedex.com'],
      ['Wonder', 'Wonder', 'wonder.com'],
    ]
    for (const [raw, name, domain] of cases) {
      const c = resolveCanonicalCompany(raw)
      expect(c, raw).not.toBeNull()
      expect(c!.name).toBe(name)
      expect(c!.domain).toBe(domain)
    }
  })

  it('matches regardless of case / punctuation / legal suffix', () => {
    expect(resolveCanonicalCompany('  davis wright tremaine llp ')?.domain).toBe('dwt.com')
    expect(resolveCanonicalCompany('Eversheds Sutherland (US) LLP')?.domain).toBe('eversheds-sutherland.com')
    expect(resolveCanonicalCompany('BECTON, DICKINSON')?.domain).toBe('bd.com')
    expect(resolveCanonicalCompany('Barnes & Thornburg')?.domain).toBe('btlaw.com')
  })

  it('returns null for unknown companies (left for a search provider / not_found)', () => {
    expect(resolveCanonicalCompany('Some Unlisted Startup')).toBeNull()
    expect(resolveCanonicalCompany('')).toBeNull()
    expect(resolveCanonicalCompany(null)).toBeNull()
  })
})

describe('alias-aware slug collapsing (variants → one canonical page)', () => {
  it('collapses every variant of a company to a single canonical slug', () => {
    // Hughes Hubbard: the "blank page" case (member typed the short form).
    expect(companySlug('Hughes Hubbard')).toBe('hughes-hubbard-reed')
    expect(companySlug('Hughes Hubbard & Reed LLP')).toBe('hughes-hubbard-reed')
    // DWT
    expect(companySlug('DWT')).toBe('davis-wright-tremaine')
    expect(companySlug('Davis Wright Tremaine')).toBe('davis-wright-tremaine')
    // Verizon / T-Mobile short-forms
    expect(companySlug('Verizon')).toBe('verizon-communications')
    expect(companySlug('T-Mobile')).toBe('t-mobile-us')
    // BD → clean slug (no trailing "and" from "…and Company")
    expect(companySlug('BD')).toBe('becton-dickinson')
    expect(companySlug('Becton Dickinson')).toBe('becton-dickinson')
  })

  it('merges duplicate identities: Dentsu / Merkle → one canonical Dentsu page', () => {
    expect(companySlug('Dentsu')).toBe('dentsu')
    expect(companySlug('Dentsu / Merkle')).toBe('dentsu')
    expect(companySlug('Merkle')).toBe('dentsu')
    expect(resolveCanonicalCompany('Merkle')?.name).toBe('Dentsu')
  })

  it('non-registry companies still slug normally', () => {
    expect(companySlug('Acme Robotics, Inc.')).toBe('acme-robotics')
    expect(companySlug('Northwind Traders')).toBe('northwind-traders')
    expect(companySlug('Some Random Co LLC')).toBe('some-random') // both Co + LLC stripped
  })
})

describe('normalization fixes', () => {
  it('strips dotted legal acronyms so slugs are clean', () => {
    // The "baker-botts-l-l-p" bug: L.L.P. → llp → stripped.
    expect(normalizeCompanyName('Baker Botts L.L.P.')).toBe('baker botts')
    expect(companySlug('Baker Botts L.L.P.')).toBe('baker-botts')
    expect(companySlug('Baker Botts')).toBe('baker-botts')
    expect(normalizeCompanyName('Foo L.L.C.')).toBe('foo')
  })

  it('does not mangle names with meaningful dots (Crypto.com)', () => {
    expect(companySlug('Crypto.com')).toBe('crypto-com')
    expect(resolveCanonicalCompany('Crypto.com')?.domain).toBe('crypto.com')
  })

  it('placeholders remain non-linkable', () => {
    expect(isLinkableCompany('Independent')).toBe(false)
    expect(isLinkableCompany('Stealth')).toBe(false)
    expect(isLinkableCompany('Davis Wright Tremaine')).toBe(true)
  })
})

describe('registry-first discovery (domain-first, no guessing)', () => {
  const discovery = new RegistryDiscovery()

  it('returns the authoritative domain for known companies without fetching', async () => {
    const bd = await discovery.discover('BD')
    expect(bd).toEqual({ website: 'https://bd.com', domain: 'bd.com', via: 'registry', canonicalName: 'Becton, Dickinson and Company' })

    const tko = await discovery.discover('TKO Group Holdings')
    expect(tko.via).toBe('registry')
    expect(tko.domain).toBe('tkogrp.com')

    const wonder = await discovery.discover('Wonder')
    expect(wonder.domain).toBe('wonder.com') // food company, not wonder.io
  })

  it('does NOT guess a domain for unknown companies (no .com/.io/.co guessing)', async () => {
    const unknown = await discovery.discover('Totally Unlisted Startup')
    expect(unknown).toEqual({ website: null, domain: null, via: 'none' })
  })
})
