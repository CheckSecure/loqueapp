import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  resolveCanonicalCompanyLink,
  resolveCanonicalCompanyId,
} from '@/lib/company/canonicalLink'

/**
 * Automatic member → canonical company linking (PART 2).
 *
 * resolveCanonicalCompanyLink / resolveCanonicalCompanyId reuse the CSV importer's
 * resolver (exact / registry-canonical / fuzzy-unique) and add link POLICY:
 * set / clear / preserve. These tests pin the policy with a fake companies table.
 */

// Fake companies table: `.from('companies').select(cols)` resolves to {data,error}.
function fakeDb(companies: Array<{ id: string; name: string | null; slug: string | null }>, error: any = null) {
  return { from: () => ({ select: () => Promise.resolve(error ? { data: null, error } : { data: companies, error: null }) }) }
}
// A client whose companies query THROWS (network blow-up) — must fail open.
const throwingDb = { from: () => ({ select: () => { throw new Error('connection reset') } }) }

const COMPANIES = [
  { id: 'net-id', name: 'Netflix', slug: 'netflix' },                                  // exact
  { id: 'vz-id', name: 'Verizon', slug: 'verizon-communications' },                    // registry-canonical alias
  { id: 'neu-id', name: 'Neurocrine Biosciences', slug: 'neurocrine-biosciences' },    // fuzzy-unique
  { id: 'acme-tech', name: 'Acme Technologies', slug: 'acme-technologies' },           // fuzzy-ambiguous pair …
  { id: 'acme-hold', name: 'Acme Holdings', slug: 'acme-holdings' },                   // … with this one
]
const db = fakeDb(COMPANIES)

describe('resolveCanonicalCompanyLink — link policy', () => {
  it('EXACT canonical match → set', async () => {
    const r = await resolveCanonicalCompanyLink(db, 'Netflix')
    expect(r).toEqual({ action: 'set', companyId: 'net-id', confidence: 'exact' })
  })

  it('NORMALIZED/registry-alias match → set ("Verizon" → verizon-communications)', async () => {
    const r = await resolveCanonicalCompanyLink(db, 'Verizon')
    expect(r.action).toBe('set')
    if (r.action === 'set') { expect(r.companyId).toBe('vz-id'); expect(r.confidence).toBe('canonical') }
  })

  it('FUZZY-only match is NOT auto-linked → clear, even though "Neurocrine" is a unique fuzzy candidate', async () => {
    // fuzzy similarity (trailing-descriptor reduction) is never trusted for auto-linking
    expect(await resolveCanonicalCompanyLink(db, 'Neurocrine')).toEqual({ action: 'clear' })
  })

  it('only EXACT and CANONICAL confidences ever set (never fuzzy)', async () => {
    const netflix = await resolveCanonicalCompanyLink(db, 'Netflix')
    const verizon = await resolveCanonicalCompanyLink(db, 'Verizon')
    for (const r of [netflix, verizon]) {
      expect(r.action).toBe('set')
      if (r.action === 'set') expect(['exact', 'canonical']).toContain(r.confidence)
    }
  })

  it('AMBIGUOUS fuzzy (two candidates share the key) → clear, never guesses', async () => {
    expect(await resolveCanonicalCompanyLink(db, 'Acme')).toEqual({ action: 'clear' })
  })

  it('AMBIGUOUS registry alias (BD / TKO) → clear (rejected before any query)', async () => {
    expect(await resolveCanonicalCompanyLink(db, 'BD')).toEqual({ action: 'clear' })
    expect(await resolveCanonicalCompanyLink(db, 'TKO')).toEqual({ action: 'clear' })
  })

  it('NO match → clear', async () => {
    expect(await resolveCanonicalCompanyLink(db, 'Zzz Nonexistent Co')).toEqual({ action: 'clear' })
  })

  it('PLACEHOLDER identities → clear (never linked)', async () => {
    for (const p of ['Independent', 'Self-employed', 'Retired', 'Confidential', 'Stealth', 'Between roles']) {
      expect(await resolveCanonicalCompanyLink(db, p)).toEqual({ action: 'clear' })
    }
  })

  it('empty / null company → clear', async () => {
    expect(await resolveCanonicalCompanyLink(db, '')).toEqual({ action: 'clear' })
    expect(await resolveCanonicalCompanyLink(db, null)).toEqual({ action: 'clear' })
  })

  it('never uses SUBSTRING matching ("Net" does not match "Netflix")', async () => {
    expect(await resolveCanonicalCompanyLink(db, 'Net')).toEqual({ action: 'clear' })
  })

  it('company CHANGE recalculates: same input → set; changed to unresolved → clear (stale link dropped)', async () => {
    expect((await resolveCanonicalCompanyLink(db, 'Netflix')).action).toBe('set')
    // member edits company to something unmatched → clear ⇒ write path sets company_id = null
    expect((await resolveCanonicalCompanyLink(db, 'Some New Unlisted LLC')).action).toBe('clear')
  })

  it('query ERROR → preserve (fail open; company_id untouched, save never blocked)', async () => {
    expect(await resolveCanonicalCompanyLink(fakeDb([], { message: 'boom' }), 'Netflix')).toEqual({ action: 'preserve' })
    expect(await resolveCanonicalCompanyLink(throwingDb, 'Netflix')).toEqual({ action: 'preserve' })
  })
})

describe('resolveCanonicalCompanyId — convenience', () => {
  it('returns the id on a clear match, null otherwise', async () => {
    expect(await resolveCanonicalCompanyId(db, 'Netflix')).toBe('net-id')
    expect(await resolveCanonicalCompanyId(db, 'Acme')).toBeNull()        // ambiguous
    expect(await resolveCanonicalCompanyId(db, 'Independent')).toBeNull() // placeholder
    expect(await resolveCanonicalCompanyId(db, 'Zzz Nonexistent')).toBeNull()
  })
  it('null (not the id) when the lookup fails — never surfaces a wrong link', async () => {
    expect(await resolveCanonicalCompanyId(fakeDb([], { message: 'boom' }), 'Netflix')).toBeNull()
  })
})

// ── Write-path wiring (structural — the real files must call the resolver) ──────
describe('canonical linking is wired into the member profile write paths', () => {
  const actions = readFileSync('app/actions.ts', 'utf8')
  const updateRoute = readFileSync('app/api/profile/update/route.ts', 'utf8')

  it('onboarding + profile-edit (app/actions.ts) resolve + write company_id on BOTH upserts', () => {
    expect(actions).toContain("from '@/lib/company/canonicalLink'")
    // two upserts → two link resolutions → two company_id spreads
    expect((actions.match(/resolveCanonicalCompanyLink\(/g) || []).length).toBe(2)
    expect((actions.match(/company_id: companyLink\.action === 'set' \? companyLink\.companyId : null/g) || []).length).toBe(2)
    // preserve → company_id omitted entirely (fail open)
    expect((actions.match(/companyLink\.action !== 'preserve' &&/g) || []).length).toBe(2)
  })

  it('profile update API recomputes company_id only when a company was submitted', () => {
    expect(updateRoute).toContain("from '@/lib/company/canonicalLink'")
    expect(updateRoute).toContain('if (companySubmitted) {')
    expect(updateRoute).toContain('resolveCanonicalCompanyLink(linkAdmin, persistedCompany)')
    expect(updateRoute).toContain("company_id: link.action === 'set' ? link.companyId : null")
    expect(updateRoute).toContain("link.action !== 'preserve'")
  })

  it('the write paths NEVER modify profiles.company (only company_id) and never create companies', () => {
    // the follow-up update writes company_id + updated_at, not company
    expect(updateRoute).toMatch(/\.update\(\{ company_id: link\.action === 'set' \? link\.companyId : null, updated_at:/)
    // the helper never inserts/creates a companies row
    const helper = readFileSync('lib/company/canonicalLink.ts', 'utf8')
    expect(helper).not.toMatch(/\.insert\(|\.upsert\(/)
  })

  it('an OMITTED company (companySubmitted false) does not alter company_id', () => {
    // the recompute is guarded by companySubmitted, so a non-company edit preserves company_id
    const block = updateRoute.slice(updateRoute.indexOf('if (companySubmitted) {'))
    expect(updateRoute).toContain('if (companySubmitted) {')
    // the company_id update lives INSIDE that guard
    expect(block.indexOf("company_id: link.action === 'set'")).toBeGreaterThan(0)
  })

  it('the resolver rejects fuzzy links in code (only exact/canonical set)', () => {
    const helper = readFileSync('lib/company/canonicalLink.ts', 'utf8')
    expect(helper).toContain("if (match.confidence !== 'exact' && match.confidence !== 'canonical') return { action: 'clear' }")
  })
})

// ── Temporary diagnostic fully removed (PART 3) ────────────────────────────────
describe('operator-only logo diagnostic is completely removed from ConnectionDetailModal', () => {
  const modal = readFileSync('components/network/ConnectionDetailModal.tsx', 'utf8')
  it('no diagnostic component, state, gate, or test image remains', () => {
    expect(modal).not.toContain('LogoPaintDiagnostic')
    expect(modal).not.toContain('viewerIsAdmin')
    expect(modal).not.toContain('bizdev91')
    expect(modal).not.toContain('paint test')
    expect(modal).not.toContain('naturalWidth')
    expect(modal).not.toMatch(/onLoad=|Logo diagnostic/)
  })
  it('the real company-logo rendering (IdentityLine with canonical company) is unchanged', () => {
    expect(modal).toContain('<IdentityLine profile={profile} company={(profile as any).company_rel} />')
  })
})
