import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { memberProfileHref, isMemberProfileId, MEMBER_PROFILE_BASE } from '@/lib/profiles/profileHref'
import { PUBLIC_PROFILE_COLUMNS, FORBIDDEN_PUBLIC_PROFILE_FIELDS } from '@/lib/profiles/publicProfile'

/**
 * Messages → participant profile returned a 404 in production, on desktop and mobile.
 *
 * ROOT CAUSE (not the link). The href was already correct. The DESTINATION page,
 * app/dashboard/profile/[id]/page.tsx, read the member's row from the BASE public.profiles table
 * with the caller's own client. Authenticated SELECT on that table is revoked (migration 058), so
 * the read returned 42501 for every viewer, `profileRow` fell to null, and the page's
 * `if (!profileRow) notFound()` converted that permission error into a 404 for EVERY member
 * profile — from Messages, Introductions, incoming-interest cards and the company page alike.
 * Network was unaffected only because its "View" opens a modal instead of navigating.
 *
 * The fix reads through `public_profiles` — the discovery-scoped view migration 057 created for
 * member-facing reads, granted to authenticated — and leaves the authorization gate untouched.
 */

const PROFILE_PAGE = readFileSync('app/dashboard/profile/[id]/page.tsx', 'utf8')
const MESSAGES_PAGE = readFileSync('app/dashboard/messages/[conversationId]/page.tsx', 'utf8')

const UUID_A = '11111111-2222-4333-8444-555555555555'
const UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

describe('the member-profile route actually exists and is what we link to', () => {
  it('the dynamic route file is present at the path the builder produces', () => {
    expect(existsSync('app/dashboard/profile/[id]/page.tsx')).toBe(true)
    expect(MEMBER_PROFILE_BASE).toBe('/dashboard/profile')
    expect(memberProfileHref(UUID_A)).toBe(`/dashboard/profile/${UUID_A}`)
  })

  it('its dynamic parameter is the member id', () => {
    expect(PROFILE_PAGE).toMatch(/params\s*}:\s*\{\s*params:\s*\{\s*id:\s*string/)
    expect(PROFILE_PAGE).toMatch(/\.eq\('id', params\.id\)/)
  })
})

describe('canonical link builder', () => {
  it('accepts only a profile UUID', () => {
    expect(isMemberProfileId(UUID_A)).toBe(true)
    for (const bad of ['', ' ', 'undefined', 'null', 'abc', 42, null, undefined, {}, 'me@example.com']) {
      expect(isMemberProfileId(bad as any)).toBe(false)
    }
  })

  it('returns null — never a fabricated URL — for absent or malformed ids', () => {
    for (const bad of [undefined, null, '', 'undefined', 'not-a-uuid']) {
      expect(memberProfileHref(bad as any)).toBeNull()
    }
    // the exact production failure shape a hand-built template literal would have produced
    expect(`/dashboard/profile/${undefined}`).toBe('/dashboard/profile/undefined')
    expect(memberProfileHref(undefined)).not.toBe('/dashboard/profile/undefined')
  })

  it('never puts an email, name or other private/unstable value in the URL', () => {
    for (const v of ['jane@example.com', 'Jane Smith', 'conversation-123', 'General Counsel']) {
      expect(memberProfileHref(v as any)).toBeNull()
    }
  })

  it('resolves self to the own-profile page, matching the route\'s own redirect', () => {
    expect(memberProfileHref(UUID_A, UUID_A)).toBe('/dashboard/profile')
    expect(PROFILE_PAGE).toMatch(/params\.id === user\.id\) redirect\('\/dashboard\/profile'\)/)
  })

  it('does not confuse two different participants', () => {
    expect(memberProfileHref(UUID_A, UUID_B)).toBe(`/dashboard/profile/${UUID_A}`)
  })

  it('escapes the identifier', () => {
    expect(memberProfileHref(UUID_A)).toBe(`/dashboard/profile/${encodeURIComponent(UUID_A)}`)
  })
})

describe('the destination page loads through a path the viewer may actually read', () => {
  it('reads the member row from the discovery-scoped view, not the revoked base table', () => {
    const read = PROFILE_PAGE.slice(PROFILE_PAGE.indexOf('const { data: profileRow'), PROFILE_PAGE.indexOf('if (!profileRow) notFound()'))
    expect(read).toMatch(/\.from\('public_profiles'\)/)
    expect(read).not.toMatch(/\.from\('profiles'\)/)
  })

  it('selects only safe, member-facing columns', () => {
    for (const forbidden of FORBIDDEN_PUBLIC_PROFILE_FIELDS) {
      // the projection constant must not carry any private field
      expect((PUBLIC_PROFILE_COLUMNS as readonly string[]).includes(forbidden)).toBe(false)
    }
    expect((PUBLIC_PROFILE_COLUMNS as readonly string[]).includes('email')).toBe(false)
  })

  it('keeps the authorization gate ahead of any profile read, unchanged', () => {
    const gate = PROFILE_PAGE.indexOf('canViewerDiscoverMember')
    const read = PROFILE_PAGE.indexOf("from('public_profiles')")
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(read)              // gate runs first
    expect(PROFILE_PAGE).toMatch(/canViewerDiscoverMember\(admin, user\.id, params\.id\)\)\) notFound\(\)/)
  })

  it('stays fail-closed: undiscoverable or missing members still 404 without revealing existence', () => {
    expect((PROFILE_PAGE.match(/notFound\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(PROFILE_PAGE).not.toMatch(/access denied|not authorized|deactivated account/i)
  })

  it('reads the viewer\'s OWN comparison fields via service_role, scoped to their own id', () => {
    const own = PROFILE_PAGE.slice(PROFILE_PAGE.indexOf('viewerProfile'), PROFILE_PAGE.indexOf('viewerProfile') + 420)
    expect(own).toMatch(/admin\s*\n?\s*\.from\('profiles'\)/)
    expect(own).toMatch(/\.eq\('id', user\.id\)/)
  })
})

describe('Messages conversation header (one component serves desktop and mobile)', () => {
  it('builds its href through the canonical builder, not a template literal', () => {
    expect(MESSAGES_PAGE).toMatch(/memberProfileHref\(conversation\.otherUser\?\.id\)/)
    expect(MESSAGES_PAGE).not.toMatch(/href=\{`\/dashboard\/profile\/\$\{conversation\.otherUser\.id\}`\}/)
  })

  it('produces exactly the same href shape the rest of the app uses', () => {
    // introductions links the same route for the same kind of member
    const INTROS = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
    expect(INTROS).toMatch(/\/dashboard\/profile\/\$\{targetId\}/)
    expect(memberProfileHref(UUID_A)).toBe(`/dashboard/profile/${UUID_A}`)
  })

  it('degrades to non-interactive text when no safe href exists', () => {
    expect(MESSAGES_PAGE).toMatch(/function ProfileHeaderLink/)
    expect(MESSAGES_PAGE).toMatch(/if \(!href\) return <div className=\{className\}>\{children\}<\/div>/)
  })

  it('keeps real link semantics when the href is valid', () => {
    const wrapper = MESSAGES_PAGE.slice(MESSAGES_PAGE.indexOf('function ProfileHeaderLink'), MESSAGES_PAGE.indexOf('function ProfileHeaderLink') + 600)
    expect(wrapper).toMatch(/<Link href=\{href\}/)   // normal nav, new tab, back button, focus
  })

  it('still renders the deactivated participant as non-linked "Former member"', () => {
    expect(MESSAGES_PAGE).toMatch(/account_status === 'deactivated'/)
    const deactivated = MESSAGES_PAGE.slice(MESSAGES_PAGE.indexOf("account_status === 'deactivated'"), MESSAGES_PAGE.indexOf('ProfileHeaderLink href'))
    expect(deactivated).not.toMatch(/<Link/)
  })

  it('puts no email or private field in the header href', () => {
    const header = MESSAGES_PAGE.slice(MESSAGES_PAGE.indexOf('ProfileHeaderLink href'), MESSAGES_PAGE.indexOf('ProfileHeaderLink href') + 300)
    for (const f of ['email', 'account_status', 'stripe', 'subscription_tier']) expect(header).not.toContain(f)
  })
})

describe('Network is unaffected', () => {
  const CARD = readFileSync('components/NetworkCard.tsx', 'utf8')
  it('still opens its detail modal rather than navigating', () => {
    expect(CARD).toMatch(/setModalOpen\(true\)/)
    expect(CARD).toMatch(/<ConnectionDetailModal/)
  })
  it('keeps Message, Schedule and View actions', () => {
    for (const label of ['Message', 'Schedule', 'View']) expect(CARD).toContain(label)
    expect(CARD).toMatch(/dashboard\/meetings\?schedule=1&with=\$\{profile\.id\}/)
  })
  it('keeps its mobile overflow protections', () => {
    expect(CARD).toMatch(/flex flex-wrap gap-2/)
    expect((CARD.match(/min-h-\[44px\]/g) ?? []).length).toBe(3)
    expect(CARD).toMatch(/break-words sm:truncate/)
  })
})
