import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { sendMessageCore } from '@/lib/messages/sendMessageCore'
import { buildProfileUpdate } from '@/lib/profile/updatePayload'
import { checkRateLimit } from '@/lib/rateLimit'

// ─────────────────────────────────────────────────────────────────────────────
// Fake service-role client for sendMessageCore. Supports exactly the chains the
// core uses. Records message inserts / conversation updates / notification calls.
// ─────────────────────────────────────────────────────────────────────────────
function fakeAdmin(cfg: any) {
  const spy = { messages: [] as any[], convUpdates: [] as any[] }
  function from(table: string) {
    let insertedRow: any = null
    const b: any = {
      select: () => b,
      eq: () => b,
      or: () => b,
      limit: () => b,
      insert: (row: any) => { insertedRow = row; if (table === 'messages') spy.messages.push(row); return b },
      update: (row: any) => { if (table === 'conversations') spy.convUpdates.push(row); return b },
      in: () => Promise.resolve({ data: table === 'profiles' ? (cfg.profiles ?? []) : [], error: null }),
      is: () => Promise.resolve({ data: cfg.unreadNudges ?? [], error: null }),
      maybeSingle: () => {
        if (table === 'conversations') return Promise.resolve({ data: cfg.conversation ?? null, error: null })
        if (table === 'matches') return Promise.resolve({ data: cfg.match ?? null, error: null })
        if (table === 'blocked_users') return Promise.resolve({ data: cfg.block ?? null, error: null })
        if (table === 'member_presence') return Promise.resolve({ data: cfg.presence ?? null, error: null })
        return Promise.resolve({ data: null, error: null })
      },
      single: () => table === 'messages'
        ? Promise.resolve({ data: cfg.insertError ? null : { id: 'msg1', ...insertedRow }, error: cfg.insertError ?? null })
        : Promise.resolve({ data: null, error: null }),
      then: (onF: any, onR: any) => Promise.resolve({ data: null, error: null }).then(onF, onR),
    }
    return b
  }
  return { client: { from }, spy }
}

const SENDER = 'user-a'
const RECIP = 'user-b'
const base = () => ({
  conversation: { id: 'c1', match_id: 'm1', first_message_sent_at: null, message_count: 0 },
  match: { user_a_id: SENDER, user_b_id: RECIP, status: 'active' },
  block: null,
  profiles: [
    { id: SENDER, account_status: 'active', full_name: 'A', email: 'a@x.com' },
    { id: RECIP, account_status: 'active', full_name: 'B', email: 'b@x.com' },
  ],
})
const noEmailDeps = () => {
  const emailSpy = vi.fn(async () => ({ id: 'e' }))
  return {
    deps: {
      createNotificationSafe: (async () => ({ id: 'n1' })) as any,
      shouldEmailNewMessage: (() => false) as any,
      sendNewMessageEmail: emailSpy,
      resendConfigured: false,
    },
    emailSpy,
  }
}

describe('sendMessageCore — authorization (blocked/removed/inactive/forged all denied, no side effects)', () => {
  it('happy path: participant, active, unblocked, active match → inserts message + returns ok', async () => {
    const { client, spy } = fakeAdmin(base())
    const { deps } = noEmailDeps()
    const r = await sendMessageCore(client as any, { senderId: SENDER, conversationId: 'c1', content: 'hi' }, deps)
    expect(r.ok).toBe(true)
    expect(spy.messages).toHaveLength(1)
    expect(spy.messages[0]).toMatchObject({ sender_id: SENDER, conversation_id: 'c1', content: 'hi' })
    expect(spy.convUpdates).toHaveLength(1)
  })

  const rejects = async (cfg: any, params: any = {}) => {
    const { client, spy } = fakeAdmin(cfg)
    const { deps, emailSpy } = noEmailDeps()
    const r = await sendMessageCore(client as any, { senderId: SENDER, conversationId: 'c1', content: 'hi', ...params }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(403)
      expect(r.error).toBe('This conversation is unavailable.') // identical → no oracle
    }
    expect(spy.messages).toHaveLength(0)      // NO message row
    expect(spy.convUpdates).toHaveLength(0)   // NO metadata bump
    expect(emailSpy).not.toHaveBeenCalled()   // NO email
    return r
  }

  it('FORGED sender: caller is not a participant of the match → generic 403, no side effects', () =>
    rejects({ ...base(), match: { user_a_id: 'someone-else', user_b_id: 'another', status: 'active' } }))
  it('REMOVED match → denied', () => rejects({ ...base(), match: { user_a_id: SENDER, user_b_id: RECIP, status: 'removed' } }))
  it('CLOSED match → denied', () => rejects({ ...base(), match: { user_a_id: SENDER, user_b_id: RECIP, status: 'closed' } }))
  it('BLOCKED (either direction) → denied', () => rejects({ ...base(), block: { id: 'blk' } }))
  it('INACTIVE sender → denied', () => rejects({ ...base(), profiles: [
    { id: SENDER, account_status: 'deactivated', full_name: 'A', email: 'a@x.com' },
    { id: RECIP, account_status: 'active', full_name: 'B', email: 'b@x.com' },
  ] }))
  it('INACTIVE recipient → denied', () => rejects({ ...base(), profiles: [
    { id: SENDER, account_status: 'active', full_name: 'A', email: 'a@x.com' },
    { id: RECIP, account_status: 'deactivated', full_name: 'B', email: 'b@x.com' },
  ] }))
  it('missing conversation → denied', () => rejects({ ...base(), conversation: null }))

  it('empty content → 400 invalid (no insert)', async () => {
    const { client, spy } = fakeAdmin(base())
    const { deps } = noEmailDeps()
    const r = await sendMessageCore(client as any, { senderId: SENDER, conversationId: 'c1', content: '   ' }, deps)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
    expect(spy.messages).toHaveLength(0)
  })

  it('sends the throttled email only when authorized + shouldEmail + resend configured', async () => {
    const { client } = fakeAdmin(base())
    const emailSpy = vi.fn(async () => ({ id: 'e' }))
    const r = await sendMessageCore(client as any, { senderId: SENDER, conversationId: 'c1', content: 'hi' }, {
      createNotificationSafe: (async () => ({ id: 'n1' })) as any,
      shouldEmailNewMessage: (() => true) as any,
      sendNewMessageEmail: emailSpy,
      resendConfigured: true,
    })
    expect(r.ok).toBe(true)
    expect(emailSpy).toHaveBeenCalledTimes(1)
    expect(emailSpy).toHaveBeenCalledWith('b@x.com', 'B', 'A', 'hi')
  })
})

describe('buildProfileUpdate — self privilege-escalation columns are never writable', () => {
  it('drops is_admin / subscription_tier / account_status / password_reset_required / credits / verification / trust, keeps allowlisted fields', () => {
    const fd = new FormData()
    for (const [k, v] of Object.entries({
      is_admin: 'true', subscription_tier: 'executive', account_status: 'active',
      password_reset_required: 'false', credits: '99999', meeting_credits: '99999',
      verification_status: 'high_confidence', verification_metadata: '{}', trust_score: '100',
      is_founding_member: 'true', stripe_customer_id: 'cus_x', company_id: 'x', email: 'evil@x.com',
      full_name: 'Jane Doe', title: 'CEO', bio: 'hi',
    })) fd.set(k, v)
    const res = buildProfileUpdate(fd)
    expect('payload' in res).toBe(true)
    if ('payload' in res) {
      const keys = Object.keys(res.payload)
      for (const forbidden of ['is_admin', 'subscription_tier', 'account_status', 'password_reset_required',
        'credits', 'meeting_credits', 'verification_status', 'verification_metadata', 'trust_score',
        'is_founding_member', 'stripe_customer_id', 'company_id', 'email']) {
        expect(keys).not.toContain(forbidden)
      }
      expect(res.payload.full_name).toBe('Jane Doe')
      expect(res.payload.title).toBe('CEO')
    }
  })
})

describe('checkRateLimit — atomic, FAILS CLOSED (error → 503), deterministic windows', () => {
  const adminWith = (fn: (args: any) => { data?: any; error?: any }) => ({ rpc: async (_n: string, a: any) => fn(a) })
  it('at/under the limit → allowed; over → over_limit with a positive Retry-After', async () => {
    const at = await checkRateLimit(adminWith(() => ({ data: 5 })) as any, { key: 'k', limit: 5, windowSeconds: 600, now: 1_000_000 })
    expect(at.status).toBe('allowed')
    const over = await checkRateLimit(adminWith(() => ({ data: 6 })) as any, { key: 'k', limit: 5, windowSeconds: 600, now: 1_000_000 })
    expect(over.status).toBe('over_limit')
    if (over.status === 'over_limit') expect(over.retryAfterSeconds).toBeGreaterThan(0)
  })
  it('RPC error → error (FAIL CLOSED, never allowed)', async () => {
    const r = await checkRateLimit(adminWith(() => ({ error: { code: 'PGRST202' } })) as any, { key: 'k', limit: 5, windowSeconds: 600 })
    expect(r.status).toBe('error')
  })
  it('RPC throws → error (fail closed)', async () => {
    const r = await checkRateLimit({ rpc: async () => { throw new Error('down') } } as any, { key: 'k', limit: 5, windowSeconds: 600 })
    expect(r.status).toBe('error')
  })
  it('RPC timeout → error (fail closed)', async () => {
    const r = await checkRateLimit({ rpc: () => new Promise(() => {}) } as any, { key: 'k', limit: 5, windowSeconds: 600, timeoutMs: 20 })
    expect(r.status).toBe('error')
  })
  it('malformed result (non-numeric / null) → error (fail closed)', async () => {
    for (const bad of [{ data: null }, { data: 'nope' }, { data: undefined }, {}]) {
      const r = await checkRateLimit(adminWith(() => bad) as any, { key: 'k', limit: 5, windowSeconds: 600 })
      expect(r.status).toBe('error')
    }
  })
  it('CONCURRENT calls cannot exceed the limit (atomic increment → exactly `limit` allowed)', async () => {
    let counter = 0
    const admin = { rpc: async () => ({ data: ++counter }) } // ++ is atomic in the JS event loop
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      checkRateLimit(admin as any, { key: 'k', limit: 5, windowSeconds: 600, now: 1000 })))
    expect(results.filter((r) => r.status === 'allowed')).toHaveLength(5)
    expect(results.filter((r) => r.status === 'over_limit')).toHaveLength(3)
  })
  it('passes a windowed bucket key + window start to the RPC', async () => {
    let seen: any = null
    await checkRateLimit({ rpc: async (_n: string, a: any) => { seen = a; return { data: 1 } } } as any,
      { key: 'issue_report:u1', limit: 5, windowSeconds: 600, now: 600_000 })
    expect(seen.p_bucket_key).toBe('issue_report:u1')
    expect(typeof seen.p_window_start).toBe('string')
  })
})

describe('migration 055 — matches production containment exactly (structural)', () => {
  const sql = readFileSync('supabase/migrations/055_revoke_browser_table_mutations.sql', 'utf8')
  it('revokes profiles INSERT+UPDATE (not SELECT, not DELETE) from the browser roles', () => {
    expect(sql).toMatch(/REVOKE INSERT, UPDATE ON TABLE public\.profiles FROM PUBLIC, anon, authenticated/)
  })
  it('revokes messages INSERT+DELETE but PRESERVES UPDATE (recipient read-state)', () => {
    expect(sql).toMatch(/REVOKE INSERT, DELETE ON TABLE public\.messages FROM PUBLIC, anon, authenticated/)
    expect(sql).not.toMatch(/REVOKE[^;]*UPDATE[^;]*ON TABLE public\.messages/)
  })
  it('revokes all DML on meetings/credit_transactions/matches/conversations/intro_requests', () => {
    for (const t of ['meetings', 'credit_transactions', 'matches', 'conversations', 'intro_requests']) {
      expect(sql).toMatch(new RegExp(`REVOKE INSERT, UPDATE, DELETE ON TABLE public\\.${t}\\s+FROM PUBLIC, anon, authenticated`))
    }
  })
  it('explicitly preserves service_role privileges and never revokes SELECT', () => {
    expect(sql).toMatch(/GRANT INSERT, UPDATE, DELETE ON TABLE public\.profiles\s+TO service_role/)
    expect(sql).not.toMatch(/REVOKE[^;]*SELECT/)
  })
  it('drops the obsolete permissive INSERT policies', () => {
    for (const p of ['profiles_insert_system', 'messages_insert_authenticated', 'meetings_insert_authenticated', 'credit_tx_insert_system']) {
      expect(sql).toMatch(new RegExp(`DROP POLICY IF EXISTS ${p}`))
    }
  })
})

describe('migration 056 — durable atomic rate-limit primitive is service-role only (structural)', () => {
  const sql = readFileSync('supabase/migrations/056_rate_limit_counters.sql', 'utf8')
  it('creates the counter table with RLS on and no browser policies', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.rate_limit_hits/)
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(sql).not.toMatch(/CREATE POLICY/)
  })
  it('exposes bump_rate_limit as SECURITY DEFINER with empty search_path, service_role EXECUTE only', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.bump_rate_limit/)
    expect(sql).toMatch(/SECURITY DEFINER/)
    expect(sql).toMatch(/SET search_path = ''/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.bump_rate_limit\(text, timestamptz\) TO service_role/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.bump_rate_limit\(text, timestamptz\) FROM PUBLIC, anon, authenticated/)
  })
})
