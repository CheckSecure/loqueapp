import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * /api/profile/update must fire the SAME background company-enrichment pipeline
 * as the /dashboard/profile server action, so every real save path is covered.
 *
 * Rules under test:
 *  - trigger when a company is first set, or changed to a different company
 *  - do NOT trigger when unrelated fields are saved and the company is unchanged
 *    AND its row is already enriched
 *  - DO trigger on an unchanged company when its row is missing/incomplete (backfill)
 *  - do NOT trigger when the company is cleared / non-linkable
 *  - a FAILED profile update must never trigger enrichment
 */

const state = vi.hoisted(() => ({
  user: { id: 'user-1' } as any,
  priorCompany: null as string | null,          // value returned by the pre-update read
  persistedCompany: null as string | null,       // value returned by the update .select()
  updateError: null as { message: string } | null,
  updatedRows: [{ id: 'user-1' }] as any[] | null, // set to [] / null to simulate 0-row update
  companyRow: null as any,                        // companies row for the incomplete-check
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: () => ({
      // pre-update read: .select('company').eq('id',..).maybeSingle()
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { company: state.priorCompany }, error: null }) }) }),
      // update: .update(payload).eq('id',..).select('id, company')
      update: () => ({ eq: () => ({ select: async () => ({
        data: state.updateError ? null : (state.updatedRows === null ? null : state.updatedRows.map(r => ({ ...r, company: state.persistedCompany }))),
        error: state.updateError,
      }) }) }),
    }),
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.companyRow, error: null }) }) }),
    }),
  }),
}))

const scheduleEnrichment = vi.fn()
vi.mock('@/lib/company/enrichment/schedule', () => ({ scheduleEnrichment: (...a: any[]) => scheduleEnrichment(...a) }))
vi.mock('@/app/actions/verify-linkedin', () => ({ verifyLinkedInConsistency: async () => {} }))
vi.mock('@/lib/trust/signals', () => ({ checkProfileCompletion: async () => {} }))

import { POST } from '@/app/api/profile/update/route'

function post(fields: Record<string, string>) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return POST(new Request('http://localhost/api/profile/update', { method: 'POST', body: fd }) as any)
}

beforeEach(() => {
  scheduleEnrichment.mockClear()
  state.user = { id: 'user-1' }
  state.priorCompany = null
  state.persistedCompany = null
  state.updateError = null
  state.updatedRows = [{ id: 'user-1' }]
  state.companyRow = null
})

describe('/api/profile/update company enrichment scheduling', () => {
  it('setting a company for the first time triggers enrichment', async () => {
    state.priorCompany = null
    state.persistedCompany = 'Vercel'
    state.companyRow = null // no row yet
    const res = await post({ company: 'Vercel' })
    expect(res.status).toBe(200)
    expect(scheduleEnrichment).toHaveBeenCalledTimes(1)
    expect(scheduleEnrichment).toHaveBeenCalledWith(expect.anything(), 'vercel', 'Vercel')
  })

  it('changing to a different company triggers enrichment (even if that row is already enriched)', async () => {
    state.priorCompany = 'Acme Corp'
    state.persistedCompany = 'Vercel'
    state.companyRow = { slug: 'vercel', admin_edited: false, enrichment_status: 'enriched' } // changed short-circuits
    const res = await post({ company: 'Vercel' })
    expect(res.status).toBe(200)
    expect(scheduleEnrichment).toHaveBeenCalledTimes(1)
    expect(scheduleEnrichment).toHaveBeenCalledWith(expect.anything(), 'vercel', 'Vercel')
  })

  it('saving unrelated fields without changing company does NOT trigger when already enriched', async () => {
    state.priorCompany = 'Vercel'
    state.persistedCompany = 'Vercel'
    state.companyRow = { slug: 'vercel', admin_edited: false, enrichment_status: 'enriched' }
    const res = await post({ company: 'Vercel', bio: 'new bio' })
    expect(res.status).toBe(200)
    expect(scheduleEnrichment).not.toHaveBeenCalled()
  })

  it('unchanged company DOES trigger when the company row is missing/incomplete (backfill)', async () => {
    state.priorCompany = 'Vercel'
    state.persistedCompany = 'Vercel'
    state.companyRow = { slug: 'vercel', admin_edited: false, enrichment_status: 'failed' } // incomplete
    const res = await post({ bio: 'unrelated change only' }) // company NOT submitted
    expect(res.status).toBe(200)
    expect(scheduleEnrichment).toHaveBeenCalledTimes(1)
    expect(scheduleEnrichment).toHaveBeenCalledWith(expect.anything(), 'vercel', 'Vercel')
  })

  it('unchanged company with an admin_edited row does NOT trigger (admin override preserved)', async () => {
    state.priorCompany = 'Vercel'
    state.persistedCompany = 'Vercel'
    state.companyRow = { slug: 'vercel', admin_edited: true, enrichment_status: null }
    const res = await post({ bio: 'unrelated' })
    expect(res.status).toBe(200)
    expect(scheduleEnrichment).not.toHaveBeenCalled()
  })

  it('clearing the company does NOT trigger enrichment', async () => {
    state.priorCompany = 'Vercel'
    state.persistedCompany = '' // cleared
    const res = await post({ company: '' })
    expect(res.status).toBe(200)
    expect(scheduleEnrichment).not.toHaveBeenCalled()
  })

  it('a non-linkable placeholder company does NOT trigger enrichment', async () => {
    state.priorCompany = null
    state.persistedCompany = 'Stealth'
    const res = await post({ company: 'Stealth' })
    expect(res.status).toBe(200)
    expect(scheduleEnrichment).not.toHaveBeenCalled()
  })

  it('a FAILED profile update never triggers enrichment', async () => {
    state.updateError = { message: 'db exploded' }
    state.persistedCompany = 'Vercel'
    const res = await post({ company: 'Vercel' })
    expect(res.status).toBe(500)
    expect(scheduleEnrichment).not.toHaveBeenCalled()
  })

  it('a 0-row (RLS/missing profile) update never triggers enrichment', async () => {
    state.updatedRows = []
    state.persistedCompany = 'Vercel'
    const res = await post({ company: 'Vercel' })
    expect(res.status).toBe(409)
    expect(scheduleEnrichment).not.toHaveBeenCalled()
  })
})
