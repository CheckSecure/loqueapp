import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseImportCsv, parseCsvRecords, computeImportPlan, type ExistingCompany } from '@/lib/company/csvImport'

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

const h = vi.hoisted(() => ({
  user: { id: 'admin', email: 'bizdev91@gmail.com' } as any,
  companies: [] as any[],
  profiles: [] as any[],
  updates: [] as any[],
  ensured: [] as string[],
  logoResult: 'https://bucket/acme.png?v=1' as string | null,
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
        return Promise.resolve({ data: rowsFor().map((r: any) => ({ ...r })), error: null }).then(res, rej)
      },
    }
    return b
  }
  return { createAdminClient: () => ({ from }) }
})

import { POST } from '@/app/api/admin/company-enrichment/import/route'
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
