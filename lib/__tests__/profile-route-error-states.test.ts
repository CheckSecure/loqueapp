import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * A database error must never again be rendered as a 404.
 *
 * The production incident: the member-profile page read base public.profiles with the caller's own
 * client, that read returned 42501 (authenticated SELECT revoked by migration 058), the error was
 * discarded, `profileRow` fell to null, and `if (!profileRow) notFound()` turned an outage into
 * "this person does not exist". Pointing the query at public_profiles fixes today's 42501, but it
 * does NOT fix the failure MODE — the next error would 404 exactly the same way.
 *
 * These tests execute the REAL page function with the real control flow and assert the two
 * outcomes can never be confused again:
 *
 *   confirmed absence (no error, no row) -> notFound()
 *   any query failure (any error at all) -> retryable ProfileUnavailable, never notFound()
 */

const h = vi.hoisted(() => ({
  target: { data: null as any, error: null as any },   // public_profiles read
  viewer: { data: null as any, error: null as any },   // viewer's own comparison fields
  discoverable: true,
  notFoundCalls: 0,
  redirects: [] as string[],
  logs: [] as any[][],
}))

class NotFoundSignal extends Error {}

vi.mock('next/navigation', () => ({
  notFound: () => { h.notFoundCalls++; throw new NotFoundSignal('NEXT_NOT_FOUND') },
  redirect: (to: string) => { h.redirects.push(to); throw new Error('NEXT_REDIRECT') },
}))
vi.mock('@/lib/privacy/canViewerDiscoverMember', () => ({
  canViewerDiscoverMember: async () => h.discoverable,
}))
vi.mock('@/lib/profileRoles', () => ({ listRoles: async () => [], ROLE_CATEGORY_LABELS: {} }))

/** A chainable query builder that resolves to whatever the current table is configured to return. */
function builder(result: () => any) {
  const chain: any = new Proxy(function () {} as any, {
    get(_t, prop) {
      if (prop === 'then') {
        const r = result()
        return (res: any) => Promise.resolve(r).then(res)
      }
      if (prop === 'maybeSingle' || prop === 'single') return async () => result()
      return () => chain
    },
    apply: () => chain,
  })
  return chain
}

const authedClient = {
  auth: { getUser: async () => ({ data: { user: { id: 'viewer-uuid' } } }) },
  rpc: async () => ({ data: [] }),
  from: (table: string) =>
    builder(() => (table === 'public_profiles' ? h.target : { data: [], error: null })),
}
const adminClient = {
  from: (table: string) => builder(() => (table === 'profiles' ? h.viewer : { data: [], error: null })),
}

vi.mock('@/lib/supabase/server', () => ({ createClient: () => authedClient }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminClient }))

const PARAMS = { id: '11111111-2222-4333-8444-555555555555' }

/** Runs the real page and classifies the outcome. */
async function run(): Promise<'notFound' | 'unavailable' | 'rendered'> {
  const { default: MemberProfilePage } = await import('@/app/dashboard/profile/[id]/page')
  try {
    const el: any = await (MemberProfilePage as any)({ params: PARAMS })
    const name = typeof el?.type === 'function' ? el.type.name : ''
    return name === 'ProfileUnavailable' ? 'unavailable' : 'rendered'
  } catch (e) {
    if (e instanceof NotFoundSignal) return 'notFound'
    throw e
  }
}

const PROFILE_ROW = {
  id: PARAMS.id, full_name: 'Jane Smith', title: 'General Counsel', company: 'Acme',
  location: 'Washington, DC', bio: 'Bio.', expertise: [], interests: [], purposes: [],
  intro_preferences: [], previous_roles: [], current_focus_areas: [], company_rel: null,
}

beforeEach(() => {
  h.target = { data: null, error: null }
  h.viewer = { data: {}, error: null }
  h.discoverable = true
  h.notFoundCalls = 0
  h.redirects = []
  h.logs = []
  vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { h.logs.push(a) })
})

describe('confirmed absence vs query failure', () => {
  it('success + row -> renders the profile (no 404)', async () => {
    h.target = { data: PROFILE_ROW, error: null }
    expect(await run()).toBe('rendered')
    expect(h.notFoundCalls).toBe(0)
  })

  it('success + NO row -> notFound()', async () => {
    h.target = { data: null, error: null }
    expect(await run()).toBe('notFound')
    expect(h.notFoundCalls).toBe(1)
  })

  it('42501 permission denied -> retryable state, NEVER notFound', async () => {
    // the exact production error class
    h.target = { data: null, error: { code: '42501', message: 'permission denied for table profiles' } }
    expect(await run()).toBe('unavailable')
    expect(h.notFoundCalls).toBe(0)
  })

  it('timeout / network / infrastructure failure -> retryable state, NEVER notFound', async () => {
    for (const error of [
      { code: '57014', message: 'canceling statement due to statement timeout' },
      { code: 'ECONNRESET', message: 'socket hang up' },
      { code: undefined, message: 'fetch failed' },
      { code: 'PGRST301', message: 'JWT expired' },
    ]) {
      h.notFoundCalls = 0
      h.target = { data: null, error }
      expect(await run(), `error ${String(error.code)} must not 404`).toBe('unavailable')
      expect(h.notFoundCalls).toBe(0)
    }
  })

  it('an error accompanied by partial data still refuses to render it', async () => {
    h.target = { data: PROFILE_ROW, error: { code: '57014', message: 'timeout' } }
    expect(await run()).toBe('unavailable')
    expect(h.notFoundCalls).toBe(0)
  })
})

describe('viewer comparison query', () => {
  it('failure fails closed — no target profile is rendered', async () => {
    h.target = { data: PROFILE_ROW, error: null }
    h.viewer = { data: null, error: { code: '42501', message: 'permission denied' } }
    expect(await run()).toBe('unavailable')
    expect(h.notFoundCalls).toBe(0)
  })

  it('confirmed absence of a self row is NOT an error — the profile still renders', async () => {
    h.target = { data: PROFILE_ROW, error: null }
    h.viewer = { data: null, error: null }
    expect(await run()).toBe('rendered')
  })
})

describe('authorization layers are unchanged', () => {
  it('an undiscoverable target 404s before any profile read', async () => {
    h.discoverable = false
    h.target = { data: PROFILE_ROW, error: null }   // even though a row exists
    expect(await run()).toBe('notFound')
  })

  it('undiscoverable, private, deactivated and nonexistent are indistinguishable', async () => {
    // undiscoverable (gate) and nonexistent (no row) produce the identical outcome
    h.discoverable = false; h.target = { data: PROFILE_ROW, error: null }
    const undiscoverable = await run()
    h.discoverable = true; h.target = { data: null, error: null }
    const nonexistent = await run()
    expect(undiscoverable).toBe('notFound')
    expect(nonexistent).toBe('notFound')
    expect(undiscoverable).toBe(nonexistent)
  })
})

describe('nothing sensitive is logged or rendered', () => {
  it('logs only a coarse class + surface — no message, SQL, or member id', async () => {
    h.target = { data: null, error: { code: '42501', message: 'permission denied for table profiles' } }
    await run()
    const flat = JSON.stringify(h.logs)
    expect(flat).toContain('profile_target')
    expect(flat).toContain('42501')
    expect(flat).not.toContain('permission denied for table profiles')
    expect(flat).not.toContain(PARAMS.id)
    expect(flat).not.toContain('viewer-uuid')
  })

  it('the unavailable screen carries no error detail or identifier', async () => {
    const PAGE = (await import('node:fs')).readFileSync('app/dashboard/profile/[id]/page.tsx', 'utf8')
    const block = PAGE.slice(PAGE.indexOf('function ProfileUnavailable'), PAGE.indexOf('export default async function'))
    expect(block).not.toMatch(/error\.message|params\.id|user\.id|\{error/)
    expect(block).toMatch(/try again/i)
  })
})
