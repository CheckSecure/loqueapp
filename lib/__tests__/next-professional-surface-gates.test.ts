import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STEP 2 — CLOSING THE PROFESSIONAL SURFACES TO ANDREL NEXT.
 *
 * ─── THE POINT OF SHIPPING THIS BEFORE THE NAVIGATION CHANGES ─────────────────────────────────
 * The Opportunities and Billing links are still visible in the sidebar at this commit, deliberately.
 * If the refusal only worked because the link was hidden, it would not be a refusal — it would be a
 * layout. Every test below exercises the gate with the navigation untouched.
 *
 * ─── WHAT WAS ACTUALLY OPEN ───────────────────────────────────────────────────────────────────
 * Delivery was already community-scoped: lib/opportunities/matching.ts fails closed on an unknown
 * member_type, so a Next member's For You feed was empty. Empty is not closed. The page, the tier
 * copy, the create form and the create endpoint were all reachable by typing a URL.
 */

const OPP_PAGE = readFileSync('app/dashboard/opportunities/page.tsx', 'utf8')
const BILLING_LAYOUT = readFileSync('app/dashboard/billing/layout.tsx', 'utf8')
const BILLING_PAGE = readFileSync('app/dashboard/billing/page.tsx', 'utf8')
const CREATE = readFileSync('app/api/opportunities/create/route.ts', 'utf8')
const RESPOND = readFileSync('app/api/opportunities/respond/route.ts', 'utf8')
const VIEWER = readFileSync('lib/community/viewerCommunity.ts', 'utf8')
const SIDEBAR = readFileSync('components/Sidebar.tsx', 'utf8')

// ── Mocks. The gate's own logic runs for real; only the two clients are stubbed. ────────────────
let sessionUser: { id: string; email: string } | null = { id: 'u-1', email: 'm@example.com' }
let profileRow: any = { member_type: 'professional' }
let profileError: any = null
/** Every table the mocked admin client was asked for, in order. Proves what a refusal did NOT read. */
let tablesRead: string[] = []

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: sessionUser } }) } }),
}))

function chain(table: string): any {
  tablesRead.push(table)
  const self: any = {
    select: () => self, eq: () => self, in: () => self, is: () => self, insert: () => self,
    update: () => self, order: () => self, limit: () => self, single: async () => ({ data: null, error: null }),
    maybeSingle: async () =>
      table === 'profiles' ? { data: profileRow, error: profileError } : { data: null, error: null },
    then: (r: any) => r({ data: [], error: null }),
  }
  return self
}
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: chain, rpc: async () => ({ data: null, error: null }) }) }))

import { viewerCommunity, viewerIsNext, COMMUNITY_FORBIDDEN, COMMUNITY_FORBIDDEN_STATUS, NEXT_REDIRECT_TARGET } from '@/lib/community/viewerCommunity'

beforeEach(() => {
  sessionUser = { id: 'u-1', email: 'm@example.com' }
  profileRow = { member_type: 'professional' }
  profileError = null
  tablesRead = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

const post = (body: unknown) =>
  new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) })

// ═══ 1. THE AUTHORITATIVE RESOLVER ════════════════════════════════════════════════════════════
describe('1. the gate resolves the community from the caller\'s own row', () => {
  it('reads profiles through service_role, keyed on the id it was given', async () => {
    profileRow = { member_type: 'next' }
    expect(await viewerCommunity('u-1')).toBe('next')
    expect(tablesRead).toEqual(['profiles'])
    expect(VIEWER).toMatch(/\.from\('profiles'\)\s*\n\s*\.select\('member_type'\)\s*\n\s*\.eq\('id', userId\)/)
  })

  it('professional stays professional', async () => {
    profileRow = { member_type: 'professional' }
    expect(await viewerIsNext('u-1')).toBe(false)
  })

  it('an unrecognised, null or absent member_type is NOT next', async () => {
    for (const row of [{ member_type: 'student' }, { member_type: null }, {}, null]) {
      profileRow = row
      expect(await viewerIsNext('u-1')).toBe(false)
    }
  })

  it('viewerCommunity NORMALISES an unrecognised value — it never passes it through', async () => {
    // viewerIsNext alone cannot catch this: it only ever compares against 'next', so a raw
    // pass-through and a normalising read answer identically for every input. viewerCommunity is
    // exported and returns a MemberType, so a future caller could switch on it — an unrecognised
    // string escaping as if it were a community is the bug that would enable.
    for (const raw of ['student', 'NEXT', 'professsional', '', 'next ']) {
      profileRow = { member_type: raw }
      expect(await viewerCommunity('u-1')).toBe('professional')
    }
    // ...and the two values that ARE communities still come back verbatim.
    profileRow = { member_type: 'next' }
    expect(await viewerCommunity('u-1')).toBe('next')
    profileRow = { member_type: 'professional' }
    expect(await viewerCommunity('u-1')).toBe('professional')
  })

  it('a failed read falls back to professional, and logs a class only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    profileError = { code: '42501', message: 'permission denied for table profiles' }
    expect(await viewerCommunity('u-1')).toBe('professional')
    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).not.toMatch(/u-1|permission denied/)
  })

  it('the fallback direction is justified in the module, not left implicit', () => {
    expect(VIEWER).toMatch(/FAILS TO PROFESSIONAL/)
    expect(VIEWER).toMatch(/Availability of the Professional product wins/)
  })

  it('there is NO bypass argument, and none may be added', () => {
    expect(VIEWER).toMatch(/NOT a generic bypass/)
    // The signature takes an id and nothing else — no options object to smuggle a skip through.
    expect(VIEWER).toMatch(/export async function viewerCommunity\(userId: string\): Promise<MemberType>/)
    expect(VIEWER).toMatch(/export async function viewerIsNext\(userId: string\): Promise<boolean>/)
  })
})

// ═══ 2. THE PAGE GATES ════════════════════════════════════════════════════════════════════════
describe('2. Opportunities and Billing redirect a Next member server-side', () => {
  it('Opportunities gates on the session user id, before any product read', () => {
    expect(OPP_PAGE).toMatch(/if \(await viewerIsNext\(user\.id\)\) redirect\(NEXT_REDIRECT_TARGET\)/)
    // Ordering is the property: the gate must precede the tier read and the feed query, so a refused
    // caller's request touches no candidate rows and no creator names.
    expect(OPP_PAGE.indexOf('viewerIsNext(user.id)')).toBeLessThan(OPP_PAGE.indexOf("subscription_tier"))
    expect(OPP_PAGE.indexOf('viewerIsNext(user.id)')).toBeLessThan(OPP_PAGE.indexOf('opportunity_candidates'))
  })

  it('Opportunities takes its id from the verified session', () => {
    expect(OPP_PAGE).toMatch(/const \{ data: \{ user \} \} = await supabase\.auth\.getUser\(\)/)
    expect(OPP_PAGE).toMatch(/if \(!user\) redirect\('\/login'\)/)
  })

  it('Billing gates in a SERVER layout, because its page is a client component', () => {
    expect(BILLING_PAGE).toMatch(/^'use client'/m)   // ...so the page cannot gate itself
    expect(BILLING_LAYOUT).not.toMatch(/^'use client'/m)
    expect(BILLING_LAYOUT).toMatch(/export default async function BillingLayout/)
    expect(BILLING_LAYOUT).toMatch(/if \(await viewerIsNext\(user\.id\)\) redirect\(NEXT_REDIRECT_TARGET\)/)
    expect(BILLING_LAYOUT).toMatch(/const user = await getAuthUser\(\)/)
  })

  it('the redirect target is a surface both communities share', () => {
    expect(NEXT_REDIRECT_TARGET).toBe('/dashboard/introductions')
  })

  it('NEITHER gate consults the layout memberType prop', () => {
    for (const src of [OPP_PAGE, BILLING_LAYOUT]) {
      expect(src).not.toMatch(/props\.memberType|memberType=/)
    }
    expect(VIEWER).toMatch(/PRESENTATION CONTEXT/)
  })
})

// ═══ 3. THE API REFUSALS ══════════════════════════════════════════════════════════════════════
describe('3. create and respond refuse a Next member', () => {
  it('create: a Next caller gets 403 and NOTHING is inserted', async () => {
    profileRow = { member_type: 'next' }
    const { POST } = await import('@/app/api/opportunities/create/route')
    const res = await POST(post({ type: 'business', title: 'x'.repeat(12), criteria: {} }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(COMMUNITY_FORBIDDEN)
    expect(tablesRead).not.toContain('opportunities')
    expect(tablesRead).not.toContain('opportunity_candidates')
  })

  it('create: the refusal precedes body parsing, validation AND the eligibility check', () => {
    const gate = CREATE.indexOf('if (await viewerIsNext(user.id))')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(CREATE.indexOf('raw = await request.json()'))
    expect(gate).toBeLessThan(CREATE.indexOf('const check = validate(raw)'))
    expect(gate).toBeLessThan(CREATE.indexOf('checkCreatorEligibility(user.id)'))
  })

  it('respond: the refusal precedes body parsing and the opportunity read', () => {
    const gate = RESPOND.indexOf('if (await viewerIsNext(user.id))')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(RESPOND.indexOf('body = await request.json()'))
    expect(gate).toBeLessThan(RESPOND.indexOf(".from('opportunities')"))
  })

  it('a Next caller is refused even with an UNPARSEABLE body — no 400 leaks first', async () => {
    profileRow = { member_type: 'next' }
    const { POST } = await import('@/app/api/opportunities/create/route')
    const res = await POST(new Request('http://localhost/api', { method: 'POST', body: 'not json' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(COMMUNITY_FORBIDDEN)
  })

  it('respond: a Next caller gets 403 and the opportunity is never read', async () => {
    profileRow = { member_type: 'next' }
    const { POST } = await import('@/app/api/opportunities/respond/route')
    const res = await POST(post({ opportunity_id: 'opp-1' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(COMMUNITY_FORBIDDEN)
    // No 404/410 distinction leaks, because the row was never fetched.
    expect(tablesRead).not.toContain('opportunities')
    expect(tablesRead).not.toContain('credit_transactions')
    expect(tablesRead).not.toContain('opportunity_responses')
  })

  it('the refusal body names no opportunity, member, reason or community', () => {
    const text = JSON.stringify(COMMUNITY_FORBIDDEN)
    expect(text).not.toMatch(/next|community|student|andrel|opportunit/i)
    expect(COMMUNITY_FORBIDDEN_STATUS).toBe(403)
  })

  it('a request-supplied member_type CANNOT influence the outcome', async () => {
    // The caller is a real Next member who claims otherwise in the body. The body is not consulted.
    profileRow = { member_type: 'next' }
    const { POST } = await import('@/app/api/opportunities/create/route')
    const res = await POST(post({
      type: 'business', title: 'x'.repeat(12), criteria: {},
      member_type: 'professional', memberType: 'professional', community: 'professional',
    }))
    expect(res.status).toBe(403)
    // ...and structurally: neither handler reads a community from anything but the resolver.
    for (const src of [CREATE, RESPOND]) {
      expect(src).not.toMatch(/body\.member_type|body\.memberType|body\.community/)
      expect(src).not.toMatch(/headers\.get\(['"]x-member-type/i)
    }
  })

  it('an unauthenticated caller is still 401, before any community read', async () => {
    sessionUser = null
    const { POST } = await import('@/app/api/opportunities/create/route')
    const res = await POST(post({}))
    expect(res.status).toBe(401)
    expect(tablesRead).toEqual([])
  })
})

// ═══ 4. PROFESSIONAL BEHAVIOUR IS UNCHANGED ═══════════════════════════════════════════════════
describe('4. a professional sees no difference at all', () => {
  it('create: a professional passes the gate and reaches the existing payload validation', async () => {
    profileRow = { member_type: 'professional' }
    const { POST } = await import('@/app/api/opportunities/create/route')
    const res = await POST(post({ type: 'business', title: 'x'.repeat(12), criteria: {} }))
    const body = await res.json()
    // The community gate did NOT fire — the request reached the pre-existing validator, which is the
    // first thing past it. Same answer this payload got before Step 2 existed.
    expect(body).not.toEqual(COMMUNITY_FORBIDDEN)
    expect(body.error).toBe('validation_failed')
    expect(res.status).toBe(400)
  })

  it('create: an UNPARSEABLE body from a professional still gets the original 400', async () => {
    profileRow = { member_type: 'professional' }
    const { POST } = await import('@/app/api/opportunities/create/route')
    const res = await POST(new Request('http://localhost/api', { method: 'POST', body: 'not json' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid JSON.' })
  })

  it('respond: a professional passes the gate and reaches the opportunity read', async () => {
    profileRow = { member_type: 'professional' }
    const { POST } = await import('@/app/api/opportunities/respond/route')
    const res = await POST(post({ opportunity_id: 'opp-1' }))
    expect(await res.json()).not.toEqual(COMMUNITY_FORBIDDEN)
    expect(tablesRead).toContain('opportunities')
  })

  it('every pre-existing authorization check survives, byte for byte', () => {
    // create
    expect(CREATE).toMatch(/const elig = await checkCreatorEligibility\(user\.id\);/)
    expect(CREATE).toMatch(/if \(!user\) return NextResponse\.json\(\{ error: 'Unauthorized' \}, \{ status: 401 \}\);/)
    // respond — candidacy, ownership, status, expiry and both caps are untouched
    expect(RESPOND).toMatch(/if \(!candidate\) \{/)
    expect(RESPOND).toMatch(/Cannot respond to your own opportunity\./)
    expect(RESPOND).toMatch(/This opportunity is no longer open\./)
    expect(RESPOND).toMatch(/This opportunity has expired\./)
    expect(RESPOND).toMatch(/Responses closed\./)
    expect(RESPOND).toMatch(/weekly recruiter response limit/)
  })

  it('the Billing PAGE itself is untouched — the gate is additive', () => {
    expect(BILLING_PAGE).toMatch(/const TIERS = \[/)
    expect(BILLING_PAGE).not.toMatch(/viewerIsNext|member_type|memberType/)
  })

  it('the Opportunities page keeps its existing tier and feed behaviour', () => {
    expect(OPP_PAGE).toMatch(/const effectiveTier = getEffectiveTier\(profile \|\| \{\}\) as Tier;/)
    expect(OPP_PAGE).toMatch(/\.from\('opportunity_candidates'\)/)
  })
})

// ═══ 5. PRESENTATION IS DELIBERATELY UNCHANGED ════════════════════════════════════════════════
describe('5. the refusal works with the navigation still showing both links', () => {
  it('Opportunities and Billing are still in the sidebar', () => {
    const items = SIDEBAR.slice(SIDEBAR.indexOf('const navItems = ['), SIDEBAR.indexOf('interface SidebarProps'))
    expect(items).toContain('Opportunities')
    expect(items).toContain('Billing')
    expect(items).not.toMatch(/memberType/)
  })
})

// ═══ 6. NOTHING BELOW THE UI WAS WEAKENED ═════════════════════════════════════════════════════
describe('6. the existing community protections are intact', () => {
  it('candidate pools are still community-scoped and still fail closed', () => {
    const matching = readFileSync('lib/opportunities/matching.ts', 'utf8')
    expect(matching).toMatch(/null\/unknown member_type yields an EMPTY pool \(fail closed\)/)
    expect(matching).toMatch(/filterSameCommunity/)
  })

  it('connect still refuses a cross-community pair', () => {
    const connect = readFileSync('lib/opportunities/connect.ts', 'utf8')
    expect(connect).toMatch(/cross_community/)
    expect(connect).toMatch(/not_creator/)
  })

  it('the in-memory community helpers are unchanged', () => {
    const memberType = readFileSync('lib/community/memberType.ts', 'utf8')
    expect(memberType).toMatch(/export function sameCommunity/)
    expect(memberType).toMatch(/export function filterSameCommunity/)
    expect(memberType).toMatch(/export function partitionByCommunity/)
    expect(memberType).toMatch(/return isMemberType\(raw\) \? raw : null/)
  })

  it('no migration was added — 100 is still the highest', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const numbers = readdirSync('supabase/migrations')
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .map((f) => Number(f.slice(0, 3)))
    expect(Math.max(...numbers)).toBe(100)
  })

  it('completeOnboarding is untouched by this step', () => {
    const actions = readFileSync('app/actions.ts', 'utf8')
    expect(actions).not.toMatch(/viewerIsNext|viewerCommunity|resolveOnboardingCommunity/)
    expect(actions).not.toMatch(/member_type:/)
  })
})

// ═══ 7. THE SIX ENDPOINTS LEFT ALONE, AND WHY ═════════════════════════════════════════════════
//
// These are assertions about the EXISTING authorization that makes a new refusal unnecessary. They
// exist so that if any of those checks is ever removed, this suite fails and the reasoning is
// re-examined rather than silently invalidated.
describe('7. the endpoints deliberately left unchanged are structurally unreachable', () => {
  it.each(['close', 'archive', 'decline-response'])('%s refuses a non-creator with 403', (name) => {
    const src = readFileSync(`app/api/opportunities/${name}/route.ts`, 'utf8')
    expect(src).toMatch(/creator_id !== user\.id/)
    expect(src).toMatch(/status: 403/)
    // A Next member can never be a creator, because create refuses them above.
    expect(src).not.toMatch(/viewerIsNext/)
  })

  it('touch is creator-scoped too, but answers 200 and writes nothing', () => {
    const src = readFileSync('app/api/opportunities/touch/route.ts', 'utf8')
    // A deliberate silent no-op rather than a 403: touch is a visit ping, and a 403 would reveal
    // whether the addressed opportunity exists. The property that matters is the same — a non-creator
    // reaches no write — and it holds for a Next member for the same reason as the other three.
    expect(src).toMatch(/if \(!opp \|\| opp\.creator_id !== user\.id\) \{\s*\n\s*return NextResponse\.json\(\{ ok: true \}, \{ status: 200 \}\);/)
    expect(src.indexOf('creator_id !== user.id')).toBeLessThan(src.indexOf(".update("))
    expect(src).not.toMatch(/viewerIsNext/)
  })

  it('introduce is creator-scoped AND already carries a community refusal', () => {
    const route = readFileSync('app/api/opportunities/introduce/route.ts', 'utf8')
    const connect = readFileSync('lib/opportunities/connect.ts', 'utf8')
    // Ownership is enforced inside connectOpportunityResponder, which the route surfaces as 403.
    expect(route).toMatch(/creatorId: user\.id/)
    expect(route).toMatch(/result\.code === 'not_creator' \? 403/)
    // ...and a cross-community responder is refused there too, with a message that names no community.
    expect(connect).toMatch(/code: 'cross_community'/)
    expect(route).toMatch(/This member is not available to connect right now\./)
  })

  it('dismiss can only ever touch the caller\'s own candidate row', () => {
    const src = readFileSync('app/api/opportunities/dismiss/route.ts', 'utf8')
    // Row-scoped UPDATE: for a Next member, who has no candidacies, it matches zero rows.
    expect(src).toMatch(/\.from\('opportunity_candidates'\)/)
    expect(src).toMatch(/\.eq\('user_id', user\.id\)/)
    expect(src).toMatch(/\.is\('dismissed_at', null\)/)
    // It writes only dismissed_at, so the worst case is a member hiding a card from their own feed.
    expect(src).toMatch(/\.update\(\{ dismissed_at: new Date\(\)\.toISOString\(\) \}\)/)
  })

  it('there are exactly eight opportunity endpoints, and two now carry a community refusal', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const dirs = readdirSync('app/api/opportunities').sort()
    expect(dirs).toEqual([
      'archive', 'close', 'create', 'decline-response', 'dismiss', 'introduce', 'respond', 'touch',
    ])
    const gated = dirs.filter((d) =>
      readFileSync(`app/api/opportunities/${d}/route.ts`, 'utf8').includes('viewerIsNext'))
    expect(gated).toEqual(['create', 'respond'])
  })
})
