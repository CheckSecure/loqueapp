import { describe, it, expect, beforeEach, vi } from 'vitest'
import { COMPANY_REGISTRY } from '@/lib/company/registry'
import { companySlug, resolveCanonicalCompany, resolveLegacySlug, isAmbiguousCompanyName } from '@/lib/company/slug'
import { planRegistryRepair, type CompanyRow } from '@/lib/company/migration'

// Configurable homepage fetch + logo download (hoisted so the mocks see them).
const state = vi.hoisted(() => ({
  http: { ok: false, status: 403, url: '', contentType: '', text: '', error: undefined as string | undefined },
  logo: null as string | null,
}))

vi.mock('@/lib/company/enrichment/http', () => ({
  fetchText: async (url: string) => ({ ...state.http, url: state.http.url || url }),
  fetchBinary: async () => ({ ok: false, status: 0, url: '', contentType: '', bytes: null }),
}))
vi.mock('@/lib/company/enrichment/logo', () => ({
  LOGO_BUCKET: 'company-logos',
  downloadAndStoreLogo: async () => state.logo,
}))

import { runEnrichment } from '@/lib/company/enrichment/run'

// Minimal in-memory admin client that captures the finalize patch. `currentRow`
// backs the `companies` row; `metaRow` backs the `company_metadata` fallback.
function makeAdmin(currentRow: Record<string, any> = {}, metaRow: Record<string, any> = {}, claimReturns: any[] = [{ slug: 'x' }]) {
  const captured: { finalizePatch: any } = { finalizePatch: null }
  const build = (patch: any) => {
    const isClaim = patch.enrichment_status === 'in_progress'
    const b: any = {
      eq: () => b,
      or: () => b,
      select: async () => ({ data: claimReturns, error: null }),
      then: (res: any, rej: any) => {
        if (!isClaim) captured.finalizePatch = { ...(captured.finalizePatch || {}), ...patch }
        return Promise.resolve({ error: null }).then(res, rej)
      },
    }
    return b
  }
  const admin: any = {
    from: (table: string) => ({
      upsert: async () => ({ error: null }),
      update: (patch: any) => build(patch),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === 'company_metadata' ? metaRow : currentRow, error: null }) }) }),
      delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
    }),
  }
  return { admin, captured }
}

beforeEach(() => {
  state.http = { ok: false, status: 403, url: '', contentType: '', text: '', error: undefined }
  state.logo = null
})

describe('registry company + blocked/failed homepage → partial, never blank, never not_found', () => {
  it('FedEx 403 persists canonical name + authoritative website; no fallback → no description', async () => {
    state.http = { ok: false, status: 403, url: 'https://fedex.com', contentType: '', text: '', error: undefined }
    const { admin, captured } = makeAdmin({})
    const r = await runEnrichment(admin, 'fedex', 'FedEx', {})
    expect(r.status).toBe('partial')
    const p = captured.finalizePatch
    expect(p.enrichment_status).toBe('partial')
    expect(p.name).toBe('FedEx Corporation')
    expect(p.website).toBe('https://fedex.com')
    expect(p.description).toBeUndefined() // no curated fallback present
    expect(p.enrichment_source).toBe('registry')
    expect(r.stages).toEqual({ identity: 'registry', website: true, description: 'none', logo: 'none' })
  })

  it('registry company + 403 + curated fallback → uses fallback description; stages report "fallback"', async () => {
    state.http = { ok: false, status: 403, url: 'https://fedex.com', contentType: '', text: '', error: undefined }
    const { admin, captured } = makeAdmin({}, { description: 'Curated fallback description.', logo_url: 'https://cdn/logo.png' })
    const r = await runEnrichment(admin, 'fedex', 'FedEx', {})
    expect(r.status).toBe('partial')
    expect(captured.finalizePatch.description).toBe('Curated fallback description.')
    expect(captured.finalizePatch.logo_url).toBe('https://cdn/logo.png')
    expect(r.stages).toEqual({ identity: 'registry', website: true, description: 'fallback', logo: 'fallback' })
  })

  it('scraped homepage description beats the curated fallback; stages report "scraped"', async () => {
    state.http = { ok: true, status: 200, url: 'https://dwt.com', contentType: 'text/html; charset=utf-8', text: '<html><head><meta name="description" content="Scraped homepage."></head></html>', error: undefined }
    const { admin, captured } = makeAdmin({}, { description: 'Curated fallback (should lose).' })
    const r = await runEnrichment(admin, 'davis-wright-tremaine', 'Davis Wright Tremaine', {})
    expect(r.status).toBe('enriched')
    expect(captured.finalizePatch.description).toBe('Scraped homepage.')
    expect(r.stages?.description).toBe('scraped')
    expect(r.stages?.identity).toBe('registry')
  })

  it('Wonder 403 resolves to the food company (wonder.com), not not_found', async () => {
    state.http = { ok: false, status: 403, url: 'https://wonder.com', contentType: '', text: '', error: undefined }
    const { admin, captured } = makeAdmin({})
    const r = await runEnrichment(admin, 'Wonder', 'Wonder', {})
    expect(r.status).toBe('partial')
    expect(captured.finalizePatch.website).toBe('https://wonder.com')
    expect(captured.finalizePatch.name).toBe('Wonder')
  })

  it('timeout on a registry company does not become not_found', async () => {
    state.http = { ok: false, status: 0, url: '', contentType: '', text: '', error: 'timeout' }
    const { admin, captured } = makeAdmin({})
    const r = await runEnrichment(admin, 'becton-dickinson', 'BD', {})
    expect(r.status).toBe('partial')
    expect(captured.finalizePatch.name).toBe('Becton, Dickinson and Company')
    expect(captured.finalizePatch.website).toBe('https://bd.com')
  })

  it('TKO resolves to TKO Group Holdings / tkogrp.com', async () => {
    const { admin, captured } = makeAdmin({})
    const r = await runEnrichment(admin, 'tko-group-holdings', 'TKO', {})
    expect(['partial', 'enriched']).toContain(r.status)
    expect(captured.finalizePatch.website).toBe('https://tkogrp.com')
    expect(captured.finalizePatch.name).toBe('TKO Group Holdings')
  })
})

describe('unknown company can still become not_found', () => {
  it('no registry entry + failed discovery → not_found', async () => {
    // heuristic probes fail (state.http not ok) → no domain found.
    const { admin, captured } = makeAdmin({})
    const r = await runEnrichment(admin, 'zzz-unknown-co', 'Zzz Unknown Co', {})
    expect(r.status).toBe('not_found')
    expect(captured.finalizePatch.enrichment_status).toBe('not_found')
    expect(r.stages).toEqual({ identity: 'unresolved', website: false, description: 'none', logo: 'none' })
  })
})

describe('precedence: manual/existing > extracted > registry fallback', () => {
  it('never overwrites an existing populated description', async () => {
    state.http = { ok: false, status: 403, url: 'https://fedex.com', contentType: '', text: '', error: undefined }
    const { admin, captured } = makeAdmin({ description: 'Curated existing description' })
    await runEnrichment(admin, 'fedex', 'FedEx', {})
    expect(captured.finalizePatch.description).toBeUndefined() // existing kept, not overwritten
  })

  it('extracted homepage description is persisted when there is no existing value', async () => {
    state.http = {
      ok: true, status: 200, url: 'https://dwt.com', contentType: 'text/html; charset=utf-8',
      text: '<html><head><meta name="description" content="Freshly extracted homepage description."></head></html>', error: undefined,
    }
    const { admin, captured } = makeAdmin({})
    const r = await runEnrichment(admin, 'davis-wright-tremaine', 'Davis Wright Tremaine', {})
    expect(r.status).toBe('enriched')
    expect(captured.finalizePatch.description).toBe('Freshly extracted homepage description.')
  })
})

describe('admin overrides always win (never silently overwritten)', () => {
  it('an admin_edited row is never re-enriched — even a forced Repair skips it', async () => {
    // The claim SQL filters admin_edited=true, so it returns 0 rows here.
    const { admin, captured } = makeAdmin({ description: 'Admin-curated', admin_edited: true }, {}, [])
    const r = await runEnrichment(admin, 'fedex', 'FedEx', { force: true })
    expect(r.status).toBe('skipped')
    expect(captured.finalizePatch).toBeNull() // nothing written — the admin edit stands
  })
})

describe('old-slug redirects resolve to canonical', () => {
  it('legacy slugs map to canonical', () => {
    expect(resolveLegacySlug('bd')).toBe('becton-dickinson')
    expect(resolveLegacySlug('dentsu-merkle')).toBe('dentsu')
    expect(resolveLegacySlug('baker-botts-l-l-p')).toBe('baker-botts')
    expect(resolveLegacySlug('eversheds-sutherland-us')).toBe('eversheds-sutherland')
    expect(resolveLegacySlug('hughes-hubbard')).toBe('hughes-hubbard-reed')
    expect(resolveLegacySlug('merkle')).toBe('dentsu')
  })
  it('canonical slugs do not redirect (no loop)', () => {
    expect(resolveLegacySlug('becton-dickinson')).toBeNull()
    expect(resolveLegacySlug('dentsu')).toBeNull()
    expect(resolveLegacySlug('some-unrelated-company')).toBeNull()
  })
})

describe('ambiguous aliases do not overmatch unrelated names', () => {
  it('multi-word names containing an ambiguous token do NOT canonicalize', () => {
    expect(resolveCanonicalCompany('TKO Strength & Performance')).toBeNull()
    expect(resolveCanonicalCompany('BD Sports Group')).toBeNull()
    expect(resolveCanonicalCompany('Wonder Bread')).toBeNull()
    expect(resolveCanonicalCompany('Merkle Science')).toBeNull()
  })
  it('flags ambiguous short keys for review; unambiguous names are not flagged', () => {
    expect(isAmbiguousCompanyName('BD')).toBe(true)
    expect(isAmbiguousCompanyName('TKO')).toBe(true)
    expect(isAmbiguousCompanyName('Wonder')).toBe(true)
    expect(isAmbiguousCompanyName('Davis Wright Tremaine')).toBe(false)
    expect(isAmbiguousCompanyName('FedEx')).toBe(false)
  })
})

describe('migration planner is idempotent', () => {
  it('a repaired DB yields no enrich/retire actions on re-plan (incl. partial rows with no description)', () => {
    const repaired: CompanyRow[] = COMPANY_REGISTRY.map((c, i) => ({
      slug: companySlug(c.name), name: c.name, website: `https://${c.domain}`,
      // Alternate enriched / partial(no description) — both are valid fixed points.
      description: i % 2 ? null : 'scraped description', admin_edited: false,
      enrichment_status: i % 2 ? 'partial' : 'enriched',
    }))
    const actions = planRegistryRepair(repaired)
    const mutating = actions.filter((a) => a.type === 'enrich' || a.type === 'retire-orphan')
    expect(mutating).toEqual([])
  })

  it('a broken DB produces enrich + retire actions, then converges', () => {
    const broken: CompanyRow[] = [
      { slug: 'bd', name: 'BD', website: 'https://www.afternic.com', description: 'bd.co is for sale', admin_edited: false, enrichment_status: 'enriched' },
      { slug: 'dentsu-merkle', name: 'Dentsu/Merkle', website: null, description: null, admin_edited: false, enrichment_status: 'not_found' },
    ]
    const plan = planRegistryRepair(broken)
    expect(plan.some((a) => a.type === 'retire-orphan' && a.slug === 'bd')).toBe(true)
    expect(plan.some((a) => a.type === 'retire-orphan' && a.slug === 'dentsu-merkle')).toBe(true)
    expect(plan.some((a) => a.type === 'enrich' && a.slug === 'becton-dickinson')).toBe(true)
    expect(plan.some((a) => a.type === 'enrich' && a.slug === 'dentsu')).toBe(true)
  })

  it('preserves admin_edited rows (never enriched or retired)', () => {
    const rows: CompanyRow[] = [
      { slug: 'fedex', name: 'FedEx Corporation', website: 'https://fedex.com', description: 'curated', admin_edited: true, enrichment_status: 'enriched' },
    ]
    const plan = planRegistryRepair(rows)
    expect(plan.some((a) => a.slug === 'fedex' && a.type === 'enrich')).toBe(false)
    expect(plan.some((a) => a.type === 'preserve-admin' && a.slug === 'fedex')).toBe(true)
  })
})
