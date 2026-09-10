import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STEP 1 — AUTHORITATIVE COMMUNITY RESOLUTION.
 *
 * Two questions, answered in two different places because the member is in two different states:
 *
 *   BEFORE the first profile INSERT  →  waitlist intent, via migration 099's
 *                                        resolve_intended_member_type() (service_role only)
 *   AFTER  the first profile INSERT  →  profiles.member_type, bound by migration 100 and immutable
 *
 * Every test below pins the same property in one of those two paths: an answer that is not an
 * unambiguous 'next' resolves to Professional, and nothing about the resolution is reachable from,
 * or influenced by, the browser.
 */

const ONBOARDING_PAGE = readFileSync('app/onboarding/page.tsx', 'utf8')
const LAYOUT = readFileSync('app/dashboard/layout.tsx', 'utf8')
const SIDEBAR = readFileSync('components/Sidebar.tsx', 'utf8')
const MOBILE_NAV = readFileSync('components/MobileNav.tsx', 'utf8')
const CONTEXT_SRC = readFileSync('lib/onboarding/communityContext.ts', 'utf8')
const MIGRATION_057 = readFileSync('supabase/migrations/057_public_profiles_contract_expand.sql', 'utf8')

// ── The admin client is the ONLY thing mocked. The resolver's own logic runs for real. ──────────
const rpc = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc }) }))

import { resolveOnboardingCommunity } from '@/lib/onboarding/communityContext'

beforeEach(() => {
  rpc.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

const resolved = (member_type: string) => ({ data: { outcome: 'resolved', member_type }, error: null })

// ═══ 1. THE RESOLVER'S ANSWER TABLE ═══════════════════════════════════════════════════════════
describe('1. pre-profile resolution maps every RPC outcome to a community', () => {
  it("resolved 'next' → next — the ONLY input that yields next", async () => {
    rpc.mockResolvedValue(resolved('next'))
    expect(await resolveOnboardingCommunity('student@example.com'))
      .toEqual({ community: 'next', resolution: 'resolved' })
  })

  it("resolved 'professional' → professional", async () => {
    rpc.mockResolvedValue(resolved('professional'))
    expect(await resolveOnboardingCommunity('pro@example.com'))
      .toEqual({ community: 'professional', resolution: 'resolved' })
  })

  it('ambiguous → professional', async () => {
    rpc.mockResolvedValue({ data: { outcome: 'ambiguous', count: 2 }, error: null })
    expect(await resolveOnboardingCommunity('two@example.com'))
      .toEqual({ community: 'professional', resolution: 'ambiguous' })
  })

  it('not_found → professional', async () => {
    rpc.mockResolvedValue({ data: { outcome: 'not_found' }, error: null })
    expect(await resolveOnboardingCommunity('nobody@example.com'))
      .toEqual({ community: 'professional', resolution: 'not_found' })
  })

  it('an RPC ERROR → professional, and logs a class only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    rpc.mockResolvedValue({ data: null, error: { code: '42883', message: 'function does not exist' } })
    expect(await resolveOnboardingCommunity('x@example.com'))
      .toEqual({ community: 'professional', resolution: 'unavailable' })
    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).not.toMatch(/x@example\.com/)
    expect(logged).not.toMatch(/function does not exist/)
  })

  it('a THROWN RPC → professional', async () => {
    rpc.mockRejectedValue(new Error('network'))
    expect(await resolveOnboardingCommunity('x@example.com'))
      .toEqual({ community: 'professional', resolution: 'unavailable' })
  })

  it("an UNEXPECTED member_type on a 'resolved' outcome → professional, never coerced", async () => {
    for (const bogus of ['student', 'NEXT', 'professsional', '', null, undefined, 7, {}]) {
      rpc.mockResolvedValue({ data: { outcome: 'resolved', member_type: bogus }, error: null })
      const got = await resolveOnboardingCommunity('x@example.com')
      expect(got.community).toBe('professional')
      expect(got.resolution).toBe('unavailable')
    }
  })

  it('an unrecognised OUTCOME string → professional', async () => {
    rpc.mockResolvedValue({ data: { outcome: 'maybe' }, error: null })
    expect((await resolveOnboardingCommunity('x@example.com')).community).toBe('professional')
  })

  it('a null/empty payload → professional', async () => {
    for (const data of [null, undefined, {}, 'next']) {
      rpc.mockResolvedValue({ data, error: null })
      expect((await resolveOnboardingCommunity('x@example.com')).community).toBe('professional')
    }
  })

  it('an absent email short-circuits to professional WITHOUT calling the RPC', async () => {
    for (const email of [null, undefined, '', '   ']) {
      expect(await resolveOnboardingCommunity(email))
        .toEqual({ community: 'professional', resolution: 'not_found' })
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it('calls the migration-099 resolver by name, with the address as its only argument', async () => {
    rpc.mockResolvedValue(resolved('next'))
    await resolveOnboardingCommunity('  Student@Example.com  ')
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('resolve_intended_member_type', { p_email: 'Student@Example.com' })
    // Trimmed only. Case folding is the RPC's job — lower(btrim(...)), byte-identical to migration
    // 078's resolvers — and doing it twice in two places is how two definitions of identity start.
  })
})

// ═══ 2. THE EMAIL IS SESSION-DERIVED ══════════════════════════════════════════════════════════
describe('2. the resolver can only ever be asked about the caller', () => {
  it('the onboarding page passes the VERIFIED session email, not input', () => {
    expect(ONBOARDING_PAGE).toMatch(/await resolveOnboardingCommunity\(user\.email\)/)
    // `user` on that page comes from supabase.auth.getUser(), and the page redirects when it is absent.
    expect(ONBOARDING_PAGE).toMatch(/const \{ data: \{ user \} \} = await supabase\.auth\.getUser\(\)/)
    expect(ONBOARDING_PAGE).toMatch(/if \(!user\) redirect\('\/login'\)/)
  })

  it('no request-supplied value can reach the resolver', () => {
    const call = ONBOARDING_PAGE.slice(ONBOARDING_PAGE.indexOf('resolveOnboardingCommunity('))
    expect(call.slice(0, 80)).not.toMatch(/searchParams|params|request|body|headers|cookies/)
  })

  it('the module documents the session-only contract it cannot itself enforce', () => {
    expect(CONTEXT_SRC).toMatch(/MUST come from `supabase\.auth\.getUser\(\)`/)
    expect(CONTEXT_SRC).toMatch(/never from a\s*\n? \* request body, query string, header, form field or client prop/)
  })
})

// ═══ 3. THE RESOLVER IS NOT REACHABLE FROM THE BROWSER ════════════════════════════════════════
describe('3. the service-role resolver stays server-side', () => {
  it('communityContext is not a client module and imports the admin client', () => {
    expect(CONTEXT_SRC).not.toMatch(/^'use client'/m)
    expect(CONTEXT_SRC).toMatch(/from '@\/lib\/supabase\/admin'/)
  })

  it('its only importer is a server component', () => {
    // The onboarding page has no 'use client' directive — it awaits at the top level, which a client
    // component cannot do, so this is structural rather than stylistic.
    expect(ONBOARDING_PAGE).not.toMatch(/^'use client'/m)
    expect(ONBOARDING_PAGE).toMatch(/export default async function OnboardingPage/)
  })

  it('NEITHER nav component imports it', () => {
    for (const src of [SIDEBAR, MOBILE_NAV]) {
      expect(src).not.toMatch(/communityContext|resolve_intended_member_type/)
    }
  })

  it('migration 099 grants the RPC to service_role ONLY', () => {
    const m099 = readFileSync('supabase/migrations/099_next_community_designation_foundation.sql', 'utf8')
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      expect(m099).toContain(`REVOKE ALL ON FUNCTION public.resolve_intended_member_type(text) FROM ${role}`)
    }
    expect(m099).toContain('GRANT EXECUTE ON FUNCTION public.resolve_intended_member_type(text) TO service_role')
  })
})

// ═══ 4. get_my_profile() IS NOT EXTENDED ══════════════════════════════════════════════════════
describe('4. the self-read RPC contract is untouched', () => {
  it('get_my_profile() still does not expose member_type', () => {
    const fn = MIGRATION_057.slice(
      MIGRATION_057.indexOf('CREATE OR REPLACE FUNCTION public.get_my_profile()'),
      MIGRATION_057.indexOf('REVOKE ALL ON FUNCTION public.get_my_profile()'),
    )
    expect(fn.length).toBeGreaterThan(100)
    expect(fn).not.toMatch(/member_type/)
  })

  it('no migration was added for this step — 100 is still the highest', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const numbers = readdirSync('supabase/migrations')
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .map((f) => Number(f.slice(0, 3)))
    expect(Math.max(...numbers)).toBe(100)
    // ...and the two this step depends on are the ones that already shipped.
    expect(numbers).toContain(99)
    expect(numbers).toContain(100)
  })
})

// ═══ 5. THE POST-PROFILE READ ═════════════════════════════════════════════════════════════════
describe('5. the dashboard resolves member_type from the authoritative self row', () => {
  it('member_type joins the EXISTING service_role self SELECT', () => {
    expect(LAYOUT).toMatch(
      /createAdminClient\(\)\.from\('profiles'\)\.select\('profile_complete, full_name, avatar_url, member_type'\)\.eq\('id', user\.id\)\.single\(\)/,
    )
  })

  it('the id it filters on comes from the verified session', () => {
    expect(LAYOUT).toMatch(/const user = await getAuthUser\(\)/)
    expect(LAYOUT).toMatch(/if \(!user\) redirect\('\/login'\)/)
  })

  it('it FAILS CLOSED to professional through communityOf, never a raw coercion', () => {
    expect(LAYOUT).toMatch(/const memberType = communityOf\(profile\) \?\? DEFAULT_MEMBER_TYPE/)
    // communityOf returns null for absent/null/unrecognised rather than defaulting — that is the
    // property being relied on here, and it is pinned in the community-foundation suite.
    const memberTypeSrc = readFileSync('lib/community/memberType.ts', 'utf8')
    expect(memberTypeSrc).toMatch(/return isMemberType\(raw\) \? raw : null/)
  })

  it('both nav components receive it', () => {
    expect(LAYOUT).toMatch(/<MobileNav[^>]*memberType=\{memberType\}/)
    expect(LAYOUT).toMatch(/memberType=\{memberType\}\s*\n\s*\/>/)
  })

  it('both accept it OPTIONALLY, defaulting to professional', () => {
    expect(SIDEBAR).toMatch(/memberType\?: MemberType/)
    expect(SIDEBAR).toMatch(/memberType = DEFAULT_MEMBER_TYPE,/)
    expect(MOBILE_NAV).toMatch(/memberType\?: MemberType/)
    expect(MOBILE_NAV).toMatch(/memberType = DEFAULT_MEMBER_TYPE/)
  })
})

// ═══ 6. STEP 1 CHANGES NOTHING A MEMBER CAN SEE ═══════════════════════════════════════════════
describe('6. no visible difference yet — this step is plumbing', () => {
  it('the nav item list is untouched and unconditional', () => {
    const items = SIDEBAR.slice(SIDEBAR.indexOf('const navItems = ['), SIDEBAR.indexOf('interface SidebarProps'))
    for (const label of ['Introductions', 'Opportunities', 'Network', 'Messages', 'Meetings', 'Profile', 'Billing', 'Settings']) {
      expect(items).toContain(label)
    }
    // No community branching in the list itself — that is Step 3.
    expect(items).not.toMatch(/memberType|next/)
  })

  it('NEITHER component reads the prop yet', () => {
    // Present in the signature, absent from the body: the value is plumbed, not consumed.
    const sidebarBody = SIDEBAR.slice(SIDEBAR.indexOf('const pathname = usePathname()'))
    expect(sidebarBody).not.toMatch(/memberType/)
    const navBody = MOBILE_NAV.slice(
      MOBILE_NAV.indexOf('memberType?: MemberType }) {') + 'memberType?: MemberType }) {'.length,
    )
    expect(navBody).not.toMatch(/memberType/)
  })

  it('the wordmark RENDERS the unconditional Andrel', () => {
    // The rendered text, not the file — a doc comment may name Andrel Next while the JSX does not.
    for (const src of [SIDEBAR, MOBILE_NAV]) {
      const jsx = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
      expect(jsx).toMatch(/>\s*Andrel\s*</)
      expect(jsx).not.toMatch(/Andrel Next/)
      expect(jsx).not.toMatch(/memberType === 'next'/)
    }
  })

  it('the onboarding form receives no community prop yet', () => {
    const render = ONBOARDING_PAGE.slice(ONBOARDING_PAGE.indexOf('return <OnboardingForm'))
    expect(render).not.toMatch(/community|memberType/)
  })

  it('the resolved value only reaches a log line in this step', () => {
    expect(ONBOARDING_PAGE).toMatch(/console\.log\('\[onboarding\] community context'/)
    // ...and that log carries no address.
    const log = ONBOARDING_PAGE.slice(ONBOARDING_PAGE.indexOf("'[onboarding] community context'"))
    expect(log.slice(0, 160)).not.toMatch(/user\.email|email/)
  })
})

// ═══ 7. THE PROP IS NOT AUTHORIZATION ═════════════════════════════════════════════════════════
describe('7. memberType as a prop is presentation context only', () => {
  it('both components say so where a future reader will look', () => {
    expect(SIDEBAR).toMatch(/PRESENTATION CONTEXT ONLY/)
    expect(MOBILE_NAV).toMatch(/PRESENTATION CONTEXT ONLY/)
  })

  it('the layout records that the closed surfaces gate themselves', () => {
    expect(LAYOUT).toMatch(/NEVER AUTHORIZATION/)
    expect(LAYOUT).toMatch(/performs its OWN service_role read/)
  })

  it('member_type remains unwritable from any member-facing path', () => {
    const actions = readFileSync('app/actions.ts', 'utf8')
    // Named only in the comment explaining why it is absent from the payload.
    expect(actions).not.toMatch(/member_type:/)
    const editForm = readFileSync('components/ProfileEditForm.tsx', 'utf8')
    expect(editForm).not.toMatch(/member_type/)
  })
})
