import { describe, it, expect, vi, beforeEach } from 'vitest'
import { validateLogoBytes, sniffLogo } from '@/lib/company/imageSniff'
import { buildEditorFormFromPreview } from '@/lib/company/previewEditor'
import { companySlug } from '@/lib/company/slug'

// ---- byte builders ----------------------------------------------------------
const png = (n = 300) => { const b = new Uint8Array(Math.max(n, 8)); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); return b }
const jpg = (n = 300) => { const b = new Uint8Array(Math.max(n, 8)); b.set([0xff, 0xd8, 0xff], 0); return b }
const ico = (n = 300) => { const b = new Uint8Array(Math.max(n, 8)); b.set([0x00, 0x00, 0x01, 0x00], 0); return b }
const svg = () => new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><!-- ' + 'x'.repeat(220) + ' --><rect/></svg>')
const junk = (n = 300) => new Uint8Array(n).fill(0x7a)

// ---- 1. logo upload validation ----------------------------------------------
describe('validateLogoBytes / sniffLogo', () => {
  it('accepts real PNG, JPG, SVG, ICO', () => {
    expect(validateLogoBytes(png())).toMatchObject({ ok: true, ext: 'png' })
    expect(validateLogoBytes(jpg())).toMatchObject({ ok: true, ext: 'jpg' })
    expect(validateLogoBytes(svg())).toMatchObject({ ok: true, ext: 'svg' })
    expect(validateLogoBytes(ico())).toMatchObject({ ok: true, ext: 'ico' })
  })
  it('rejects tiny / placeholder files', () => {
    expect(validateLogoBytes(png(50))).toMatchObject({ ok: false })
  })
  it('rejects broken / non-image bytes', () => {
    expect(validateLogoBytes(junk())).toMatchObject({ ok: false })
    expect(sniffLogo(junk())).toBeNull()
  })
  it('rejects empty input', () => {
    expect(validateLogoBytes(new Uint8Array(0))).toMatchObject({ ok: false })
    expect(validateLogoBytes(null)).toMatchObject({ ok: false })
  })
  it('rejects oversized files', () => {
    expect(validateLogoBytes(png(5_000_001))).toMatchObject({ ok: false })
  })
  it('trusts magic bytes over a lying MIME header', () => {
    expect(validateLogoBytes(png(), 'text/plain')).toMatchObject({ ok: true, ext: 'png' })
  })
})

// ---- 2. preview row → editor form -------------------------------------------
describe('buildEditorFormFromPreview', () => {
  const preview = {
    company_name: 'Neurocrine Biosciences', slug: 'neurocrine', matched_company: 'Neurocrine',
    action: 'update' as const, csv_website: 'neurocrine.com', csv_logo_url: 'http://l/n.png', csv_description: 'Biopharma.',
  }

  it('pending company (no row): populates name/website/logo/description from the CSV', () => {
    const form = buildEditorFormFromPreview(preview, null)
    expect(form).toMatchObject({
      name: 'Neurocrine', website: 'neurocrine.com', logo_url: 'http://l/n.png', description: 'Biopharma.',
      industry: '', headquarters: '',
    })
  })

  it('not_found row (no match): opens a pending editor populated from the CSV company_name', () => {
    const p = {
      company_name: 'Brand New Co', slug: 'brand-new-co', matched_company: null, action: 'not_found' as const,
      csv_website: 'brandnew.com', csv_logo_url: 'http://l/b.png', csv_description: 'Does things.',
    }
    const form = buildEditorFormFromPreview(p, null)
    expect(form).toMatchObject({
      name: 'Brand New Co', website: 'brandnew.com', logo_url: 'http://l/b.png', description: 'Does things.',
      industry: '', headquarters: '',
    })
  })

  it('existing company: existing values WIN, CSV never overwrites; industry/HQ come from the record', () => {
    const existing = {
      slug: 'neurocrine', name: 'Neurocrine',
      meta: { name: 'Neurocrine', website: 'https://neurocrine.com', description: 'Existing desc.', industry: 'Biotech', headquarters: 'San Diego, CA', logo_url: 'http://has/logo.png' },
    }
    const form = buildEditorFormFromPreview(preview, existing)
    expect(form).toMatchObject({
      website: 'https://neurocrine.com', description: 'Existing desc.', logo_url: 'http://has/logo.png',
      industry: 'Biotech', headquarters: 'San Diego, CA',
    })
  })
})

// ---- 3 & 4. route tests (logo upload + create-on-save) ----------------------
const h = vi.hoisted(() => ({
  user: { id: 'admin', email: 'bizdev91@gmail.com' } as any,
  companies: [] as any[],
  uploads: [] as any[],
  upserts: [] as any[],
  uploadError: null as any,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}))

vi.mock('@/lib/supabase/admin', () => {
  const storageFrom = (bucket: string) => ({
    upload: async (path: string, buf: any, opts: any) => {
      h.uploads.push({ bucket, path, size: buf?.length ?? buf?.byteLength, contentType: opts?.contentType })
      return { error: h.uploadError }
    },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://store/${bucket}/${path}` } }),
  })
  const from = (_table: string) => ({
    upsert: async (payload: any) => {
      h.upserts.push(payload)
      if (!h.companies.some((r) => r.slug === payload.slug)) h.companies.push({ ...payload })
      return { error: null }
    },
  })
  return { createAdminClient: () => ({ storage: { from: storageFrom }, from }) }
})

import { POST as uploadLogoRoute } from '@/app/api/admin/companies/logo/route'
import { POST as upsertCompanyRoute } from '@/app/api/admin/companies/upsert/route'

const fakeFile = (bytes: Uint8Array, type = 'image/png') => ({ type, arrayBuffer: async () => bytes.slice().buffer })
const logoReq = (slug: any, file: any) => ({ formData: async () => ({ get: (k: string) => (k === 'slug' ? slug : k === 'file' ? file : null) }) }) as any
const jsonReq = (body: any) => new Request('http://x/api/admin/companies/upsert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  h.user = { id: 'admin', email: 'bizdev91@gmail.com' }
  h.companies = []
  h.uploads = []
  h.upserts = []
  h.uploadError = null
})

describe('logo upload route', () => {
  it('401 for a non-admin caller', async () => {
    h.user = { email: 'nope@else.com' }
    expect((await uploadLogoRoute(logoReq('acme', fakeFile(png())))).status).toBe(401)
  })

  it('400 on missing slug or file', async () => {
    expect((await uploadLogoRoute(logoReq(null, fakeFile(png())))).status).toBe(400)
    expect((await uploadLogoRoute(logoReq('acme', null))).status).toBe(400)
  })

  it('stores a valid logo in the company-logos bucket and returns its URL', async () => {
    const res = await uploadLogoRoute(logoReq('neurocrine', fakeFile(png(), 'image/png')))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(h.uploads).toHaveLength(1)
    expect(h.uploads[0]).toMatchObject({ bucket: 'company-logos', path: 'neurocrine.png', contentType: 'image/png' })
    expect(data.url).toContain('company-logos/neurocrine.png')
  })

  it('rejects a broken / tiny image and stores nothing', async () => {
    expect((await uploadLogoRoute(logoReq('acme', fakeFile(junk())))).status).toBe(400)
    expect((await uploadLogoRoute(logoReq('acme', fakeFile(png(50))))).status).toBe(400)
    expect(h.uploads).toHaveLength(0)
  })
})

describe('company upsert route — create on save', () => {
  it('creates a companies row for a not-yet-materialized (pending) company, admin_edited=true', async () => {
    const res = await upsertCompanyRoute(jsonReq({ slug: 'neurocrine', name: 'Neurocrine', website: 'neurocrine.com', description: 'Biopharma.' }))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(h.upserts[0]).toMatchObject({ slug: 'neurocrine', name: 'Neurocrine', admin_edited: true })
    expect(h.companies.some((r) => r.slug === 'neurocrine')).toBe(true)
  })

  it('saving a not_found company materializes it under the canonical slug (admin_edited=true)', async () => {
    const slug = companySlug('Brand New Co') // what openFromPreview/Save uses for a not_found row
    const res = await upsertCompanyRoute(jsonReq({ slug, name: 'Brand New Co', website: 'brandnew.com', description: 'Does things.' }))
    expect(res.status).toBe(200)
    expect(h.upserts[0]).toMatchObject({ slug, name: 'Brand New Co', admin_edited: true })
    expect(h.companies.some((r) => r.slug === slug)).toBe(true)
  })

  it('401 for a non-admin caller', async () => {
    h.user = { email: 'nope@else.com' }
    expect((await upsertCompanyRoute(jsonReq({ slug: 'x' }))).status).toBe(401)
  })
})
