import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'admin', email: 'bizdev91@gmail.com' } as any,
  profiles: [] as any[],
  companies: [] as any[],
  enrichCalls: [] as string[],
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}))

vi.mock('@/lib/supabase/admin', () => {
  function from(table: string) {
    const b: any = {
      select() { return b },
      not() { return b },
      then(res: any, rej: any) { return Promise.resolve({ data: (h as any)[table] ?? [], error: null }).then(res, rej) },
    }
    return b
  }
  return { createAdminClient: () => ({ from }) }
})

// enrichCompany is exercised in enrich-company.test.ts; here we assert the route's
// batching / resumability / idempotency / auth, so we stub it to reflect the row.
vi.mock('@/lib/company/enrichCompany', () => ({
  enrichCompany: vi.fn(async (_admin: any, name: string) => {
    h.enrichCalls.push(name)
    return { status: 'enriched', company_name: name, logo_url: 'L', description: 'D', website_url: null, confidence: 'high', source: 'x', slug: name.toLowerCase() }
  }),
}))

import { POST } from '@/app/api/admin/company-enrichment/backfill/route'

const post = (body: any = {}) =>
  POST(new Request('http://x/api/admin/company-enrichment/backfill', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))

beforeEach(() => {
  h.user = { id: 'admin', email: 'bizdev91@gmail.com' }
  h.profiles = []
  h.companies = []
  h.enrichCalls = []
})

describe('company-enrichment backfill route', () => {
  it('401 for a non-admin caller', async () => {
    h.user = { id: 'x', email: 'someone@else.com' }
    expect((await post()).status).toBe(401)
    h.user = null
    expect((await post()).status).toBe(401)
  })

  it('enriches companies that are missing a logo or description', async () => {
    h.profiles = [{ company: 'Google' }, { company: 'Acme Corp' }]
    h.companies = [{ slug: 'google', logo_url: null, description: 'has desc', admin_edited: false }] // acme has no row → missing
    const res = await post()
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.totalMissing).toBe(2) // google (no logo) + acme (no row)
    expect(data.attempted).toBe(2)
    expect(data.succeeded).toBe(2)
    expect(data.done).toBe(true)
    expect(h.enrichCalls.sort()).toEqual(['Acme Corp', 'Google'])
  })

  it('is idempotent — skips already-complete (and admin-edited) companies, no enrichment calls', async () => {
    h.profiles = [{ company: 'Google' }, { company: 'Acme Corp' }]
    h.companies = [
      { slug: 'google', logo_url: 'L', description: 'D', admin_edited: false }, // complete
      { slug: 'acme', logo_url: null, description: null, admin_edited: true },  // admin-curated → never touched
    ]
    const res = await post()
    const data = await res.json()
    expect(data.totalMissing).toBe(0)
    expect(data.attempted).toBe(0)
    expect(data.skipped).toBe(2)
    expect(h.enrichCalls).toHaveLength(0)
    expect(data.done).toBe(true)
  })

  it('is resumable — returns a nextOffset until done, walking a stable list', async () => {
    // 30 distinct companies, none enriched → batch size 25 → two windows.
    h.profiles = Array.from({ length: 30 }, (_, i) => ({ company: `Company${String(i).padStart(2, '0')}` }))
    h.companies = []
    const first = await (await post({ offset: 0 })).json()
    expect(first.done).toBe(false)
    expect(first.nextOffset).toBe(25)
    expect(first.attempted).toBe(25)
    const second = await (await post({ offset: first.nextOffset })).json()
    expect(second.done).toBe(true)
    expect(second.attempted).toBe(5)
    expect(second.nextOffset).toBeNull()
  })

  it('a per-company failure does not abort the batch', async () => {
    const { enrichCompany } = await import('@/lib/company/enrichCompany')
    ;(enrichCompany as any).mockImplementationOnce(async () => { throw new Error('lookup boom') })
    h.profiles = [{ company: 'Google' }, { company: 'Acme Corp' }]
    h.companies = []
    const data = await (await post()).json()
    expect(data.attempted).toBe(2)
    expect(data.failed).toBe(1)   // the throwing one
    expect(data.succeeded).toBe(1) // the other still processed
    expect(data.done).toBe(true)
  })
})
