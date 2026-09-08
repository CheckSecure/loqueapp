import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

/**
 * PHASE 3 STAGE 1b — every relationship writer goes through the gated primitive.
 *
 * Stage 1a put the community boundary inside the SQL that writes. Stage 1b is the half that makes
 * that reachable: the flows which used to INSERT a `matches` row directly from TypeScript as
 * service_role now call public.create_gated_match, and the two platform/support flows call
 * public.create_support_match.
 *
 * WHY BEHAVIOURAL TESTS AND NOT ONLY STRUCTURAL ONES. A grep proving "the file mentions the RPC"
 * would pass just as happily on a file that calls the RPC, ignores the outcome, and then notifies
 * both members anyway. The tests below drive the real functions with a mocked client and assert
 * what they DID: what was written, what was not written, and — the part that matters most — that a
 * refusal produces silence rather than a half-finished connection.
 */

// ── one programmable fake for the whole suite ──────────────────────────────────────────────────
const h = vi.hoisted(() => {
  const state = {
    rpc: [] as { name: string; args: any }[],
    rpcReply: new Map<string, any>(),
    writes: [] as { table: string; op: string; payload: any }[],
    tableReplies: new Map<string, any>(),
    notifications: [] as any[],
    emails: [] as any[],
  }

  const reset = () => {
    state.rpc.length = 0
    state.writes.length = 0
    state.notifications.length = 0
    state.emails.length = 0
    state.rpcReply.clear()
    state.tableReplies.clear()
  }

  // A chainable PostgREST-shaped stub. Reads resolve from `tableReplies`; writes are recorded.
  const makeClient = () => ({
    rpc: async (name: string, args: any) => {
      state.rpc.push({ name, args })
      const reply = state.rpcReply.get(name)
      if (reply === undefined) return { data: null, error: { code: 'NO_STUB' } }
      return reply
    },
    from(table: string) {
      const q: any = {
        _table: table,
        select: () => q, eq: () => q, in: () => q, or: () => q, is: () => q,
        order: () => q, limit: () => q, not: () => q, range: () => q,
        insert: (payload: any) => { state.writes.push({ table, op: 'insert', payload }); return q },
        update: (payload: any) => { state.writes.push({ table, op: 'update', payload }); return q },
        delete: () => { state.writes.push({ table, op: 'delete', payload: null }); return q },
        single: async () => q._resolve(),
        maybeSingle: async () => q._resolve(),
        then: (res: any, rej: any) => q._resolve().then(res, rej),
        _resolve: async () => state.tableReplies.get(table) ?? { data: null, error: null },
      }
      return q
    },
    auth: { getUser: async () => ({ data: { user: { id: 'viewer', email: 'v@x.com' } } }) },
  })

  return { state, reset, makeClient }
})

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.makeClient() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => h.makeClient() }))
vi.mock('@/lib/notifications', () => ({
  createNotificationSafe: async (n: any) => { h.state.notifications.push(n) },
}))
vi.mock('@/lib/email', () => ({
  sendMatchCreatedEmail: async (...a: any[]) => { h.state.emails.push(a) },
  sendMeetingRequestEmail: async () => {}, sendMeetingAcceptedEmail: async () => {},
  sendMeetingDeclinedEmail: async () => {}, sendMeetingRescheduledEmail: async () => {},
  sendAdminAlertEmail: async () => {}, sendWaitlistConfirmationEmail: async () => {},
  escapeHtml: (s: string) => s,
}))
vi.mock('@/lib/referrals/exclusions', () => ({ getReferralExclusionsForUser: async () => new Set() }))
vi.mock('@/lib/messaging/icebreakers', () => ({
  generateIcebreakers: () => ['q1'], generateSystemIntroMessage: () => 'intro',
}))
vi.mock('@/lib/profiles/serverProfile', async (orig) => {
  const real = await (orig() as any)
  return {
    ...real,
    // Only the pair gate's own read is stubbed per-test; everything else returns an empty list,
    // which is a legitimate "no participant profiles" answer the callers already handle.
    readProfilesByIds: async (ids: string[], cols: string) =>
      cols.includes('member_type')
        ? (h.state.tableReplies.get('__community__') ?? { ok: true, profiles: [] })
        : { ok: true, profiles: [] },
    readProfileById: async () => ({ ok: false, reason: 'not_found' }),
  }
})

const CREATOR = '11111111-1111-4111-8111-111111111111'
const RESPONDER = '22222222-2222-4222-8222-222222222222'

const communityRows = (rows: Array<{ id: string; member_type: string | null }>) =>
  h.state.tableReplies.set('__community__', { ok: true, profiles: rows })

beforeEach(() => { h.reset(); vi.resetModules() })

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('create_gated_match is the only way these flows write a match', () => {
  const DIRECT_INSERT = /\.from\(\s*['"]matches['"]\s*\)[\s\S]{0,200}?\.insert\(/

  it('no production file INSERTs into matches any more', () => {
    const files = [
      'app/actions.ts',
      'app/api/admin/facilitate-intro/route.ts',
      'lib/opportunities/connect.ts',
      'lib/onboarding/welcomeFromAdmin.ts',
      'app/api/admin/issues/[id]/reply/route.ts',
    ]
    for (const f of files) {
      expect(readFileSync(f, 'utf8'), `${f} still INSERTs into matches`).not.toMatch(DIRECT_INSERT)
    }
  })

  it('no direct-INSERT fallback was left behind for a failed RPC', () => {
    // The specific failure mode this guards: "call the RPC, and if it refuses, do it the old way."
    for (const f of ['app/actions.ts', 'lib/opportunities/connect.ts',
                     'app/api/admin/facilitate-intro/route.ts']) {
      const src = readFileSync(f, 'utf8')
      expect(src).not.toMatch(/fallback[\s\S]{0,80}matches/i)
    }
  })

  it('the RPC client refuses to report an unrecognised outcome as success', async () => {
    const { createGatedMatch, isConnected } = await import('@/lib/relationships/gatedMatch')
    h.state.rpcReply.set('create_gated_match', { data: { outcome: 'something_new' }, error: null })
    const r = await createGatedMatch(h.makeClient(), CREATOR, RESPONDER)
    expect(r.outcome).toBe('error')
    expect(isConnected(r.outcome)).toBe(false)
  })

  it('a transport error is an error, never a silent success', async () => {
    const { createGatedMatch } = await import('@/lib/relationships/gatedMatch')
    h.state.rpcReply.set('create_gated_match', { data: null, error: { code: '57014' } })
    expect((await createGatedMatch(h.makeClient(), CREATOR, RESPONDER)).outcome).toBe('error')
  })

  it('a self-pair is refused client-side, before the RPC is called', async () => {
    const { createGatedMatch } = await import('@/lib/relationships/gatedMatch')
    const r = await createGatedMatch(h.makeClient(), CREATOR, CREATOR)
    expect(r.outcome).toBe('invalid')
    expect(h.state.rpc).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('opportunity connect — Professional↔Professional keeps every existing semantic', () => {
  const arrange = () => {
    h.state.tableReplies.set('opportunities', { data: { id: 'opp1', creator_id: CREATOR, status: 'active' }, error: null })
    h.state.tableReplies.set('opportunity_responses', { data: { id: 'resp1', status: 'interested' }, error: null })
    h.state.tableReplies.set('blocked_users', { data: [], error: null })
    h.state.tableReplies.set('profiles', { data: [
      { id: CREATOR, account_status: 'active' }, { id: RESPONDER, account_status: 'active' }], error: null })
    h.state.tableReplies.set('matches', { data: [], error: null })
    h.state.tableReplies.set('intro_requests', { data: [], error: null })
    h.state.tableReplies.set('conversations', { data: null, error: null })
    h.state.tableReplies.set('messages', { data: null, error: null })
  }

  it('succeeds, and every opportunity column survives the move to the RPC', async () => {
    arrange()
    h.state.rpcReply.set('create_gated_match', {
      data: { outcome: 'created', match_id: 'm1', conversation_id: 'c1' }, error: null,
    })
    const { connectOpportunityResponder } = await import('@/lib/opportunities/connect')
    const res = await connectOpportunityResponder({ opportunityId: 'opp1', creatorId: CREATOR, responderId: RESPONDER })

    expect(res).toMatchObject({ ok: true, match_id: 'm1', conversation_id: 'c1' })

    const call = h.state.rpc.find((r) => r.name === 'create_gated_match')
    expect(call).toBeDefined()
    // THE REGRESSION THIS TEST EXISTS FOR: caps.ts and rateLimits.ts read these four columns. A
    // conversion that dropped them would look fine and silently break delivery caps.
    expect(call!.args.p_is_opportunity_initiated).toBe(true)
    expect(call!.args.p_opportunity_id).toBe('opp1')
    expect(call!.args.p_admin_notes).toBe('opportunity_opp1')
    expect(call!.args.p_matched_at).toEqual(expect.any(String))
    expect(call!.args.p_status).toBe('active')
    expect(call!.args.p_admin_facilitated).toBe(false)
    expect(call!.args.p_suggested_prompts).toEqual([])
  })

  it('still sends the system message, both notifications and both emails', async () => {
    arrange()
    h.state.rpcReply.set('create_gated_match', {
      data: { outcome: 'created', match_id: 'm1', conversation_id: 'c1' }, error: null,
    })
    const { connectOpportunityResponder } = await import('@/lib/opportunities/connect')
    await connectOpportunityResponder({ opportunityId: 'opp1', creatorId: CREATOR, responderId: RESPONDER })

    expect(h.state.writes.filter((w) => w.table === 'messages' && w.op === 'insert')).toHaveLength(1)
    expect(h.state.notifications).toHaveLength(2)
    expect(h.state.notifications.every((n) => n.type === 'mutual_match')).toBe(true)
    expect(h.state.notifications.every((n) => n.link === '/dashboard/messages/c1')).toBe(true)
    // The opportunity response is still marked introduced.
    expect(h.state.writes.some((w) => w.table === 'opportunity_responses' && w.payload?.status === 'introduced')).toBe(true)
  })

  it('spends NO credits — no meeting_credits or credit_transactions write, ever', async () => {
    arrange()
    h.state.rpcReply.set('create_gated_match', {
      data: { outcome: 'created', match_id: 'm1', conversation_id: 'c1' }, error: null,
    })
    const { connectOpportunityResponder } = await import('@/lib/opportunities/connect')
    await connectOpportunityResponder({ opportunityId: 'opp1', creatorId: CREATOR, responderId: RESPONDER })

    expect(h.state.writes.filter((w) => ['meeting_credits', 'credit_transactions'].includes(w.table))).toEqual([])
    // And it is create_gated_match, not the credit-charging finalizer.
    expect(h.state.rpc.map((r) => r.name)).not.toContain('finalize_mutual_match_atomic')
    expect(h.state.rpc.map((r) => r.name)).not.toContain('consume_credits_and_create_match')
  })

  it('a cross-community refusal writes NOTHING and notifies nobody', async () => {
    arrange()
    h.state.rpcReply.set('create_gated_match', {
      data: { outcome: 'ineligible', detail: 'cross_community' }, error: null,
    })
    const { connectOpportunityResponder } = await import('@/lib/opportunities/connect')
    const res = await connectOpportunityResponder({ opportunityId: 'opp1', creatorId: CREATOR, responderId: RESPONDER })

    expect(res).toMatchObject({ ok: false, code: 'cross_community' })
    // The whole point: refusing at the write must not leave the side effects behind.
    expect(h.state.writes.filter((w) => w.table === 'messages')).toEqual([])
    expect(h.state.writes.filter((w) => w.table === 'opportunity_responses')).toEqual([])
    expect(h.state.notifications).toEqual([])
    expect(h.state.emails).toEqual([])
  })

  it('an unrecognised/transport failure also fails closed', async () => {
    arrange()
    h.state.rpcReply.set('create_gated_match', { data: null, error: { code: 'PGRST301' } })
    const { connectOpportunityResponder } = await import('@/lib/opportunities/connect')
    const res = await connectOpportunityResponder({ opportunityId: 'opp1', creatorId: CREATOR, responderId: RESPONDER })

    expect(res).toMatchObject({ ok: false, code: 'internal' })
    expect(h.state.notifications).toEqual([])
    expect(h.state.emails).toEqual([])
  })

  it('the pending-intro refusal still fires BEFORE any write', async () => {
    arrange()
    h.state.tableReplies.set('intro_requests', { data: [{ id: 'i1', status: 'pending' }], error: null })
    const { connectOpportunityResponder } = await import('@/lib/opportunities/connect')
    const res = await connectOpportunityResponder({ opportunityId: 'opp1', creatorId: CREATOR, responderId: RESPONDER })

    expect(res).toMatchObject({ ok: false, code: 'intro_pending' })
    expect(h.state.rpc).toEqual([])   // the RPC was never reached
  })

  it('already_connected still fires before any write', async () => {
    arrange()
    h.state.tableReplies.set('matches', { data: [{ id: 'm0', status: 'active', removed_at: null }], error: null })
    const { connectOpportunityResponder } = await import('@/lib/opportunities/connect')
    const res = await connectOpportunityResponder({ opportunityId: 'opp1', creatorId: CREATOR, responderId: RESPONDER })
    expect(res).toMatchObject({ ok: false, code: 'already_connected' })
    expect(h.state.rpc).toEqual([])
  })

  it('the 180-day cooldown still fires before any write', async () => {
    arrange()
    h.state.tableReplies.set('matches', {
      data: [{ id: 'm0', status: 'removed', removed_at: new Date(Date.now() - 10 * 86400_000).toISOString() }],
      error: null,
    })
    const { connectOpportunityResponder } = await import('@/lib/opportunities/connect')
    const res = await connectOpportunityResponder({ opportunityId: 'opp1', creatorId: CREATOR, responderId: RESPONDER })
    expect(res).toMatchObject({ ok: false, code: 'cooldown' })
    expect(h.state.rpc).toEqual([])
  })

  it('the block check and the account-active check still fire before any write', async () => {
    arrange()
    h.state.tableReplies.set('blocked_users', { data: [{ user_id: CREATOR, blocked_user_id: RESPONDER }], error: null })
    const { connectOpportunityResponder } = await import('@/lib/opportunities/connect')
    expect(await connectOpportunityResponder({ opportunityId: 'opp1', creatorId: CREATOR, responderId: RESPONDER }))
      .toMatchObject({ ok: false, code: 'blocked' })
    expect(h.state.rpc).toEqual([])

    h.reset(); vi.resetModules(); arrange()
    h.state.tableReplies.set('profiles', { data: [
      { id: CREATOR, account_status: 'active' }, { id: RESPONDER, account_status: 'deactivated' }], error: null })
    const { connectOpportunityResponder: fn } = await import('@/lib/opportunities/connect')
    expect(await fn({ opportunityId: 'opp1', creatorId: CREATOR, responderId: RESPONDER }))
      .toMatchObject({ ok: false, code: 'user_inactive' })
    expect(h.state.rpc).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('create_support_match — the exemption cannot be turned into a general bypass', () => {
  it('exactly TWO production files call it', () => {
    const { execSync } = require('node:child_process')
    const out = execSync(
      "grep -rln 'createSupportMatch' --include='*.ts' --include='*.tsx' app lib components || true",
      { encoding: 'utf8' },
    )
    const callers = out.split('\n').filter(Boolean)
      .filter((f: string) => !f.includes('__tests__'))
      .filter((f: string) => f !== 'lib/relationships/supportMatch.ts')   // the module itself
      .sort()
    expect(callers).toEqual([
      'app/api/admin/issues/[id]/reply/route.ts',
      'lib/onboarding/welcomeFromAdmin.ts',
    ])
  })

  it('the exemption is keyed on is_admin in SQL, and no TypeScript asserts it', () => {
    const sql = readFileSync('supabase/migrations/096_community_boundary_enforcement.sql', 'utf8')
    const from = sql.indexOf('CREATE OR REPLACE FUNCTION public.create_support_match')
    const fn = sql.slice(from, sql.indexOf('$$;', from))
    expect(fn).toMatch(/SELECT p\.is_admin INTO v_is_admin[\s\S]{0,160}FOR SHARE/)
    expect(fn).toMatch(/v_is_admin IS NOT TRUE[\s\S]{0,400}not_platform_account/)

    // The boundary must never be KEYED on an email address. Asserted against the EXECUTABLE body
    // with SQL comments stripped, because the surrounding prose (and the COMMENT ON FUNCTION) name
    // ADMIN_EMAIL deliberately, to say the exemption is not based on it. A blunt whole-file match
    // would fail on the very documentation that states the rule.
    const executable = fn.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(executable).not.toMatch(/ADMIN_EMAIL|bizdev91|\bemail\b/)

    // And the TypeScript side must not offer a second opinion about who the platform account is.
    const client = readFileSync('lib/relationships/supportMatch.ts', 'utf8')
    const code = client.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/is_admin|ADMIN_EMAIL/)
  })

  it('there is no generic platform-account helper and no bypass flag on the ordinary writer', () => {
    const gated = readFileSync('lib/relationships/gatedMatch.ts', 'utf8')
    // A boolean that skips the community check is exactly the mechanism this design forbids.
    expect(gated).not.toMatch(/skipCommunity|bypassCommunity|allowCrossCommunity|isPlatform/i)
    expect(existsSync('lib/relationships/isPlatformAccount.ts')).toBe(false)
  })

  it('a non-admin identity is refused, and the caller does not proceed', async () => {
    const { createSupportMatch, isSupportConnected } = await import('@/lib/relationships/supportMatch')
    h.state.rpcReply.set('create_support_match', {
      data: { outcome: 'ineligible', detail: 'not_platform_account' }, error: null,
    })
    const r = await createSupportMatch(h.makeClient(), CREATOR, RESPONDER)
    expect(r).toMatchObject({ outcome: 'ineligible', detail: 'not_platform_account' })
    expect(isSupportConnected(r.outcome)).toBe(false)
  })

  it('welcome: a refusal sends no message and does NOT set welcome_sent_at', async () => {
    h.state.tableReplies.set('profiles', { data: { id: RESPONDER, welcome_sent_at: null }, error: null })
    h.state.rpcReply.set('create_support_match', {
      data: { outcome: 'ineligible', detail: 'not_platform_account' }, error: null,
    })
    vi.doMock('@/lib/admin/getAdminUser', () => ({
      getAdminUser: async () => ({ id: CREATOR, email: 'a@x.com', full_name: 'A' }),
    }))
    const { sendAdminWelcome } = await import('@/lib/onboarding/welcomeFromAdmin')
    const res = await sendAdminWelcome(RESPONDER)

    expect(res.created).toBe(false)
    expect(h.state.writes.filter((w) => w.table === 'messages')).toEqual([])
    // Not marking the flag is what lets a transient failure retry instead of skipping the member.
    expect(h.state.writes.some((w) => w.table === 'profiles' && w.payload?.welcome_sent_at)).toBe(false)
    expect(h.state.notifications).toEqual([])
  })

  it('welcome: the approved path succeeds and keeps its message + notification', async () => {
    h.state.tableReplies.set('profiles', { data: { id: RESPONDER, welcome_sent_at: null }, error: null })
    h.state.tableReplies.set('messages', { data: null, error: null })
    h.state.rpcReply.set('create_support_match', {
      data: { outcome: 'created', match_id: 'm1', conversation_id: 'c1' }, error: null,
    })
    vi.doMock('@/lib/admin/getAdminUser', () => ({
      getAdminUser: async () => ({ id: CREATOR, email: 'a@x.com', full_name: 'A' }),
    }))
    const { sendAdminWelcome } = await import('@/lib/onboarding/welcomeFromAdmin')
    const res = await sendAdminWelcome(RESPONDER)

    expect(res).toMatchObject({ created: true, matchId: 'm1', conversationId: 'c1' })
    const msg = h.state.writes.find((w) => w.table === 'messages' && w.op === 'insert')
    expect(msg?.payload.sender_id).toBe(CREATOR)
    expect(msg?.payload.is_system).toBe(false)
    expect(h.state.notifications).toHaveLength(1)
    expect(h.state.notifications[0].type).toBe('message_received')
    expect(h.state.writes.some((w) => w.table === 'profiles' && w.payload?.welcome_sent_at)).toBe(true)
  })

  it('welcome: an already-matched member reuses the existing conversation (idempotent)', async () => {
    h.state.tableReplies.set('profiles', { data: { id: RESPONDER, welcome_sent_at: null }, error: null })
    h.state.tableReplies.set('messages', { data: null, error: null })
    h.state.rpcReply.set('create_support_match', {
      data: { outcome: 'already_matched', match_id: 'm1', conversation_id: 'c1' }, error: null,
    })
    vi.doMock('@/lib/admin/getAdminUser', () => ({
      getAdminUser: async () => ({ id: CREATOR, email: 'a@x.com', full_name: 'A' }),
    }))
    const { sendAdminWelcome } = await import('@/lib/onboarding/welcomeFromAdmin')
    expect((await sendAdminWelcome(RESPONDER)).conversationId).toBe('c1')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('the intro pre-checks fail closed', () => {
  it('same community passes the gate', async () => {
    communityRows([{ id: CREATOR, member_type: 'professional' }, { id: RESPONDER, member_type: 'professional' }])
    const { checkPairCommunity } = await import('@/lib/community/pairGate')
    expect(await checkPairCommunity(CREATOR, RESPONDER)).toMatchObject({ allowed: true })
  })

  it('cross community is denied', async () => {
    communityRows([{ id: CREATOR, member_type: 'professional' }, { id: RESPONDER, member_type: 'next' }])
    const { checkPairCommunity } = await import('@/lib/community/pairGate')
    expect(await checkPairCommunity(CREATOR, RESPONDER)).toEqual({ allowed: false, reason: 'cross_community' })
  })

  it('a missing profile is denied — never assumed professional', async () => {
    communityRows([{ id: CREATOR, member_type: 'professional' }])
    const { checkPairCommunity } = await import('@/lib/community/pairGate')
    expect(await checkPairCommunity(CREATOR, RESPONDER)).toEqual({ allowed: false, reason: 'profile_missing' })
  })

  it('an absent or misspelled member_type is denied, not defaulted', async () => {
    for (const bad of [null, 'professsional', '', 'NEXT']) {
      h.reset(); vi.resetModules()
      communityRows([{ id: CREATOR, member_type: 'professional' }, { id: RESPONDER, member_type: bad as any }])
      const { checkPairCommunity } = await import('@/lib/community/pairGate')
      expect(await checkPairCommunity(CREATOR, RESPONDER), String(bad))
        .toEqual({ allowed: false, reason: 'unknown_member_type' })
    }
  })

  it('an unavailable read is denied AND marked retryable — never stated as a fact', async () => {
    h.state.tableReplies.set('__community__', { ok: false, reason: 'unavailable' })
    const { checkPairCommunity, isRetryableDenial } = await import('@/lib/community/pairGate')
    const r = await checkPairCommunity(CREATOR, RESPONDER)
    expect(r).toEqual({ allowed: false, reason: 'unavailable' })
    expect(isRetryableDenial('unavailable')).toBe(true)
    expect(isRetryableDenial('cross_community')).toBe(false)
  })

  it('an empty or self id never reaches the database', async () => {
    const { checkPairCommunity } = await import('@/lib/community/pairGate')
    for (const [a, b] of [['', RESPONDER], [CREATOR, ''], [CREATOR, CREATOR]] as const) {
      expect(await checkPairCommunity(a, b)).toEqual({ allowed: false, reason: 'invalid_pair' })
    }
  })

  it('createAdminIntroPair refuses a cross-community pair BEFORE writing intro_requests', async () => {
    communityRows([{ id: CREATOR, member_type: 'professional' }, { id: RESPONDER, member_type: 'next' }])
    const { createAdminIntroPair } = await import('@/lib/introRequests/createAdminIntroPair')
    const res = await createAdminIntroPair(CREATOR, RESPONDER)

    expect(res).toMatchObject({ ok: false, code: 'cross_community' })
    // 'admin_pending' is INSIDE can_discover_profile's grant set, so a row here would already make
    // the two members mutually discoverable. Nothing may be written.
    expect(h.state.writes.filter((w) => w.table === 'intro_requests')).toEqual([])
    expect(h.state.rpc).toEqual([])
    expect(h.state.notifications).toEqual([])
  })

  it('createAdminIntroPair puts the community check FIRST, before every other gate', () => {
    const src = readFileSync('lib/introRequests/createAdminIntroPair.ts', 'utf8')
    const body = src.slice(src.indexOf('export async function createAdminIntroPair'))
    const gate = body.indexOf('checkPairCommunity')
    expect(gate).toBeGreaterThan(-1)
    for (const later of ["from('profiles')", "from('blocked_users')", "from('matches')", "from('intro_requests')"]) {
      expect(gate, `community gate must precede ${later}`).toBeLessThan(body.indexOf(later))
    }
  })

  it('accept-incoming checks the community before the reciprocal write, not just before finalize', () => {
    const src = readFileSync('app/api/intro-requests/accept-incoming/route.ts', 'utf8')
    const gate = src.indexOf('checkPairCommunity')
    expect(gate).toBeGreaterThan(-1)
    // The reciprocal row it writes is status 'approved' — itself discovery-conferring.
    expect(gate).toBeLessThan(src.indexOf("from('intro_requests').insert"))
    expect(gate).toBeLessThan(src.indexOf('finalizeMutualMatch('))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('batch_suggestions: the browser write surface is closed', () => {
  const M097 = 'supabase/migrations/097_batch_suggestions_browser_write_revocation.sql'
  const SQL = () => readFileSync(M097, 'utf8')

  it('the migration exists and revokes UPDATE from the browser roles', () => {
    expect(existsSync(M097)).toBe(true)
    expect(SQL()).toMatch(/REVOKE UPDATE ON TABLE public\.batch_suggestions FROM PUBLIC, anon, authenticated;/)
  })

  it('it drops the now-unreachable permissive UPDATE policy', () => {
    expect(SQL()).toMatch(/DROP POLICY IF EXISTS "Users can update their own batch suggestions" ON public\.batch_suggestions;/)
  })

  it('the recipient-self SELECT behaviour is preserved and re-proved after apply', () => {
    const s = SQL()
    expect(s).not.toMatch(/DROP POLICY[^\n]*batch_suggestions_recipient_self_read/)
    expect(s).not.toMatch(/REVOKE[^\n]*SELECT[^\n]*batch_suggestions/)
    expect(s).toMatch(/batch_suggestions_recipient_self_read was lost/)
    expect(s).toMatch(/authenticated lost SELECT on public\.batch_suggestions/)
  })

  it('INSERT rights are not broadened — reported, never granted, to a browser role', () => {
    const s = SQL()
    const grants = s.split('\n').filter((l) => /^\s*GRANT\b/i.test(l))
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatch(/TO service_role;$/)
    expect(s).not.toMatch(/GRANT[^\n]*(anon|authenticated)/)
  })

  it('hide-suggestion writes as service_role and constrains by BOTH id and recipient', () => {
    const src = readFileSync('app/api/intro/hide-suggestion/route.ts', 'utf8')
    expect(src).toContain('createAdminClient')
    const upd = src.slice(src.indexOf(".update({ status: 'hidden_permanent' })"))
    expect(upd).toMatch(/\.eq\('id', rowId\)/)
    expect(upd).toMatch(/\.eq\('recipient_id', user\.id\)/)
    // The ownership filter is now the only boundary, so it must come from the session, not the body.
    const body = src.slice(src.indexOf('export async function POST'))
    expect(body.indexOf('auth.getUser()')).toBeLessThan(body.indexOf('.update('))
    expect(src).not.toMatch(/recipient_id['"]?\s*,\s*(body|req|payload)/)
  })

  it('a missing rowId is rejected before the query, so the filter cannot widen', () => {
    const src = readFileSync('app/api/intro/hide-suggestion/route.ts', 'utf8')
    expect(src).toMatch(/if \(!rowId \|\| typeof rowId !== 'string'\)/)
  })

  it('hide-suggestion is the ONLY browser-originated batch_suggestions write left', () => {
    const { execSync } = require('node:child_process')
    const files = execSync(
      "grep -rln \"from('batch_suggestions')\" --include='*.ts' --include='*.tsx' app lib components || true",
      { encoding: 'utf8' },
    ).split('\n').filter(Boolean).filter((f: string) => !f.includes('__tests__'))

    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      const writes = /from\(['"]batch_suggestions['"]\)[\s\S]{0,120}?\.(update|insert|delete)\(/.test(src)
      if (!writes) continue
      expect(src, `${f} writes batch_suggestions and must use the service-role client`)
        .toMatch(/createAdminClient/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('the dead helpers are gone and cannot come back quietly', () => {
  it('createIntroRequest no longer exists', () => {
    const src = readFileSync('lib/introRequests/index.ts', 'utf8')
    expect(src).not.toMatch(/export async function createIntroRequest/)
    expect(existsSync('lib/__tests__/create-intro-request.test.ts')).toBe(false)
  })

  it('createConversation no longer exists', () => {
    expect(readFileSync('app/actions.ts', 'utf8')).not.toMatch(/export async function createConversation/)
  })

  it('neither has a caller anywhere in production code', () => {
    const { execSync } = require('node:child_process')
    const hits = execSync(
      "grep -rn 'createIntroRequest(\\|createConversation(' --include='*.ts' --include='*.tsx' app lib components || true",
      { encoding: 'utf8' },
    ).split('\n').filter(Boolean).filter((l: string) => !l.includes('__tests__'))
    expect(hits).toEqual([])
  })

  it('conversation_participants was NOT created — it is not part of the design', () => {
    const { execSync } = require('node:child_process')
    const hits = execSync(
      "grep -rln 'conversation_participants' --include='*.ts' --include='*.tsx' --include='*.sql' app lib components supabase || true",
      { encoding: 'utf8' },
    ).split('\n').filter(Boolean).filter((f: string) => !f.includes('__tests__'))
    // The only surviving mentions are prose explaining why it must not exist.
    for (const f of hits) {
      const src = readFileSync(f, 'utf8')
      expect(src, `${f} must not query or create conversation_participants`)
        .not.toMatch(/from\(['"]conversation_participants['"]\)|CREATE TABLE[^\n]*conversation_participants/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('create_admin_intro_pair — the admin intro write is authoritative in SQL', () => {
  const arrangeAdminIntro = () => {
    communityRows([{ id: CREATOR, member_type: 'professional' }, { id: RESPONDER, member_type: 'professional' }])
    h.state.tableReplies.set('profiles', { data: [
      { id: CREATOR, full_name: 'A', account_status: 'active', company: 'Acme' },
      { id: RESPONDER, full_name: 'B', account_status: 'active', company: 'Globex' },
    ], error: null })
    h.state.tableReplies.set('blocked_users', { data: [], error: null })
    h.state.tableReplies.set('matches', { data: [], error: null })
    h.state.tableReplies.set('intro_requests', { data: [], error: null })
  }

  it('THE POINT OF THIS MIGRATION: no direct intro_requests INSERT remains in the caller', () => {
    const src = readFileSync('lib/introRequests/createAdminIntroPair.ts', 'utf8')
    expect(src).not.toMatch(/from\(['"]intro_requests['"]\)[\s\S]{0,400}?\.insert\(/)
    expect(src).toContain('createAdminIntroPairRpc(')
  })

  it('a Professional pair is written through the RPC with the exact old row content', async () => {
    arrangeAdminIntro()
    h.state.rpcReply.set('create_admin_intro_pair', {
      data: { outcome: 'created', rows: [
        { id: 'i1', requester_id: CREATOR, target_user_id: RESPONDER, status: 'admin_pending', is_admin_initiated: true },
        { id: 'i2', requester_id: RESPONDER, target_user_id: CREATOR, status: 'admin_pending', is_admin_initiated: true },
      ] }, error: null,
    })
    const { createAdminIntroPair } = await import('@/lib/introRequests/createAdminIntroPair')
    const res: any = await createAdminIntroPair(CREATOR, RESPONDER, { adminNotes: 'manual_create' })

    expect(res).toMatchObject({ ok: true, mode: 'intro_proposed' })
    // The routes log `introRequests.map(i => i.id)` and return the array; the projection must be
    // exactly what `.select('id, requester_id, target_user_id')` used to give them.
    expect(res.introRequests).toEqual([
      { id: 'i1', requester_id: CREATOR, target_user_id: RESPONDER },
      { id: 'i2', requester_id: RESPONDER, target_user_id: CREATOR },
    ])

    const call = h.state.rpc.find((r) => r.name === 'create_admin_intro_pair')
    expect(call).toBeDefined()
    expect(call!.args).toMatchObject({ p_user_a: CREATOR, p_user_b: RESPONDER, p_admin_notes: 'manual_create' })
    // The reason is computed in TypeScript from profile signals and passed in as content.
    expect(call!.args).toHaveProperty('p_match_reason')
    // No direct write of any kind.
    expect(h.state.writes.filter((w) => w.table === 'intro_requests')).toEqual([])
    // Notifications still go out on success.
    expect(h.state.notifications).toHaveLength(2)
    expect(h.state.notifications.every((n) => n.type === 'admin_intro')).toBe(true)
  })

  it('an SQL-level cross-community refusal is reported, and notifies nobody', async () => {
    arrangeAdminIntro()   // the TypeScript pre-check passes; the DATABASE is the one that refuses
    h.state.rpcReply.set('create_admin_intro_pair', {
      data: { outcome: 'ineligible', detail: 'cross_community' }, error: null,
    })
    const { createAdminIntroPair } = await import('@/lib/introRequests/createAdminIntroPair')
    const res: any = await createAdminIntroPair(CREATOR, RESPONDER)

    expect(res).toMatchObject({ ok: false, code: 'cross_community' })
    expect(h.state.notifications).toEqual([])
  })

  it('a missing profile at write time is refused, not treated as a transient failure', async () => {
    arrangeAdminIntro()
    h.state.rpcReply.set('create_admin_intro_pair', {
      data: { outcome: 'ineligible', detail: 'profile_missing' }, error: null,
    })
    const { createAdminIntroPair } = await import('@/lib/introRequests/createAdminIntroPair')
    expect(await createAdminIntroPair(CREATOR, RESPONDER)).toMatchObject({ ok: false, code: 'cross_community' })
    expect(h.state.notifications).toEqual([])
  })

  it('a concurrent duplicate caught inside the pair locks reports intro_already_proposed', async () => {
    arrangeAdminIntro()
    h.state.rpcReply.set('create_admin_intro_pair', {
      data: { outcome: 'already_proposed', rows: [
        { id: 'x1', requester_id: CREATOR, target_user_id: RESPONDER, status: 'admin_pending', is_admin_initiated: true },
      ] }, error: null,
    })
    const { createAdminIntroPair } = await import('@/lib/introRequests/createAdminIntroPair')
    const res: any = await createAdminIntroPair(CREATOR, RESPONDER)

    expect(res).toMatchObject({ ok: true, mode: 'intro_already_proposed' })
    // Projected to the shape the TypeScript duplicate guard returns, so the Concierge route's
    // `mode === 'intro_already_proposed'` branch behaves identically whichever layer caught it.
    expect(res.introRequests).toEqual([{ id: 'x1', status: 'admin_pending', is_admin_initiated: true }])
    expect(h.state.notifications).toEqual([])
  })

  it('every unknown outcome fails closed as insert_failed', async () => {
    for (const data of [
      { outcome: 'something_new' },
      { outcome: 'invalid', detail: 'self_pair' },
      { outcome: 'created', rows: [{ id: 'only-one' }] },   // created without its two rows
      null,
    ]) {
      h.reset(); vi.resetModules(); arrangeAdminIntro()
      h.state.rpcReply.set('create_admin_intro_pair', { data, error: null })
      const { createAdminIntroPair } = await import('@/lib/introRequests/createAdminIntroPair')
      const res: any = await createAdminIntroPair(CREATOR, RESPONDER)
      expect(res, JSON.stringify(data)).toMatchObject({ ok: false, code: 'insert_failed' })
      expect(h.state.notifications).toEqual([])
    }
  })

  it('a transport failure fails closed too', async () => {
    arrangeAdminIntro()
    h.state.rpcReply.set('create_admin_intro_pair', { data: null, error: { code: '57014' } })
    const { createAdminIntroPair } = await import('@/lib/introRequests/createAdminIntroPair')
    expect(await createAdminIntroPair(CREATOR, RESPONDER)).toMatchObject({ ok: false, code: 'insert_failed' })
    expect(h.state.notifications).toEqual([])
  })

  it('the RPC client rejects a self-pair before reaching the database', async () => {
    const { createAdminIntroPairRpc } = await import('@/lib/relationships/adminIntroPair')
    const r = await createAdminIntroPairRpc(h.makeClient(), CREATOR, CREATOR, null, 'manual_create')
    expect(r.outcome).toBe('invalid')
    expect(h.state.rpc).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('migration 098 — the SQL contract', () => {
  const M098 = 'supabase/migrations/098_admin_intro_pair_writer.sql'
  const SQL = readFileSync(M098, 'utf8')
  const from = SQL.indexOf('CREATE OR REPLACE FUNCTION public.create_admin_intro_pair')
  const BODY = SQL.slice(from, SQL.indexOf('$$;', from))
  const CODE = BODY.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

  it('exists and is SECURITY DEFINER with a pinned empty search_path', () => {
    expect(existsSync(M098)).toBe(true)
    expect(BODY).toMatch(/SECURITY DEFINER/)
    expect(BODY).toMatch(/SET search_path = ''/)
  })

  it('EXECUTE is revoked from every browser role and granted only to service_role', () => {
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION public\.create_admin_intro_pair\(uuid, uuid, text, text\) FROM PUBLIC;/)
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION public\.create_admin_intro_pair\(uuid, uuid, text, text\) FROM anon;/)
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION public\.create_admin_intro_pair\(uuid, uuid, text, text\) FROM authenticated;/)
    const grants = SQL.split('\n').filter((l) => /^\s*GRANT\b/i.test(l))
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatch(/TO service_role;$/)
  })

  it('the community guard is EXECUTED, under both advisory locks, before the INSERT', () => {
    expect(CODE).toContain('community_pair_allowed')
    expect(CODE.indexOf('pg_advisory_xact_lock')).toBeLessThan(CODE.indexOf('community_pair_allowed'))
    expect(CODE.indexOf('community_pair_allowed')).toBeLessThan(CODE.indexOf('INSERT INTO public.intro_requests'))
    // Canonical LEAST/GREATEST order, so it cannot deadlock against the other writers.
    expect(CODE).toMatch(/lo := LEAST\(p_user_a, p_user_b\)/)
    expect(CODE).toMatch(/hi := GREATEST\(p_user_a, p_user_b\)/)
  })

  it('it writes admin_pending and never a capacity-occupying tier status', () => {
    expect(CODE).toContain("'admin_pending'")
    expect(CODE).not.toContain("'suggested'")
    expect(CODE).not.toContain("'queued'")
    // pair_id and batch_id must stay out of the INSERT entirely.
    expect(CODE).not.toContain('pair_id')
    expect(CODE).not.toContain('batch_id')
  })

  it('both directions are written by ONE statement, so no one-sided pair is possible', () => {
    const ins = CODE.slice(CODE.indexOf('INSERT INTO public.intro_requests'))
    expect(ins).toMatch(/\(p_user_a, p_user_b, 'admin_pending', true/)
    expect(ins).toMatch(/\(p_user_b, p_user_a, 'admin_pending', true/)
    expect(CODE.match(/INSERT INTO public\.intro_requests/g)).toHaveLength(1)
  })

  it('updated_at is deliberately NOT written, so the column default still applies', () => {
    const ins = CODE.slice(CODE.indexOf('INSERT INTO public.intro_requests'), CODE.indexOf('RETURNING'))
    expect(ins).not.toContain('updated_at')
  })

  it('it does not modify 096 or 097, community_pair_allowed, or any grant on profiles', () => {
    expect(SQL).not.toMatch(/CREATE OR REPLACE FUNCTION public\.community_pair_allowed/)
    expect(SQL).not.toMatch(/DROP FUNCTION/)
    expect(SQL).not.toMatch(/GRANT[^\n]*(anon|authenticated)/)
    expect(SQL).not.toMatch(/ALTER TABLE|CREATE TABLE/)
  })

  it('preconditions prove every written column exists before the function is created', () => {
    const pre = SQL.slice(0, from)
    for (const col of ['requester_id', 'target_user_id', 'status', 'is_admin_initiated',
                       'match_reason', 'admin_notes', 'created_at']) {
      expect(pre, col).toContain(`('${col}')`)
    }
    expect(pre).toMatch(/098 REFUSED: public\.intro_requests is missing column\(s\)/)
  })

  it('postapply re-proves the security properties rather than trusting the statements ran', () => {
    const post = SQL.slice(SQL.indexOf('SECTION 3'))
    for (const claim of [
      'is not SECURITY DEFINER',
      'has a mutable search_path',
      'a browser role can EXECUTE create_admin_intro_pair',
      'service_role cannot EXECUTE create_admin_intro_pair',
      'does not EXECUTE the community guard',
      'does not take the participant advisory locks',
      'writes a tier status',
      'consume_credits_and_create_match is no longer sealed',
      'a browser role holds SELECT on public.profiles',
    ]) {
      expect(post, claim).toContain(claim)
    }
  })
})
