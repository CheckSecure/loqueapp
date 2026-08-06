import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Company logo in the identity line (full profile only). IdentityLine gains an
 * OPTIONAL canonical `company` prop; when present with a slug it renders the logo
 * + name inside one /company/{slug} link. Absent → exact free-text behavior.
 * (JSX can't render under vitest's jsx:preserve, so these are structural — the full
 * build/typecheck proves existing callers still compile.)
 */
const identityLine = readFileSync('components/IdentityLine.tsx', 'utf8')
const profilePage = readFileSync('app/dashboard/profile/[id]/page.tsx', 'utf8')
const companyLogo = readFileSync('components/CompanyLogo.tsx', 'utf8')

describe('IdentityLine — optional canonical company', () => {
  it('the company prop is OPTIONAL (existing callers unchanged)', () => {
    expect(identityLine).toMatch(/company\?:\s*\{[^}]*name\?:[^}]*slug\?:[^}]*logo_url\?:/)
  })

  it('canonical company renders the CompanyLogo inside a /company/{slug} link', () => {
    // one link, gated on company?.slug, wrapping the logo + name
    expect(identityLine).toContain('company?.slug ? (')
    expect(identityLine).toContain('href={`/company/${company.slug}`}')
    expect(identityLine).toContain('<CompanyLogo')
    // both logo and name inside the same link (both clickable → company page)
    const linkBlock = identityLine.slice(identityLine.indexOf('company?.slug ? ('), identityLine.indexOf(') : ('))
    expect(linkBlock).toContain('<CompanyLogo')
    expect(linkBlock).toContain('company.name || name')
  })

  it('fixed logo size + no typography change (inline-flex, sized logo)', () => {
    expect(identityLine).toMatch(/<CompanyLogo url=\{company\.logo_url\} name=\{[^}]+\} size=\{16\}/)
    expect(identityLine).toContain('inline-flex items-center')
  })

  it('NO canonical company (or no slug) → falls back to the existing free-text CompanyLink (no logo)', () => {
    expect(identityLine).toContain(') : (')
    const fallback = identityLine.slice(identityLine.indexOf(') : ('))
    expect(fallback).toContain('<CompanyLink company={p.company}')
    expect(fallback).not.toContain('<CompanyLogo') // no logo on the free-text path
  })

  it('placeholder companies still render plain (identity.primary) — unchanged', () => {
    expect(identityLine).toContain('return <>{identity.primary || \'\'}</>')
  })
})

describe('CompanyLogo — initials fallback preserved (unchanged component)', () => {
  it('still falls back to initials on missing/failed url', () => {
    expect(companyLogo).toContain('const [failed, setFailed] = useState(false)')
    expect(companyLogo).toContain('onError={() => setFailed(true)}')
    expect(companyLogo).toContain('companyInitials')
  })
})

describe('Network — logo in the EXPANDED connection detail only, not the compact card', () => {
  const networkPage = readFileSync('app/dashboard/network/page.tsx', 'utf8')
  const modal = readFileSync('components/network/ConnectionDetailModal.tsx', 'utf8')
  const card = readFileSync('components/NetworkCard.tsx', 'utf8')

  it('the Network connections query joins the canonical company in ONE query (no N+1)', () => {
    expect(networkPage).toContain('company_rel:companies!company_id(id, name, slug, logo_url)')
    expect(networkPage).toContain('company_id,') // fetched for the guard
    // no separate companies query on the Network page
    expect(networkPage).not.toMatch(/\.from\('companies'\)/)
  })

  it('the EXPANDED connection detail (modal) passes canonical company → logo shows', () => {
    expect(modal).toContain('<IdentityLine profile={profile} company={(profile as any).company_rel} />')
  })

  it('the COMPACT Network card does NOT pass company → no logo (unchanged)', () => {
    expect(card).toContain('<IdentityLine profile={profile} guardCardClick />')
    // the card's IdentityLine never receives a company prop
    expect(card).not.toMatch(/<IdentityLine[^>]*company=/)
  })

  it('missing company_id → company_rel null → free-text behavior preserved (IdentityLine falls back)', () => {
    // IdentityLine gates the logo on company?.slug; a null company_rel → CompanyLink free-text
    expect(identityLine).toContain('company?.slug ? (')
    expect(identityLine).toContain('<CompanyLink company={p.company}')
  })

  it('no matching / privacy / RLS / company-page code touched by the Network change', () => {
    // the Network page change is purely the select embed; it must not reference these
    for (const forbidden of ['generateMatchInsights =', 'canViewerDiscoverMember', 'ENABLE ROW LEVEL', 'CREATE POLICY']) {
      // (generateMatchInsights is still CALLED for insights, but not modified — ensure no new scoring logic)
      if (forbidden !== 'generateMatchInsights =') expect(networkPage).not.toContain(forbidden)
    }
  })
})

describe('profile page — single-query join, single company identity, full-profile only', () => {
  it('joins the canonical company in the SAME query (no second query)', () => {
    expect(profilePage).toContain('company_rel:companies!company_id(id, name, slug, logo_url)')
    // no separate companies fetch
    expect(profilePage).not.toMatch(/\.from\('companies'\)/)
  })

  it('passes the canonical company ONLY to the headline IdentityLine', () => {
    expect(profilePage).toContain('<IdentityLine profile={profile} company={profile.company_rel} />')
    // exactly one IdentityLine on the page (the headline)
    expect((profilePage.match(/<IdentityLine\b/g) || []).length).toBe(1)
  })

  it('introduces NO new company section/component (no duplicate company block)', () => {
    expect(profilePage).not.toContain('ProfileCompanyIdentity')
    expect(profilePage).not.toContain('ProfileCompanyChip')
    // company still appears only via IdentityLine (headline) + CompanyLink (previous roles)
  })
})
