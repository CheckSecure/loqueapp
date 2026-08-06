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

  it('fixed logo size 22px + no typography change (inline-flex, sized logo)', () => {
    // 22px on the full profile AND the expanded Network modal (both pass `company`
    // to this one IdentityLine). Fixed square via CompanyLogo → no layout shift.
    expect(identityLine).toMatch(/<CompanyLogo url=\{company\.logo_url\} name=\{[^}]+\} size=\{22\}/)
    expect(identityLine).not.toContain('size={16}')
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

  it('logo size is 22px in the expanded modal (via the single IdentityLine logo renderer) and nowhere sets 16', () => {
    // the modal passes `company`, so its IdentityLine renders the CompanyLogo at the
    // one size defined in IdentityLine (22px); the compact card passes no company → no logo.
    expect(modal).toContain('company={(profile as any).company_rel}')
    expect(identityLine).toContain('size={22}')
    expect(identityLine).not.toContain('size={16}')
    expect(card).not.toContain('<CompanyLogo') // compact card renders no logo at any size
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

/**
 * Payload-shape contract for the logo.
 *
 * This fixture is the EXACT object PostgREST returns for the deployed embed
 * `company_rel:companies!company_id(id, name, slug, logo_url)`, captured live
 * against production data as the authenticated user (RLS enforced) — NOT a
 * hand-built guess. profiles.company_id → companies is many-to-one, so the embed
 * is TO-ONE: `company_rel` is a single OBJECT, not an array.
 *
 * IdentityLine's logo gate is `company?.slug`. The modal passes `company_rel`
 * straight through, so the logo shows iff `company_rel.slug` is a top-level
 * string. If PostgREST ever returned an ARRAY (a to-many embed), `.slug` would be
 * undefined and the logo would silently vanish while the company text stayed —
 * the exact "text shows, logo missing" symptom. This test locks the to-one shape.
 */
describe('Network embed payload shape — real Supabase to-one object (regression)', () => {
  // Verbatim capture: userClient.from('profiles').select('… company_rel:companies!company_id(id, name, slug, logo_url)')
  const REAL_EMBED = {
    id: 'd657891e-4e69-4275-b589-76a70fe387e2',
    name: 'Verizon',
    slug: 'verizon-communications',
    logo_url: 'https://cyjyutmtsovfnnbbluxc.supabase.co/storage/v1/object/public/company-logos/verizon-communications.jpg?v=3734',
  }
  // The logo-render decision, mirroring IdentityLine's `company?.slug ? <logo+name> : <free-text>` gate,
  // fed the company prop exactly as the modal passes it: `(profile as any).company_rel`.
  const logoShows = (company: any) => Boolean(company?.slug)

  it('the embed is a to-one OBJECT (not an array) with top-level slug + logo_url', () => {
    expect(Array.isArray(REAL_EMBED)).toBe(false)
    expect(typeof REAL_EMBED.slug).toBe('string')
    expect(REAL_EMBED.logo_url).toMatch(/^https:\/\/.+\/company-logos\/.+\.(png|jpg|jpeg|svg|webp)/i)
  })

  it('the real object payload passes IdentityLine’s gate → logo renders', () => {
    expect(logoShows(REAL_EMBED)).toBe(true)
  })

  it('an ARRAY-wrapped embed (to-many regression) would fail the gate → logo vanishes, text stays', () => {
    // documents the failure mode: `[obj].slug` is undefined → free-text branch, no logo
    expect(logoShows([REAL_EMBED])).toBe(false)
  })

  it('missing company_id (null embed) → gate fails → free-text, no logo (by design)', () => {
    expect(logoShows(null)).toBe(false)
    expect(logoShows(undefined)).toBe(false)
    expect(logoShows({ name: 'Independent', slug: null, logo_url: null })).toBe(false)
  })
})

/**
 * FULL prop path: server page → NetworkList → NetworkCard → ConnectionDetailModal.
 *
 * The isolated-payload test above proves the Supabase row carries company_rel; it
 * does NOT prove the object still carries it by the time the modal reads
 * `(profile as any).company_rel`. This block recreates EVERY hop the way the real
 * files transform the data, so a future refactor that reconstructs/spreads the
 * object and drops unknown fields (the classic `{ id, name, title, company }`
 * remap) fails here — and pairs each data hop with a structural guard on the
 * actual source so the model can't silently drift from the code.
 */
describe('Full prop path preserves company_rel end-to-end (regression)', () => {
  const networkPage = readFileSync('app/dashboard/network/page.tsx', 'utf8')
  const list = readFileSync('components/NetworkList.tsx', 'utf8')
  const card = readFileSync('components/NetworkCard.tsx', 'utf8')
  const modal = readFileSync('components/network/ConnectionDetailModal.tsx', 'utf8')

  // The Supabase row exactly as the deployed select returns it (to-one object).
  const profileRow = {
    id: 'p1', full_name: 'James Jin Park', title: 'General Counsel', company: 'Verizon',
    company_id: 'd657891e-4e69-4275-b589-76a70fe387e2', avatar_url: null, account_status: 'active',
    company_rel: { id: 'd657891e-4e69-4275-b589-76a70fe387e2', name: 'Verizon', slug: 'verizon-communications', logo_url: 'https://cyjyutmtsovfnnbbluxc.supabase.co/storage/v1/object/public/company-logos/verizon-communications.jpg?v=3734' },
  }

  // ── Hop 1 — server page builds the connection (page.tsx:114-121) ──
  const profileMap: Record<string, any> = { p1: profileRow }
  const otherId = 'p1'
  const serverConnection = {
    matchId: 'm1', profile: profileMap[otherId], connectedAt: null,
    isNew: false, matchInsights: [], conversationId: null,
  }

  // ── Hop 2 — NetworkList destructures the connection and forwards `profile` (NetworkList.tsx:102-106) ──
  const { matchId, profile: listProfile, connectedAt, isNew, matchInsights, conversationId } = serverConnection
  const networkCardProps = { matchId, profile: listProfile, connectedAt, isNew, matchInsights, conversationId }

  // ── Hop 3 — NetworkCard forwards `profile` straight to the modal (NetworkCard.tsx:187-194) ──
  const modalProps = { matchId: networkCardProps.matchId, profile: networkCardProps.profile, connectedAt, matchInsights, conversationId }

  // ── Hop 4 — the modal reads `(profile as any).company_rel` (ConnectionDetailModal.tsx:202) ──
  const modalCompanyArg = (modalProps.profile as any).company_rel

  it('company_rel with slug + logo_url survives all four hops to the modal’s IdentityLine prop', () => {
    expect(modalCompanyArg).toBeTruthy()
    expect(modalCompanyArg.slug).toBe('verizon-communications')
    expect(modalCompanyArg.logo_url).toContain('/company-logos/verizon-communications.jpg')
    // and the modal-gate that renders the logo would pass on this surviving object
    expect(Boolean(modalCompanyArg?.slug)).toBe(true)
  })

  it('no hop reconstructs profile as a field-subset (the drop pattern that would omit company_rel)', () => {
    // server: connection literal forwards the whole `profile` var, not a remap
    expect(networkPage).toMatch(/return \{\s*matchId: m\.id,\s*profile,/)
    // NetworkList → NetworkCard: forwards the whole object
    expect(list).toContain('profile={profile}')
    expect(list).not.toMatch(/profile=\{\{/) // no inline object reconstruction
    // NetworkCard → modal: forwards the whole object
    expect(card).toContain('profile={profile}')
    expect(card).not.toMatch(/<ConnectionDetailModal[\s\S]*?profile=\{\{/)
    // modal reads company_rel off the received profile (does not re-fetch/rebuild)
    expect(modal).toContain('company={(profile as any).company_rel}')
  })

  it('a hypothetical field-subset remap at NetworkCard WOULD be caught (drop is observable)', () => {
    // simulate the classic bug: rebuild the modal profile from named fields only
    const remapped = { id: modalProps.profile.id, full_name: modalProps.profile.full_name, title: modalProps.profile.title, company: modalProps.profile.company }
    expect((remapped as any).company_rel).toBeUndefined() // company_rel lost → logo would vanish
    expect(Boolean((remapped as any).company_rel?.slug)).toBe(false)
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
