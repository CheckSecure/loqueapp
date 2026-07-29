import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseImportCsv, parseCsvRecords, computeImportPlan, type ExistingCompany } from '@/lib/company/csvImport'
import { buildCompanyResolver, resolveCompany, nearestCandidates } from '@/lib/company/companyResolver'
import { companySlug } from '@/lib/company/slug'

const mapOf = (rows: ExistingCompany[]) => new Map(rows.map((r) => [r.slug, r]))

describe('parseCsvRecords / parseImportCsv', () => {
  it('keeps commas and quotes inside a quoted field (descriptions)', () => {
    const recs = parseCsvRecords('a,"hello, world","she said ""hi"""')
    expect(recs).toEqual([['a', 'hello, world', 'she said "hi"']])
  })

  it('honors a header row in any column order', () => {
    const { rows } = parseImportCsv('description,company_name,logo_url,website\n"Does X.",Acme,http://l/x.png,acme.com')
    expect(rows[0]).toEqual({ company_name: 'Acme', website: 'acme.com', logo_url: 'http://l/x.png', description: 'Does X.' })
  })

  it('assumes canonical order when no header is present', () => {
    const { rows } = parseImportCsv('Acme,acme.com,http://l/x.png,"Does X."')
    expect(rows).toHaveLength(1)
    expect(rows[0].company_name).toBe('Acme')
    expect(rows[0].description).toBe('Does X.')
  })

  it('reports rows missing a company_name instead of dropping them silently', () => {
    const { rows, errors } = parseImportCsv('company_name,website,logo_url,description\n,acme.com,,')
    expect(rows).toHaveLength(0)
    expect(errors).toHaveLength(1)
  })

  it('handles CRLF line endings and a trailing newline', () => {
    const { rows } = parseImportCsv('company_name,website,logo_url,description\r\nAcme,,,\r\n')
    expect(rows).toHaveLength(1)
    expect(rows[0].company_name).toBe('Acme')
  })
})

describe('parseImportCsv — contaminated company_name rejection (malformed-slug prevention)', () => {
  it('A. valid comma CSV → slug is derived from company_name ONLY (akamai-technologies)', () => {
    const { rows, errors } = parseImportCsv(
      'company_name,website,logo_url,description\n'
      + 'Akamai Technologies,https://akamai.com,https://example.com/logo.png,"Cloud company"',
    )
    expect(errors).toHaveLength(0)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      company_name: 'Akamai Technologies',
      website: 'https://akamai.com',
      logo_url: 'https://example.com/logo.png',
      description: 'Cloud company',
    })
    const slug = companySlug(rows[0].company_name)
    expect(slug).toBe('akamai-technologies')
    // The slug must NOT absorb website / logo_url / description.
    expect(slug).not.toContain('http')
    expect(slug).not.toContain('akamai-com')
    expect(slug).not.toContain('example')
    // And through the actual preview/create path (computeImportPlan → not_found slug).
    const plan = computeImportPlan(rows, new Map())
    expect(plan[0].slug).toBe('akamai-technologies')
  })

  it('B. malformed non-comma row (whole row in company_name) → rejected, no row, no slug', () => {
    const line = 'Akamai Technologies https://akamai.com https://example.com/logo.png'
    const { rows, errors } = parseImportCsv(line)
    expect(rows).toHaveLength(0)                    // cannot become a company
    expect(errors).toHaveLength(1)
    expect(errors[0].line).toBe(1)
    expect(errors[0].value).toBe(line)             // original value surfaced
    expect(errors[0].reason).toMatch(/url|http/i)  // reason rejected
    // Nothing reaches slug generation.
    expect(computeImportPlan(rows, new Map())).toHaveLength(0)
  })

  it('rejects each contamination signal: http, www, tab, and >100 chars', () => {
    const cases: Array<[string, RegExp]> = [
      ['Acme http://acme.com', /url|http/i],
      ['Acme https://acme.com', /url|http/i],
      ['Acme www.acme.com', /www/i],
      ['Acme\tacme.com\tlogo', /tab/i],
      ['A'.repeat(101), /100 characters/i],
    ]
    for (const [name, reason] of cases) {
      const { rows, errors } = parseImportCsv(name)
      expect(rows).toHaveLength(0)
      expect(errors).toHaveLength(1)
      expect(errors[0].reason).toMatch(reason)
    }
  })

  it('still accepts legitimate multi-word names (no false positives)', () => {
    for (const name of ['Davis Wright Tremaine LLP', 'Becton, Dickinson and Company', 'AT&T']) {
      const csv = `"${name}",,,` // quote so a comma inside the name stays one field
      const { rows, errors } = parseImportCsv(csv)
      expect(errors).toHaveLength(0)
      expect(rows).toHaveLength(1)
      expect(rows[0].company_name).toBe(name)
    }
  })
})

describe('computeImportPlan — fill-missing-only rules', () => {
  it('fills BOTH fields when both are missing', () => {
    const plan = computeImportPlan(
      [{ company_name: 'Acme', website: '', logo_url: 'http://l/x.png', description: 'Does X.' }],
      mapOf([{ slug: 'acme', name: 'Acme', logo_url: null, description: null, admin_edited: false }]),
    )
    expect(plan[0].action).toBe('update')
    expect(plan[0].fields.logo_url?.candidate).toBe('http://l/x.png')
    expect(plan[0].fields.description?.next).toBe('Does X.')
  })

  it('fills description ONLY when a logo already exists', () => {
    const plan = computeImportPlan(
      [{ company_name: 'Acme', website: '', logo_url: 'http://l/new.png', description: 'Does X.' }],
      mapOf([{ slug: 'acme', logo_url: 'http://has/logo.png', description: null, admin_edited: false }]),
    )
    expect(plan[0].action).toBe('update')
    expect(plan[0].fields.logo_url).toBeUndefined()   // never overwrite an existing logo
    expect(plan[0].fields.description?.next).toBe('Does X.')
  })

  it('fills logo ONLY when a description already exists', () => {
    const plan = computeImportPlan(
      [{ company_name: 'Acme', website: '', logo_url: 'http://l/new.png', description: 'New desc' }],
      mapOf([{ slug: 'acme', logo_url: null, description: 'Existing description', admin_edited: false }]),
    )
    expect(plan[0].action).toBe('update')
    expect(plan[0].fields.logo_url?.candidate).toBe('http://l/new.png')
    expect(plan[0].fields.description).toBeUndefined() // never overwrite an existing description
  })

  it('skips when BOTH fields already exist (idempotent re-upload)', () => {
    const plan = computeImportPlan(
      [{ company_name: 'Acme', website: '', logo_url: 'http://l/new.png', description: 'New' }],
      mapOf([{ slug: 'acme', logo_url: 'http://has/logo.png', description: 'Existing', admin_edited: false }]),
    )
    expect(plan[0].action).toBe('skip')
    expect(plan[0].reason).toBe('already complete')
  })

  it('never touches an admin_edited row', () => {
    const plan = computeImportPlan(
      [{ company_name: 'Acme', website: '', logo_url: 'http://l/new.png', description: 'New' }],
      mapOf([{ slug: 'acme', logo_url: null, description: null, admin_edited: true }]),
    )
    expect(plan[0].action).toBe('skip')
    expect(plan[0].reason).toBe('admin_edited')
    expect(plan[0].fields).toEqual({})
  })

  it('reports not_found when no company row matches the slug', () => {
    const plan = computeImportPlan(
      [{ company_name: 'Nonexistent Co', website: '', logo_url: 'http://l/x.png', description: 'X' }],
      mapOf([{ slug: 'acme', logo_url: null, description: null, admin_edited: false }]),
    )
    expect(plan[0].action).toBe('not_found')
  })

  it('matches by canonical slug — company-name variants hit the same row', () => {
    const plan = computeImportPlan(
      [{ company_name: 'Google, Inc.', website: '', logo_url: 'http://l/g.png', description: 'Search.' }],
      mapOf([{ slug: 'google', name: 'Google', logo_url: null, description: null, admin_edited: false }]),
    )
    expect(plan[0].action).toBe('update')
    expect(plan[0].matchedName).toBe('Google')
  })

  it('skips (no new values) when the CSV provides nothing for a missing field', () => {
    const plan = computeImportPlan(
      [{ company_name: 'Acme', website: '', logo_url: '', description: '' }],
      mapOf([{ slug: 'acme', logo_url: null, description: null, admin_edited: false }]),
    )
    expect(plan[0].action).toBe('skip')
    expect(plan[0].reason).toBe('no new values in CSV')
  })
})

// ---- Route: auth, preview, apply (idempotent, logo validation, audit) --------

describe('companyResolver — exact → canonical → fuzzy', () => {
  const network = buildCompanyResolver([
    { slug: 'neurocrine', name: 'Neurocrine' },
    { slug: 'dxc', name: 'DXC' },
    { slug: 'sofi', name: 'SoFi' },
    { slug: 'discovery', name: 'Discovery' },
    { slug: 'davis-wright-tremaine', name: 'Davis Wright Tremaine LLP' },
    { slug: 'acme', name: 'Acme' },
  ])

  it('exact: an identically-normalized name matches with confidence "exact"', () => {
    expect(resolveCompany('Neurocrine', network)).toMatchObject({ slug: 'neurocrine', confidence: 'exact' })
    expect(resolveCompany('Acme', network)).toMatchObject({ slug: 'acme', confidence: 'exact' })
  })

  it('fuzzy: full official name → short member company (the reported failures)', () => {
    expect(resolveCompany('Neurocrine Biosciences', network)).toMatchObject({ slug: 'neurocrine', confidence: 'fuzzy' })
    expect(resolveCompany('DXC Technology', network)).toMatchObject({ slug: 'dxc', confidence: 'fuzzy' })
    expect(resolveCompany('SoFi Technologies,Inc.', network)).toMatchObject({ slug: 'sofi', confidence: 'fuzzy' })
    expect(resolveCompany('Discovery Education', network)).toMatchObject({ slug: 'discovery', confidence: 'fuzzy' })
  })

  it('canonical: a registry alias resolves onto a candidate ("DWT" → davis-wright-tremaine)', () => {
    expect(resolveCompany('DWT', network)).toMatchObject({ slug: 'davis-wright-tremaine', confidence: 'canonical' })
  })

  it('Wonder stays unresolved when there is no matching candidate', () => {
    expect(resolveCompany('Wonder', network)).toBeNull()
  })

  it('STG stays unresolved', () => {
    expect(resolveCompany('STG', network)).toBeNull()
  })

  it('ambiguous fuzzy key (two candidates) stays unresolved — no false positive', () => {
    const amb = buildCompanyResolver([
      { slug: 'discovery', name: 'Discovery' },
      { slug: 'discovery-communications', name: 'Discovery Communications' },
    ])
    expect(resolveCompany('Discovery Education', amb)).toBeNull()
  })

  it('fuzzy uses equality, not similarity — "Wonder" never drifts onto "Wonderlic"', () => {
    const r = buildCompanyResolver([{ slug: 'wonderlic', name: 'Wonderlic' }])
    expect(resolveCompany('Wonder', r)).toBeNull()
  })
})

describe('nearestCandidates — diagnostics only (does not affect matching)', () => {
  it('surfaces a shared-word candidate for an unmatched name', () => {
    const r = buildCompanyResolver([{ slug: 'baker-mckenzie', name: 'Baker McKenzie' }, { slug: 'zoeller', name: 'Zoeller' }])
    // "Baker Botts" does NOT resolve (different fuzzy key), but shares the token "baker".
    expect(resolveCompany('Baker Botts L.L.P.', r)).toBeNull()
    const near = nearestCandidates('Baker Botts L.L.P.', r)
    expect(near[0]).toMatchObject({ company_name: 'Baker McKenzie', slug: 'baker-mckenzie' })
    expect(near.some((n) => n.slug === 'zoeller')).toBe(false) // no shared word → excluded
  })

  it('returns nothing when there is no similar candidate at all', () => {
    const r = buildCompanyResolver([{ slug: 'zoeller', name: 'Zoeller' }])
    expect(nearestCandidates('Baker Botts L.L.P.', r)).toEqual([])
  })
})

describe('computeImportPlan — resolution integration', () => {
  const mapOf = (rows: ExistingCompany[]) => new Map(rows.map((r) => [r.slug, r]))

  it('resolves a fuzzy CSV name onto the network company (update, confidence=fuzzy, resolved slug)', () => {
    const plan = computeImportPlan(
      [{ company_name: 'Neurocrine Biosciences', website: '', logo_url: 'http://l/n.png', description: 'Biopharma.' }],
      mapOf([{ slug: 'neurocrine', name: 'Neurocrine', logo_url: null, description: null, admin_edited: false }]),
    )
    expect(plan[0].action).toBe('update')
    expect(plan[0].confidence).toBe('fuzzy')
    expect(plan[0].slug).toBe('neurocrine')       // apply will use the RESOLVED slug
    expect(plan[0].matchedName).toBe('Neurocrine')
  })

  it('an exact match still resolves with confidence=exact', () => {
    const plan = computeImportPlan(
      [{ company_name: 'Neurocrine', website: '', logo_url: 'http://l/n.png', description: 'X' }],
      mapOf([{ slug: 'neurocrine', name: 'Neurocrine', logo_url: null, description: null, admin_edited: false }]),
    )
    expect(plan[0].action).toBe('update')
    expect(plan[0].confidence).toBe('exact')
  })

  it('Wonder / STG remain not_found + unresolved when absent from the candidate set', () => {
    const plan = computeImportPlan(
      [
        { company_name: 'Wonder', website: '', logo_url: 'http://l/w.png', description: 'W' },
        { company_name: 'STG', website: '', logo_url: 'http://l/s.png', description: 'S' },
      ],
      mapOf([{ slug: 'neurocrine', name: 'Neurocrine', logo_url: null, description: null, admin_edited: false }]),
    )
    expect(plan[0]).toMatchObject({ action: 'not_found', confidence: 'unresolved' })
    expect(plan[1]).toMatchObject({ action: 'not_found', confidence: 'unresolved' })
  })
})

const h = vi.hoisted(() => ({
  user: { id: 'admin', email: 'bizdev91@gmail.com' } as any,
  companies: [] as any[],
  profiles: [] as any[],
  updates: [] as any[],
  ensured: [] as string[],
  logoResult: 'https://bucket/acme.png?v=1' as string | null,
  profilesError: null as string | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}))

vi.mock('@/lib/company/enrichment/logo', () => ({
  downloadAndStoreLogo: vi.fn(async () => h.logoResult),
}))

vi.mock('@/lib/supabase/admin', () => {
  function from(table: string) {
    const state: any = { op: 'select', patch: null, filters: {} }
    const rowsFor = () => (h as any)[table] ?? []
    const b: any = {
      select() {
        if (state.op === 'update') {
          // Apply update against the in-memory companies, honoring eq/is guards.
          const match = h.companies.filter((r) =>
            Object.entries(state.filters).every(([k, v]) => (v === null ? r[k] == null : r[k] === v)),
          )
          for (const r of match) Object.assign(r, state.patch)
          h.updates.push({ patch: state.patch, filters: { ...state.filters }, count: match.length })
          return Promise.resolve({ data: match.map((r) => ({ slug: r.slug })), error: null })
        }
        return b
      },
      not() { return b }, // profiles: .not('company','is',null) — no-op in the mock
      update(patch: any) { state.op = 'update'; state.patch = patch; return b },
      // ensureCompanyRecord(): insert-if-absent by slug (ignoreDuplicates), never overwrite.
      upsert(payload: any) {
        if (table === 'companies' && payload?.slug && !h.companies.some((r) => r.slug === payload.slug)) {
          h.companies.push({ slug: payload.slug, name: payload.name ?? null, logo_url: null, description: null, admin_edited: false, enrichment_source: payload.enrichment_source ?? null })
          h.ensured.push(payload.slug)
        }
        return Promise.resolve({ data: null, error: null })
      },
      eq(k: string, v: any) { state.filters[k] = v; return b },
      is(k: string, v: any) { state.filters[k] = v; return b },
      then(res: any, rej: any) {
        if (table === 'profiles' && h.profilesError) return Promise.resolve({ data: null, error: { message: h.profilesError } }).then(res, rej)
        return Promise.resolve({ data: rowsFor().map((r: any) => ({ ...r })), error: null }).then(res, rej)
      },
    }
    return b
  }
  return { createAdminClient: () => ({ from }) }
})

import { POST } from '@/app/api/admin/company-enrichment/import/route'
import { POST as upsertPOST } from '@/app/api/admin/companies/upsert/route'
import { downloadAndStoreLogo } from '@/lib/company/enrichment/logo'

const post = (body: any) =>
  POST(new Request('http://x/api/admin/company-enrichment/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))

beforeEach(() => {
  h.user = { id: 'admin', email: 'bizdev91@gmail.com' }
  h.companies = []
  h.profiles = []
  h.updates = []
  h.ensured = []
  h.logoResult = 'https://bucket/acme.png?v=1'
  h.profilesError = null
  ;(downloadAndStoreLogo as any).mockClear()
})

describe('company-enrichment import route', () => {
  const CSV = 'company_name,website,logo_url,description\nAcme,acme.com,http://src/logo.png,"What Acme does."'

  it('401 for a non-admin caller', async () => {
    h.user = { email: 'someone@else.com' }
    expect((await post({ csv: CSV })).status).toBe(401)
    h.user = null
    expect((await post({ csv: CSV })).status).toBe(401)
  })

  it('400 when no CSV is provided', async () => {
    expect((await post({ csv: '   ' })).status).toBe(400)
  })

  it('preview (dry run) writes nothing and reports the plan', async () => {
    h.companies = [{ slug: 'acme', name: 'Acme', logo_url: null, description: null, admin_edited: false }]
    const data = await (await post({ csv: CSV })).json()
    expect(data.applied).toBe(false)
    expect(data.summary.toUpdate).toBe(1)
    expect(data.preview[0].new_logo_url).toBe('http://src/logo.png')
    expect(h.updates).toHaveLength(0)
    expect(downloadAndStoreLogo).not.toHaveBeenCalled()
  })

  it('apply fills missing logo + description, re-hosting the logo through the pipeline util', async () => {
    h.companies = [{ slug: 'acme', name: 'Acme', logo_url: null, description: null, admin_edited: false }]
    const data = await (await post({ csv: CSV, apply: true })).json()
    expect(data.applied).toBe(true)
    expect(data.summary.updatedCompanies).toBe(1)
    expect(data.summary.updatedFields).toBe(2)
    expect(downloadAndStoreLogo).toHaveBeenCalledWith(expect.anything(), 'acme', ['http://src/logo.png'])
    // The stored bucket URL is what lands on the row — never the external source URL.
    expect(h.companies[0].logo_url).toBe('https://bucket/acme.png?v=1')
    expect(h.companies[0].description).toBe('What Acme does.')
    expect(h.companies[0].admin_edited).toBe(false) // cleanup, not a manual override
    // Every update is guarded to only fill a still-null field.
    expect(h.updates.every((u) => u.filters.admin_edited === false)).toBe(true)
    // A real companies row is NOT re-materialized (ensureCompanyRecord not called).
    expect(h.ensured).toHaveLength(0)
  })

  it('records a rejected logo (broken/placeholder/tiny) without failing the row', async () => {
    h.logoResult = null // downloadAndStoreLogo rejects the image
    h.companies = [{ slug: 'acme', name: 'Acme', logo_url: null, description: null, admin_edited: false }]
    const data = await (await post({ csv: CSV, apply: true })).json()
    expect(data.summary.logoRejected).toBe(1)
    expect(h.companies[0].logo_url).toBeNull()        // logo not stored
    expect(h.companies[0].description).toBe('What Acme does.') // description still filled
    const rejected = data.results.find((r: any) => (r.skipped_reason || '').startsWith('logo rejected'))
    expect(rejected).toBeTruthy()
  })

  it('is idempotent — a second apply of the same CSV changes nothing', async () => {
    h.companies = [{ slug: 'acme', name: 'Acme', logo_url: null, description: null, admin_edited: false }]
    await post({ csv: CSV, apply: true })
    ;(downloadAndStoreLogo as any).mockClear()
    const data = await (await post({ csv: CSV, apply: true })).json()
    expect(data.summary.updatedCompanies).toBe(0)
    expect(data.summary.updatedFields).toBe(0)
  })

  it('never overwrites an admin_edited row', async () => {
    h.companies = [{ slug: 'acme', name: 'Acme', logo_url: null, description: null, admin_edited: true }]
    const data = await (await post({ csv: CSV, apply: true })).json()
    expect(data.summary.updatedFields).toBe(0)
    expect(h.companies[0].logo_url).toBeNull()
    const row = data.results.find((r: any) => r.company_name === 'Acme')
    expect(row.skipped_reason).toBe('admin_edited')
  })

  it('reports not_found for a company with no matching row', async () => {
    h.companies = []
    const data = await (await post({ csv: CSV, apply: true })).json()
    expect(data.summary.notFound).toBe(1)
    expect(data.results[0].skipped_reason).toBe('not_found')
  })
})

// Network-derived matching: a real member company with no companies row yet must
// resolve (update), not not_found — matching the Admin Companies page universe.
describe('company-enrichment import route — network company matching', () => {
  const CSV = 'company_name,website,logo_url,description\nAcme,acme.com,http://src/logo.png,"What Acme does."'

  it('network company with NO companies row → preview shows update, not not_found', async () => {
    h.companies = []                       // nothing materialized yet
    h.profiles = [{ company: 'Acme' }]     // but Acme is a real member company
    const data = await (await post({ csv: CSV })).json()
    expect(data.applied).toBe(false)
    expect(data.summary.notFound).toBe(0)
    expect(data.summary.toUpdate).toBe(1)
    expect(data.preview[0].action).toBe('update')
    expect(data.preview[0].matched_company).toBe('Acme')
    expect(h.updates).toHaveLength(0)      // preview writes nothing
    expect(h.ensured).toHaveLength(0)      // and materializes nothing
  })

  it('apply materializes the missing companies row and fills both fields', async () => {
    h.companies = []
    h.profiles = [{ company: 'Acme' }]
    const data = await (await post({ csv: CSV, apply: true })).json()
    expect(h.ensured).toContain('acme')            // row created via ensureCompanyRecord
    expect(data.summary.updatedCompanies).toBe(1)
    expect(data.summary.updatedFields).toBe(2)
    const row = h.companies.find((r) => r.slug === 'acme')
    expect(row.logo_url).toBe('https://bucket/acme.png?v=1')
    expect(row.description).toBe('What Acme does.')
    expect(row.admin_edited).toBe(false)
  })

  it('an existing companies row is used directly and NOT re-materialized', async () => {
    h.companies = [{ slug: 'acme', name: 'Acme', logo_url: null, description: null, admin_edited: false }]
    h.profiles = [{ company: 'Acme' }]     // also in the network, but a real row already exists
    const data = await (await post({ csv: CSV, apply: true })).json()
    expect(h.ensured).toHaveLength(0)       // realSlugs guard → no upsert
    expect(data.summary.updatedFields).toBe(2)
    expect(h.companies[0].description).toBe('What Acme does.')
  })

  it('a CSV company matching neither a row nor a network company stays not_found', async () => {
    h.companies = []
    h.profiles = [{ company: 'Globex' }]   // network has Globex, not Acme
    const data = await (await post({ csv: CSV, apply: true })).json()
    expect(data.summary.notFound).toBe(1)
    expect(data.results[0].skipped_reason).toBe('not_found')
    expect(h.ensured).toHaveLength(0)
  })

  it('surfaces network/existing candidate counts, and a healthy network resolves fuzzily', async () => {
    h.companies = []
    h.profiles = [{ company: 'Neurocrine' }]
    const csv = 'company_name,website,logo_url,description\nNeurocrine Biosciences,neurocrine.com,http://src/n.png,"Biopharma."'
    const data = await (await post({ csv })).json()
    expect(data.summary.networkCount).toBe(1)
    expect(data.summary.existingCount).toBe(0)
    expect(data.summary.networkError).toBeNull()
    expect(data.summary.notFound).toBe(0)
    expect(data.preview[0].confidence).toBe('fuzzy')
  })

  it('a not_found row carries the canonical slug + CSV fields so the editor can create it', async () => {
    h.companies = []
    h.profiles = [] // empty network → not_found
    const csv = 'company_name,website,logo_url,description\nBrand New Co,brandnew.com,http://l/b.png,"Does things."'
    const row = (await (await post({ csv })).json()).preview[0]
    expect(row.action).toBe('not_found')
    expect(row.slug).toBe(companySlug('Brand New Co')) // canonical slug for materialization on save
    expect(row.csv_website).toBe('brandnew.com')
    expect(row.csv_logo_url).toBe('http://l/b.png')
    expect(row.csv_description).toBe('Does things.')
  })

  it('attaches closest_network_matches to unmatched rows (and nothing to resolved rows)', async () => {
    h.companies = []
    h.profiles = [{ company: 'Baker McKenzie' }, { company: 'Neurocrine' }]
    const csv = 'company_name,website,logo_url,description\n'
      + 'Baker Botts L.L.P.,bakerbotts.com,,\n'                       // not_found, shares "baker"
      + 'Neurocrine Biosciences,neurocrine.com,http://l/n.png,"X"'    // resolves (fuzzy)
    const data = await (await post({ csv })).json()
    const baker = data.preview.find((p: any) => p.company_name === 'Baker Botts L.L.P.')
    const neuro = data.preview.find((p: any) => p.company_name === 'Neurocrine Biosciences')
    expect(baker.action).toBe('not_found')
    expect(baker.closest_network_matches[0]).toMatchObject({ company_name: 'Baker McKenzie', slug: 'baker-mckenzie' })
    expect(neuro.action).toBe('update')
    expect(neuro.closest_network_matches).toEqual([]) // resolved rows carry none
  })

  it('debug payload exposes the candidate universe (network + csv) when requested', async () => {
    h.companies = []
    h.profiles = [{ company: 'Neurocrine' }]
    const csv = 'company_name,website,logo_url,description\nNeurocrine Biosciences,neurocrine.com,,'
    const data = await (await post({ csv, debug: true })).json()
    expect(data.debug.network).toEqual([{ name: 'Neurocrine', slug: 'neurocrine' }])
    expect(data.debug.csv[0]).toMatchObject({ name: 'Neurocrine Biosciences', slug: 'neurocrine-biosciences' })
  })

  it('a failed profiles read surfaces networkError (root-cause signal), not a silent empty network', async () => {
    h.companies = []
    h.profilesError = 'permission denied for table profiles'
    const csv = 'company_name,website,logo_url,description\nNeurocrine Biosciences,neurocrine.com,http://src/n.png,"Biopharma."'
    const data = await (await post({ csv })).json()
    expect(data.summary.networkError).toContain('permission denied')
    expect(data.summary.networkCount).toBe(0)
    expect(data.summary.notFound).toBe(1) // network empty → correctly unresolved
  })

  it('fuzzy: full CSV name resolves to the short member company, materializes it, fills fields', async () => {
    h.companies = []
    h.profiles = [{ company: 'Neurocrine' }]   // member typed the short name
    const csv = 'company_name,website,logo_url,description\nNeurocrine Biosciences,neurocrine.com,http://src/n.png,"Biopharma."'
    // Preview first: should resolve (fuzzy), not not_found.
    const prev = await (await post({ csv })).json()
    expect(prev.summary.notFound).toBe(0)
    expect(prev.preview[0].action).toBe('update')
    expect(prev.preview[0].confidence).toBe('fuzzy')
    expect(prev.preview[0].slug).toBe('neurocrine')
    // Apply: materialize under the RESOLVED slug + fill both fields.
    const data = await (await post({ csv, apply: true })).json()
    expect(h.ensured).toContain('neurocrine')
    expect(downloadAndStoreLogo).toHaveBeenCalledWith(expect.anything(), 'neurocrine', ['http://src/n.png'])
    expect(data.summary.updatedFields).toBe(2)
    const row = h.companies.find((r) => r.slug === 'neurocrine')
    expect(row.description).toBe('Biopharma.')
  })

  it('does not overwrite existing logo/description on a materialized-or-real row', async () => {
    h.companies = [{ slug: 'acme', name: 'Acme', logo_url: 'http://has/logo.png', description: 'Existing desc.', admin_edited: false }]
    h.profiles = [{ company: 'Acme' }]
    const data = await (await post({ csv: CSV, apply: true })).json()
    expect(data.summary.updatedFields).toBe(0)      // both already present → skip
    expect(h.companies[0].logo_url).toBe('http://has/logo.png')
    expect(h.companies[0].description).toBe('Existing desc.')
    expect(downloadAndStoreLogo).not.toHaveBeenCalled()
  })
})

// ---- Write-sink slug guard: /api/admin/companies/upsert -----------------------
describe('companies/upsert — malformed slug write guard', () => {
  const call = (body: any) =>
    upsertPOST(new Request('http://x/api/admin/companies/upsert', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }))

  it('C. rejects a slug containing "http" (the malformed value)', async () => {
    const res = await call({ slug: 'akamai-technologies-https://akamai.com-https://example.com', name: 'Akamai' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/invalid slug/i)
    expect(h.companies).toHaveLength(0) // nothing written
  })

  it('rejects a slug longer than 80 characters', async () => {
    const res = await call({ slug: 'a'.repeat(90), name: 'X' })
    expect(res.status).toBe(400)
    expect(h.companies).toHaveLength(0)
  })

  it('accepts a valid canonical slug (incl. multi-word registry slugs)', async () => {
    expect((await call({ slug: 'akamai-technologies', name: 'Akamai Technologies' })).status).toBe(200)
    expect((await call({ slug: 'davis-wright-tremaine', name: 'Davis Wright Tremaine LLP' })).status).toBe(200)
  })
})
