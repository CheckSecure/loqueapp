import { describe, it, expect, vi, beforeEach } from 'vitest'
import { companySlug } from '@/lib/company/slug'

const h = vi.hoisted(() => ({
  companies: [] as any[],
  simulate: null as null | ((slug: string) => void),
  result: { status: 'enriched' } as any,
}))

vi.mock('@/lib/company/enrichment/run', () => ({
  runEnrichment: vi.fn(async (_admin: any, slug: string) => {
    if (h.simulate) h.simulate(slug)
    return h.result
  }),
}))

import { enrichCompany } from '@/lib/company/enrichCompany'
import { runEnrichment } from '@/lib/company/enrichment/run'

function adminMock() {
  function from(table: string) {
    const filters: ((r: any) => boolean)[] = []
    const b: any = {
      select() { return b },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b },
      maybeSingle: async () => ({ data: ((h as any)[table] as any[]).find((r) => filters.every((f) => f(r))) ?? null, error: null }),
    }
    return b
  }
  return { from }
}

beforeEach(() => {
  h.companies = []
  h.simulate = null
  h.result = { status: 'enriched' }
  ;(runEnrichment as any).mockClear()
})

describe('enrichCompany', () => {
  it('does NOT overwrite an already-complete company (logo AND description)', async () => {
    h.companies = [{ slug: 'google', name: 'Google', logo_url: 'L', description: 'D', website: 'google.com', enrichment_source: 'registry:homepage' }]
    const r = await enrichCompany(adminMock(), 'Google')
    expect(r.status).toBe('existing')
    expect(r.logo_url).toBe('L')
    expect(r.description).toBe('D')
    expect(r.confidence).toBe('high')
    expect(runEnrichment).not.toHaveBeenCalled()
  })

  it('populates a MISSING logo', async () => {
    h.companies = [{ slug: 'google', name: 'Google', logo_url: null, description: 'D' }]
    h.simulate = (slug) => { const c = h.companies.find((x) => x.slug === slug); c.logo_url = 'NEWLOGO' }
    const r = await enrichCompany(adminMock(), 'Google')
    expect(runEnrichment).toHaveBeenCalledTimes(1)
    expect(r.logo_url).toBe('NEWLOGO')
    expect(r.status).toBe('enriched')
  })

  it('populates a MISSING description', async () => {
    h.companies = [{ slug: 'google', name: 'Google', logo_url: 'L', description: null }]
    h.simulate = (slug) => { const c = h.companies.find((x) => x.slug === slug); c.description = 'A verified description.' }
    const r = await enrichCompany(adminMock(), 'Google')
    expect(runEnrichment).toHaveBeenCalledTimes(1)
    expect(r.description).toBe('A verified description.')
  })

  it('duplicate company-name variants resolve to the SAME slug (shared enrichment)', async () => {
    expect(companySlug('Google LLC')).toBe(companySlug('Google, Inc.'))
    h.companies = [{ slug: companySlug('Google'), name: 'Google', logo_url: 'L', description: 'D' }]
    const a = await enrichCompany(adminMock(), 'Google LLC')
    const b = await enrichCompany(adminMock(), 'Google, Inc.')
    expect(a.slug).toBe(b.slug)
    expect(a.status).toBe('existing')
    expect(b.status).toBe('existing') // both hit the one complete row
    expect(runEnrichment).not.toHaveBeenCalled()
  })

  it('a failed lookup returns a clean result and never throws', async () => {
    h.companies = [{ slug: 'obscureco', name: 'ObscureCo', logo_url: null, description: null }]
    h.result = { status: 'not_found' }
    const r = await enrichCompany(adminMock(), 'ObscureCo')
    expect(r.status).toBe('not_found')
    expect(r.logo_url).toBeNull()
    expect(r.description).toBeNull()
    expect(r.confidence).toBe('low')
  })

  it('skips a placeholder / non-company ("Independent") without enriching', async () => {
    const r = await enrichCompany(adminMock(), 'Independent')
    expect(r.status).toBe('invalid')
    expect(runEnrichment).not.toHaveBeenCalled()
  })

  it('force re-enriches even a complete company', async () => {
    h.companies = [{ slug: 'google', name: 'Google', logo_url: 'L', description: 'D' }]
    h.simulate = (slug) => { const c = h.companies.find((x) => x.slug === slug); c.description = 'REFRESHED' }
    const r = await enrichCompany(adminMock(), 'Google', undefined, { force: true })
    expect(runEnrichment).toHaveBeenCalledTimes(1)
    expect(r.description).toBe('REFRESHED')
  })

  it('passes a caller-provided domain through to the pipeline', async () => {
    h.companies = [{ slug: 'acme', name: 'Acme', logo_url: null, description: null }]
    await enrichCompany(adminMock(), 'Acme', 'acme.com')
    expect(runEnrichment).toHaveBeenCalledWith(expect.anything(), 'acme', 'Acme', { force: undefined, website: 'acme.com' })
  })
})
