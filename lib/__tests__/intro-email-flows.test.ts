import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/**
 * The two introduction email flows.
 *
 *   PART 1  a one-time, admin-only catch-up for members holding unanswered introductions when this
 *           week's ordinary Wednesday window passed before the reminder shipped.
 *   PART 2  the ongoing "new introductions are available" email, sent by ONE shared outbox that
 *           every visible-card writer routes through.
 *
 * WHY PART 2 EXISTS AT ALL. A new-introduction email already existed, but both senders counted
 * cards with `.eq('batch_id', batchId)` and deduped on `batch:<batchId>`. Reciprocal cards are
 * created by create_reciprocal_suggestion with batch_id NULL and no recommendation_batches
 * envelope — so onboarding, weekly, coverage, retry and recovery generation created visible cards
 * and emailed NOBODY. The outbox keys on the committed cards instead, which is the only key all
 * four writers share.
 */

// ── in-memory fakes ────────────────────────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  introRows: [] as any[],
  profiles: [] as any[],
  deliveries: [] as any[],
  outbox: [] as any[],
  emails: [] as any[],
  failIntroRead: false,
  failProfileRead: false,
  sameOrigin: null as any,
  adminError: null as any,
  emailThrows: false,
  emailOptedOut: false,
}))

let seq = 0
function fakeAdmin(): any {
  return {
    from(table: string) {
      const eqs: Array<[string, any]> = []
      let op: 'select' | 'insert' | 'update' = 'select'
      let payload: any = null
      let rangeArgs: [number, number] | null = null
      const inFilters: Array<[string, any[]]> = []
      let ltFilter: [string, any] | null = null
      let orderDesc = false, orderCol = ''
      let limitN: number | null = null

      const rowsFor = () => {
        if (table === 'intro_requests') return h.introRows
        if (table === 'profiles') return h.profiles
        if (table === 'introduction_email_outbox') return h.outbox
        return h.deliveries
      }
      const matches = (r: any) =>
        eqs.every(([k, v]) => r[k] === v) &&
        inFilters.every(([k, v]) => v.includes(r[k])) &&
        (!ltFilter || r[ltFilter[0]] < ltFilter[1])

      const b: any = {
        // NB: a trailing .select() is how supabase-js returns affected rows from an insert or an
        // update — it must NOT turn the operation back into a read. `op` already defaults to select.
        select(_s?: any, _o?: any) { return b },
        insert(v: any) { op = 'insert'; payload = v; return b },
        update(v: any) { op = 'update'; payload = v; return b },
        eq(k: string, v: any) { eqs.push([k, v]); return b },
        in(k: string, v: any[]) { inFilters.push([k, v]); return b },
        lt(k: string, v: any) { ltFilter = [k, v]; return b },
        order(c: string, o?: any) { orderCol = c; orderDesc = o?.ascending === false; return b },
        limit(n: number) { limitN = n; return b },
        range(a: number, z: number) { rangeArgs = [a, z]; return b.then ? b : Promise.resolve(resolveList()) },
        maybeSingle() { const l = resolveList(); return Promise.resolve({ data: l.data?.[0] ?? null, error: l.error }) },
        single() { const l = resolveList(); return Promise.resolve({ data: l.data?.[0] ?? null, error: l.error }) },
        then(res: any) { return Promise.resolve(resolveList()).then(res) },
      }

      function resolveList() {
        if (table === 'intro_requests' && h.failIntroRead) return { data: null, error: { code: 'PGRST' } }
        if (table === 'profiles' && h.failProfileRead) return { data: null, error: { code: 'PGRST' } }

        if (op === 'insert') {
          if (table === 'reminder_deliveries') {
            // the partial unique indexes, modelled: week-keyed and event-keyed claims
            const dup = h.deliveries.find((d) =>
              d.member_id === payload.member_id && d.purpose === payload.purpose &&
              (payload.event_key ? d.event_key === payload.event_key : d.cycle_key === payload.cycle_key) &&
              ['claimed', 'accepted', 'delivered', 'deferred'].includes(d.status))
            if (dup) return { data: null, error: { code: '23505' } }
          }
          const row = { id: `d${++seq}`, created_at: new Date().toISOString(), ...payload }
          rowsFor().push(row)
          return { data: [row], error: null }
        }
        if (op === 'update') {
          const hit = rowsFor().filter(matches)
          hit.forEach((r) => Object.assign(r, payload))
          return { data: hit, error: null }
        }
        let out = rowsFor().filter(matches)
        if (orderCol) out = [...out].sort((x, y) => (orderDesc ? (y[orderCol] > x[orderCol] ? 1 : -1) : (x[orderCol] > y[orderCol] ? 1 : -1)))
        if (rangeArgs) out = out.slice(rangeArgs[0], rangeArgs[1] + 1)
        if (limitN != null) out = out.slice(0, limitN)
        return { data: out, error: null }
      }
      return b
    },
  }
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => fakeAdmin() }))
vi.mock('@/lib/admin/requireAdmin', () => ({ requireAdmin: async () => ({ user: { id: 'admin' }, error: h.adminError }) }))
vi.mock('@/lib/http/sameOrigin', () => ({ assertSameOrigin: () => h.sameOrigin }))
vi.mock('@/lib/email', () => ({
  sendWednesdayIntroReminderEmail: vi.fn(async (to: string, name: string | null, n: number) => {
    if (h.emailThrows) throw new Error('provider down')
    h.emails.push({ kind: 'wednesday', to, name, n })
    return { sent: !h.emailOptedOut, providerMessageId: 'p1' }
  }),
  sendNewIntroductionsEmail: vi.fn(async (to: string, name: string | null) => {
    if (h.emailThrows) throw new Error('provider down')
    h.emails.push({ kind: 'new_intros', to, name })
    return { sent: !h.emailOptedOut, providerMessageId: 'p2' }
  }),
}))

import { parseCatchupBody, maskEmail } from '@/lib/reminders/catchupCampaign'
import { CATCHUP_CAMPAIGN_KEY, CATCHUP_UNANSWERED, NEW_INTRODUCTIONS, WEDNESDAY_UNANSWERED } from '@/lib/reminders/purposes'
import { drainIntroductionOutbox, eventKeyForCards } from '@/lib/introductions/newIntroductionOutbox'
import { buildNewIntroductionsEmail, newIntroductionsCopy, INTRODUCTIONS_URL } from '@/lib/email/newIntroductions'

const nowish = () => new Date().toISOString()
const ROUTE_SRC = readFileSync('app/api/admin/reminders/unanswered-intros-catchup/route.ts', 'utf8')
const OUTBOX_SRC = readFileSync('lib/introductions/newIntroductionOutbox.ts', 'utf8')

beforeEach(() => {
  h.introRows = []; h.profiles = []; h.deliveries = []; h.emails = []; h.outbox = []
  h.failIntroRead = false; h.failProfileRead = false
  h.sameOrigin = null; h.adminError = null; h.emailThrows = false; h.emailOptedOut = false
  seq = 0
})

const member = (id: string, over: any = {}) => ({
  id, email: `${id}@example.com`, full_name: `${id.toUpperCase()} Person`,
  account_status: 'active', profile_complete: true, is_test_account: false,
  is_admin: false, matching_paused: false, ...over,
})
/**
 * Targets referenced by the card fixtures, as ACTIVE profiles.
 *
 * openCardsFor now requires the target to be active (mirroring count_unresolved_introductions in
 * migration 081). In production every target has a profile row — intro_requests.target_user_id is
 * a foreign key — but these fixtures only ever defined profiles for the members under test, so
 * without this every card is correctly filtered out and the suites see zero candidates.
 */
const activeTargets = () => ['x', 'y', 't', 'z', 'target'].map((id) => member(id))

const card = (requester: string, target: string, status = 'suggested', createdAt = '2026-08-20T10:00:00Z') =>
  ({ id: `${requester}-${target}`, requester_id: requester, target_user_id: target, status, created_at: createdAt })

async function postCatchup(body: any, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  const { POST } = await import('@/app/api/admin/reminders/unanswered-intros-catchup/route')
  const req = new Request('https://www.andrel.app/api/admin/reminders/unanswered-intros-catchup', {
    method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const res = await POST(req)
  return { res, json: await res.json() }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('PART 1 — catch-up: accepted request shapes are a whitelist', () => {
  it('accepts exactly the three documented shapes', () => {
    expect(parseCatchupBody({ dryRun: true })).toEqual({ ok: true, mode: { kind: 'dry_run' } })
    expect(parseCatchupBody({ dryRun: false, testRecipient: 'a@b.co' }))
      .toEqual({ ok: true, mode: { kind: 'test_recipient', email: 'a@b.co' } })
    expect(parseCatchupBody({ dryRun: false, confirmFullCampaign: true }))
      .toEqual({ ok: true, mode: { kind: 'full_campaign' } })
  })

  it('rejects arrays, non-objects and null', () => {
    for (const bad of [[], [{ dryRun: true }], null, 'dryRun', 7, true]) {
      expect(parseCatchupBody(bad as any).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('rejects extra keys, including ones that smuggle a cohort or a date', () => {
    for (const bad of [
      { dryRun: true, extra: 1 },
      { dryRun: false, confirmFullCampaign: true, cohort: 'all' },
      { dryRun: false, testRecipient: 'a@b.co', since: '2026-01-01' },
      { dryRun: false, confirmFullCampaign: true, campaignKey: 'other-key' },
      { dryRun: false, userIds: ['3f6c…'] },
      { dryRun: false, memberId: '11111111-1111-4111-8111-111111111111' },
    ]) {
      expect(parseCatchupBody(bad as any).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('refuses a full campaign that was not explicitly confirmed', () => {
    expect(parseCatchupBody({ dryRun: false }).ok).toBe(false)
    expect(parseCatchupBody({ dryRun: false, confirmFullCampaign: false }).ok).toBe(false)
  })

  it('refuses a wildcard, a list, or a non-exact test recipient', () => {
    for (const bad of ['*', '*@example.com', 'a@b.co,c@d.co', 'a@b.co c@d.co', '%', 'nope', '']) {
      expect(parseCatchupBody({ dryRun: false, testRecipient: bad }).ok, bad).toBe(false)
    }
  })

  it('never accepts the campaign key from the caller — it is fixed in server code', () => {
    expect(CATCHUP_CAMPAIGN_KEY).toBe('unanswered-intros-catchup-2026-08-20')
    expect(ROUTE_SRC).toMatch(/cycleKey: CATCHUP_CAMPAIGN_KEY/)
    // the body parser has no key for it at all
    expect(parseCatchupBody({ dryRun: false, confirmFullCampaign: true, cycleKey: 'x' } as any).ok).toBe(false)
  })
})

describe('PART 1 — catch-up: authorization precedes everything', () => {
  it('is POST-only: no other HTTP verb is exported', () => {
    for (const verb of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      expect(ROUTE_SRC).not.toMatch(new RegExp(`export async function ${verb}\\b`))
    }
    expect(ROUTE_SRC).toMatch(/export async function POST\(/)
  })

  it('checks same-origin, then admin, BEFORE creating a service-role client or reading the body', () => {
    const iOrigin = ROUTE_SRC.indexOf('assertSameOrigin(req)')
    const iAdmin = ROUTE_SRC.indexOf('await requireAdmin()')
    const iClient = ROUTE_SRC.indexOf('createAdminClient()')
    const iBody = ROUTE_SRC.indexOf('await req.json()')
    expect(iOrigin).toBeGreaterThan(-1)
    expect(iOrigin).toBeLessThan(iAdmin)
    expect(iAdmin).toBeLessThan(iBody)     // no body parsing before authorization
    expect(iAdmin).toBeLessThan(iClient)   // no service-role client before authorization
  })

  it('rejects a cross-origin request', async () => {
    const { NextResponse } = await import('next/server')
    h.sameOrigin = NextResponse.json({ error: 'x' }, { status: 403 })
    const { res } = await postCatchup({ dryRun: true })
    expect(res.status).toBe(403)
    expect(h.emails).toHaveLength(0)
  })

  it('rejects a non-admin', async () => {
    const { NextResponse } = await import('next/server')
    h.adminError = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const { res } = await postCatchup({ dryRun: true })
    expect(res.status).toBe(403)
    expect(h.emails).toHaveLength(0)
  })

  it('rejects a non-JSON content type and malformed JSON', async () => {
    const a = await postCatchup({ dryRun: true }, { 'content-type': 'application/x-www-form-urlencoded' })
    expect(a.res.status).toBe(415)
    const b = await postCatchup('{not json', { 'content-type': 'application/json' })
    expect(b.res.status).toBe(400)
    expect(h.emails).toHaveLength(0)
  })

  it('sets Cache-Control: no-store on every response', async () => {
    const { NextResponse } = await import('next/server')
    const ok = await postCatchup({ dryRun: true })
    expect(ok.res.headers.get('cache-control')).toBe('no-store')
    const bad = await postCatchup({ dryRun: false, nope: 1 })
    expect(bad.res.headers.get('cache-control')).toBe('no-store')
    h.sameOrigin = NextResponse.json({ error: 'x' }, { status: 403 })
    const denied = await postCatchup({ dryRun: true })
    expect(denied.res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('PART 1 — catch-up: who qualifies', () => {
  beforeEach(() => {
    h.profiles.push(member('m1'), member('m2'), member('m3'), member('m4'), member('m5'), ...activeTargets())
  })

  it('includes reciprocal AND legacy/admin suggested cards, one consolidated email each', async () => {
    h.introRows.push(card('m1', 'x'), card('m1', 'y'))   // two open cards, one member
    h.introRows.push(card('m2', 'z'))                     // legacy one-sided
    const { json } = await postCatchup({ dryRun: false, confirmFullCampaign: true })
    expect(json.sent).toBe(2)
    expect(h.emails.filter((e) => e.kind === 'wednesday')).toHaveLength(2)
    expect(h.emails.find((e) => e.to === 'm1@example.com').n).toBe(2)  // consolidated, not two mails
  })

  it('excludes a member whose only state is a private interest, or a closed card', async () => {
    h.introRows.push(card('m1', 'x', 'pending'))         // own interest = a response, not an open card
    h.introRows.push(card('m2', 'y', 'approved'))
    h.introRows.push(card('m3', 'z', 'passed'))
    h.introRows.push(card('m4', 'w', 'expired'))
    const { json } = await postCatchup({ dryRun: false, confirmFullCampaign: true })
    expect(json.sent).toBe(0)
    expect(h.emails).toHaveLength(0)
  })

  it('excludes a member who already responded to the same counterpart', async () => {
    h.introRows.push(card('m1', 'x'), { ...card('m1', 'x', 'approved'), id: 'resp' })
    const { json } = await postCatchup({ dryRun: false, confirmFullCampaign: true })
    expect(json.sent).toBe(0)
  })

  it('excludes inactive, incomplete, test, admin, paused and unusable-email accounts', async () => {
    h.profiles.length = 0
    h.profiles.push(
      member('a', { account_status: 'paused' }), member('b', { profile_complete: false }),
      member('c', { is_test_account: true }), member('d', { is_admin: true }),
      member('e', { matching_paused: true }), member('f', { email: null }),
      ...activeTargets(),
    )
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) h.introRows.push(card(id, 'target'))
    const { json } = await postCatchup({ dryRun: false, confirmFullCampaign: true })
    expect(json.sent).toBe(0)
    expect(Object.keys(json.skipped).sort()).toEqual(
      ['admin_account', 'incomplete_profile', 'inactive', 'matching_paused', 'no_email', 'test_account'].sort())
  })

  it('pages the read to exhaustion (more than one page of rows)', async () => {
    for (let i = 0; i < 1200; i++) h.introRows.push(card(`p${String(i).padStart(4, '0')}`, 't'))
    h.profiles.push(...h.introRows.map((r) => member(r.requester_id)), ...activeTargets())
    const { json } = await postCatchup({ dryRun: true })
    expect(json.eligibleTotal).toBe(1200)   // would be 1000 if paging stopped at one page
  })

  it('FAILS CLOSED on a read error — nothing is sent', async () => {
    h.introRows.push(card('m1', 'x'))
    h.failIntroRead = true
    const { res, json } = await postCatchup({ dryRun: false, confirmFullCampaign: true })
    expect(res.status).toBe(503)
    expect(json.failClosed).toBe(true)
    expect(h.emails).toHaveLength(0)
  })
})

describe('PART 1 — catch-up: modes, dedupe and retry', () => {
  beforeEach(() => {
    h.profiles.push(member('m1'), member('m2'), ...activeTargets())
    h.introRows.push(card('m1', 'x'), card('m2', 'y'))
  })

  it('a dry run sends nothing and writes no claim', async () => {
    const { json } = await postCatchup({ dryRun: true })
    expect(json.mode).toBe('dry_run')
    expect(json.eligibleTotal).toBe(2)
    expect(h.emails).toHaveLength(0)
    expect(h.deliveries).toHaveLength(0)
  })

  it('test-recipient mode sends exactly one, to exactly that address', async () => {
    const { json } = await postCatchup({ dryRun: false, testRecipient: 'm2@example.com' })
    expect(json.sent).toBe(1)
    expect(h.emails).toHaveLength(1)
    expect(h.emails[0].to).toBe('m2@example.com')
  })

  it('repeated calls dedupe durably — no duplicate send', async () => {
    const first = await postCatchup({ dryRun: false, confirmFullCampaign: true })
    expect(first.json.sent).toBe(2)
    const second = await postCatchup({ dryRun: false, confirmFullCampaign: true })
    expect(second.json.sent).toBe(0)
    expect(second.json.skipped.already_sent).toBe(2)
    expect(h.emails).toHaveLength(2)              // still two, not four
  })

  it('a provider failure stays retryable: the row is marked failed, outside the active claim', async () => {
    h.emailThrows = true
    const { json } = await postCatchup({ dryRun: false, confirmFullCampaign: true })
    expect(json.failed).toBe(2)
    expect(h.deliveries.every((d) => d.status === 'failed')).toBe(true)
    h.emailThrows = false
    const retry = await postCatchup({ dryRun: false, confirmFullCampaign: true })
    expect(retry.json.sent).toBe(2)               // 'failed' is outside the claim index
  })

  it('does NOT consume next Wednesday\'s dedupe key — different purpose entirely', async () => {
    await postCatchup({ dryRun: false, confirmFullCampaign: true })
    expect(h.deliveries.every((d) => d.purpose === CATCHUP_UNANSWERED)).toBe(true)
    expect(h.deliveries.some((d) => d.purpose === WEDNESDAY_UNANSWERED)).toBe(false)
    expect(CATCHUP_UNANSWERED).not.toBe(WEDNESDAY_UNANSWERED)
  })

  it('the response carries no identifier — only first name, masked email, class and outcome', async () => {
    const { json } = await postCatchup({ dryRun: true })
    for (const r of json.recipients) {
      expect(Object.keys(r).sort()).toEqual(['classification', 'email', 'firstName', 'outcome'])
      expect(r.email).not.toMatch(/^m\d@example\.com$/)   // masked, not the real address
      expect(r.email).toMatch(/\*/)
    }
    expect(JSON.stringify(json)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i)  // no UUIDs
  })

  it('masks addresses without destroying recognisability', () => {
    expect(maskEmail('daniel@example.com')).toBe('d****l@example.com')
    expect(maskEmail('ab@x.co')).toBe('a***@x.co')
    expect(maskEmail(null)).toBe('(no email)')
  })

  it('logs aggregates only', () => {
    const logs = ROUTE_SRC.split('\n').filter((l) => /console\.(log|error|warn)/.test(l))
    expect(logs.length).toBeGreaterThan(0)
    for (const l of logs) {
      expect(l).not.toMatch(/\$\{(memberId|p\.email|prof|userId|memberToAnnounce)\b/)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
const OUTBOX_SQL = readFileSync('supabase/migrations/070_introduction_email_outbox.sql', 'utf8')
const ev = (id: string, cardId: string, memberId: string, over: any = {}) =>
  ({ id, intro_request_id: cardId, member_id: memberId, status: 'pending', attempt_count: 0,
     claim_token: null, claimed_at: null, claim_expires_at: null, processed_at: null,
     last_error_class: null, created_at: '2026-08-20T10:00:00Z', ...over })

describe('PART 2 — the outbox is written by the database, not by the sender', () => {
  it('the trigger writes the event inside the writer transaction, so a card cannot commit alone', () => {
    expect(OUTBOX_SQL).toMatch(/AFTER INSERT OR UPDATE OF status ON public\.intro_requests/)
    expect(OUTBOX_SQL).toMatch(/FOR EACH ROW/)
    // the guard: born visible, or transitioning INTO visibility — never suggested -> suggested
    expect(OUTBOX_SQL).toMatch(/IF NEW\.status = 'suggested' THEN/)
    expect(OUTBOX_SQL).toMatch(/NEW\.status = 'suggested' AND OLD\.status IS DISTINCT FROM 'suggested'/)
  })

  it('one durable event per directional card, enforced by a unique index on the artifact', () => {
    expect(OUTBOX_SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS introduction_email_outbox_card_uniq\s*\n\s*ON public\.introduction_email_outbox \(intro_request_id\)/)
    expect(OUTBOX_SQL).toMatch(/ON CONFLICT \(intro_request_id\) DO NOTHING/)
  })

  it('performs NO backfill, so the existing suggested cards produce no event and no blast', () => {
    expect(OUTBOX_SQL).not.toMatch(/INSERT INTO public\.introduction_email_outbox[\s\S]{0,200}SELECT/i)
    expect(OUTBOX_SQL).toMatch(/generate exactly/)   // header wraps; match a single line
    expect(OUTBOX_SQL).toMatch(/zero outbox events and exactly zero automatic emails/)
  })

  it('is service-role only, RLS on with no policies, and stores no message content', () => {
    expect(OUTBOX_SQL).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(OUTBOX_SQL).not.toMatch(/CREATE POLICY/)
    expect(OUTBOX_SQL).toMatch(/REVOKE ALL ON TABLE public\.introduction_email_outbox FROM PUBLIC/)
    expect(OUTBOX_SQL).toMatch(/REVOKE ALL ON TABLE public\.introduction_email_outbox FROM anon, authenticated/)
    expect(OUTBOX_SQL).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE public\.introduction_email_outbox TO service_role/)
    expect(OUTBOX_SQL).toMatch(/SECURITY DEFINER/)
    expect(OUTBOX_SQL).toMatch(/SET search_path = ''/)
    for (const forbidden of ['subject', 'html', 'body text', 'full_name', 'provider_payload']) {
      expect(OUTBOX_SQL.slice(OUTBOX_SQL.indexOf('CREATE TABLE'), OUTBOX_SQL.indexOf('COMMENT ON TABLE'))).not.toContain(forbidden)
    }
  })

  it('does NOT restore service_role access to the raw delegate that migration 068 removed', () => {
    const code = OUTBOX_SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(code).not.toMatch(/consume_credits_and_create_match/)
    const m069 = readFileSync('supabase/migrations/069_delivery_purposes_and_event_key.sql', 'utf8')
    expect(m069).not.toMatch(/consume_credits_and_create_match/)
  })
})

describe('PART 2 — worker: consolidation, recovery and re-reading', () => {
  beforeEach(() => { h.profiles.push(member('m1'), member('m2'), ...activeTargets()) })

  it('sends one consolidated email for two cards committed in one operation', async () => {
    h.introRows.push(card('m1', 'x'), card('m1', 'y'))
    h.outbox.push(ev('e1', 'm1-x', 'm1'), ev('e2', 'm1-y', 'm1'))
    const s = await drainIntroductionOutbox(fakeAdmin())
    expect(s.sent).toBe(2)                        // two events settled...
    expect(h.emails).toHaveLength(1)              // ...by ONE email
    expect(h.outbox.every((o: any) => o.status === 'sent')).toBe(true)
  })

  it('RECOVERS a post-commit crash: the event is already durable, the scheduled drain sends it', async () => {
    // exactly the old gap — card committed, process died before any application sender ran
    h.introRows.push(card('m1', 'x'))
    h.outbox.push(ev('e1', 'm1-x', 'm1'))
    expect(h.emails).toHaveLength(0)
    const s = await drainIntroductionOutbox(fakeAdmin())
    expect(s.sent).toBe(1)
    expect(h.emails).toHaveLength(1)
  })

  it('re-reads committed rows and sends nothing when the card is no longer visible', async () => {
    h.introRows.push(card('m1', 'x', 'expired'))
    h.outbox.push(ev('e1', 'm1-x', 'm1'))
    const s = await drainIntroductionOutbox(fakeAdmin())
    expect(s.sent).toBe(0)
    expect(s.skipped).toBe(1)
    expect(h.outbox[0].last_error_class).toBe('no_longer_visible')
    expect(h.emails).toHaveLength(0)
  })

  it('an expiring card never produces a new email — no event, nothing to drain', async () => {
    h.introRows.push(card('m1', 'x'), card('m1', 'y'))
    h.outbox.push(ev('e1', 'm1-x', 'm1'), ev('e2', 'm1-y', 'm1'))
    await drainIntroductionOutbox(fakeAdmin())
    expect(h.emails).toHaveLength(1)
    h.introRows[1].status = 'expired'             // a card closes; the trigger writes nothing
    const s = await drainIntroductionOutbox(fakeAdmin())
    expect(s.sent).toBe(0)
    expect(h.emails).toHaveLength(1)
  })

  it('two workers cannot double-send: the second wins nothing', async () => {
    h.introRows.push(card('m1', 'x'))
    h.outbox.push(ev('e1', 'm1-x', 'm1'))
    const [a, b] = await Promise.all([drainIntroductionOutbox(fakeAdmin()), drainIntroductionOutbox(fakeAdmin())])
    expect(a.sent + b.sent).toBeGreaterThan(0)
    expect(h.emails).toHaveLength(1)              // the event-keyed delivery claim is the backstop
    expect(h.deliveries.filter((d: any) => d.purpose === NEW_INTRODUCTIONS)).toHaveLength(1)
  })

  it('a second drain after a completed send does nothing', async () => {
    h.introRows.push(card('m1', 'x'))
    h.outbox.push(ev('e1', 'm1-x', 'm1'))
    await drainIntroductionOutbox(fakeAdmin())
    const again = await drainIntroductionOutbox(fakeAdmin())
    expect(again.sent).toBe(0)
    expect(h.emails).toHaveLength(1)
  })

  it('a provider failure leaves events retryable and does not settle them', async () => {
    h.introRows.push(card('m1', 'x'))
    h.outbox.push(ev('e1', 'm1-x', 'm1'))
    h.emailThrows = true
    const s = await drainIntroductionOutbox(fakeAdmin())
    expect(s.failed).toBe(1)
    expect(h.outbox[0].status).toBe('pending')    // back in the queue
    expect(h.outbox[0].last_error_class).toBe('provider_error')
  })

  it('provider acceptance completes exactly the events it announced', async () => {
    h.introRows.push(card('m1', 'x'), card('m2', 'z'))
    h.outbox.push(ev('e1', 'm1-x', 'm1'), ev('e2', 'm2-z', 'm2'))
    await drainIntroductionOutbox(fakeAdmin())
    expect(h.emails).toHaveLength(2)              // two members, two emails
    expect(h.outbox.map((o: any) => o.status)).toEqual(['sent', 'sent'])
    expect(h.deliveries).toHaveLength(2)
  })

  it('skips an ineligible member without sending or spinning', async () => {
    h.profiles.length = 0; h.profiles.push(member('m1', { matching_paused: true }))
    h.introRows.push(card('m1', 'x'))
    h.outbox.push(ev('e1', 'm1-x', 'm1'))
    const s = await drainIntroductionOutbox(fakeAdmin())
    expect(s.skipped).toBe(1)
    expect(h.outbox[0].last_error_class).toBe('ineligible')
    expect(h.emails).toHaveLength(0)
  })

  it('a private-interest transition sends nothing — no event exists to drain', async () => {
    h.introRows.push(card('m1', 'x', 'pending'), card('m2', 'y', 'approved'))
    const s = await drainIntroductionOutbox(fakeAdmin())
    expect(s.scanned).toBe(0)
    expect(h.emails).toHaveLength(0)
  })

  it('historical pre-migration cards produce no automatic email', async () => {
    // the trigger did not exist when they were written, so there is no event — the drain is empty
    for (let i = 0; i < 50; i++) h.introRows.push(card('m1', `old${i}`))
    const s = await drainIntroductionOutbox(fakeAdmin())
    expect(s.scanned).toBe(0)
    expect(h.emails).toHaveLength(0)
  })

  it('fails closed on an uncertain read and releases nothing it cannot service', async () => {
    h.introRows.push(card('m1', 'x'))
    h.outbox.push(ev('e1', 'm1-x', 'm1'))
    h.failIntroRead = true
    const s = await drainIntroductionOutbox(fakeAdmin())
    expect(s.readFailed || s.released > 0).toBe(true)
    expect(h.emails).toHaveLength(0)
  })

  it('is bounded and never unbounded-scans', async () => {
    for (let i = 0; i < 40; i++) {
      h.profiles.push(member(`b${i}`)); h.introRows.push(card(`b${i}`, 't'))
      h.outbox.push(ev(`e${i}`, `b${i}-t`, `b${i}`))
    }
    const s = await drainIntroductionOutbox(fakeAdmin(), { maxMembers: 5 })
    expect(s.sent).toBe(5)
    expect(s.truncated).toBe(true)
    expect(s.released).toBeGreaterThan(0)         // the rest handed back, not dropped
  })

  it('the event key is order-independent and derived from the committed artifacts', () => {
    expect(eventKeyForCards(['b', 'a'])).toBe(eventKeyForCards(['a', 'b']))
    expect(eventKeyForCards(['a'])).not.toBe(eventKeyForCards(['a', 'b']))
  })

  it('claims under new_introductions with an event key, week recorded but not authoritative', async () => {
    h.introRows.push(card('m1', 'x'))
    h.outbox.push(ev('e1', 'm1-x', 'm1'))
    await drainIntroductionOutbox(fakeAdmin())
    expect(h.deliveries[0].purpose).toBe(NEW_INTRODUCTIONS)
    expect(h.deliveries[0].event_key).toBeTruthy()
    expect(h.deliveries[0].cycle_key).toMatch(/^\d{4}-W\d{2}$/)
  })
})

describe('PART 2 — claim ownership: a lease, not a status', () => {
  const OUTBOX_TS = readFileSync('lib/introductions/newIntroductionOutbox.ts', 'utf8')
  const future = () => new Date(Date.now() + 10 * 60_000).toISOString()
  const past = () => new Date(Date.now() - 60_000).toISOString()

  beforeEach(() => { h.profiles.push(member('m1')); h.introRows.push(card('m1', 'x')) })

  it('claims ONLY pending or expired-lease rows — never a bare status IN (pending, claimed)', () => {
    // the racy form has no lease condition; worker B could overwrite A's fresh claim mid-delivery
    expect(OUTBOX_TS).not.toMatch(/\.in\('status', \['pending', 'claimed'\]\)[\s\S]{0,80}update/)
    const claim = OUTBOX_TS.slice(OUTBOX_TS.indexOf('// 2. CLAIM.'), OUTBOX_TS.indexOf('// 3. One email'))
    expect(claim).toMatch(/\.eq\('status', 'pending'\)/)
    expect(claim).toMatch(/\.eq\('status', 'claimed'\)[\s\S]{0,120}\.lt\('claim_expires_at', claimedAt\)/)
    expect(claim).toMatch(/randomUUID\(\)/)
  })

  it('CANNOT steal a fresh claim held by another worker', async () => {
    h.outbox.push(ev('e1', 'm1-x', 'm1', {
      status: 'claimed', claim_token: 'worker-A-token', claimed_at: nowish(), claim_expires_at: future(),
    }))
    const s = await drainIntroductionOutbox(fakeAdmin())
    expect(s.claimed).toBe(0)
    expect(h.emails).toHaveLength(0)
    expect(h.outbox[0].claim_token).toBe('worker-A-token')   // untouched
  })

  it('DOES reclaim a claim whose lease expired, minting a new token', async () => {
    h.outbox.push(ev('e1', 'm1-x', 'm1', {
      status: 'claimed', claim_token: 'dead-worker-token', claimed_at: past(), claim_expires_at: past(),
    }))
    const s = await drainIntroductionOutbox(fakeAdmin())
    expect(s.sent).toBe(1)
    expect(h.emails).toHaveLength(1)
    expect(h.outbox[0].claim_token).toBeNull()               // settled, lease cleared
    expect(h.outbox[0].status).toBe('sent')
  })

  it('every settle is token-scoped, through ONE choke point', () => {
    // a stale worker's update must match zero rows; that is only guaranteed if there is no other
    // write path. Assert the single helper, and that nothing else updates the table directly.
    expect(OUTBOX_TS).toMatch(/\.eq\('status', 'claimed'\)\s*\n\s*\.eq\('claim_token', token\)/)
    const updates = OUTBOX_TS.match(/\.from\(OUTBOX\)\s*\n?\s*\.update\(/g) ?? []
    expect(updates.length).toBe(3)   // settleOwned + the two claim predicates, nothing else
  })

  it('two concurrent workers racing on the same pending event send once', async () => {
    h.outbox.push(ev('e1', 'm1-x', 'm1'))
    const [a, b] = await Promise.all([drainIntroductionOutbox(fakeAdmin()), drainIntroductionOutbox(fakeAdmin())])
    expect(h.emails).toHaveLength(1)
    expect(a.sent + b.sent).toBeGreaterThanOrEqual(1)
    expect(h.deliveries.filter((d: any) => d.purpose === NEW_INTRODUCTIONS)).toHaveLength(1)
  })

  it('never logs a claim token or an identifier', () => {
    for (const line of OUTBOX_TS.split('\n')) {
      if (!/console\.(log|warn|error)/.test(line)) continue
      expect(line).not.toMatch(/token|memberId|intro_request_id|\$\{/)
    }
  })
})

describe('PART 2 — accepted-but-unsettled recovery vs the ambiguous boundary', () => {
  beforeEach(() => { h.profiles.push(member('m1')); h.introRows.push(card('m1', 'x')) })

  it('RECOVERS: provider accepted and recorded, crash before the outbox settled', async () => {
    // stage exactly that state: events still claimed (lease expired), ledger already 'accepted'
    const key = eventKeyForCards(['m1-x'])
    h.deliveries.push({
      id: 'd-prior', member_id: 'm1', purpose: NEW_INTRODUCTIONS, cycle_key: '2026-W34',
      event_key: key, status: 'accepted', provider_message_id: 'p-earlier',
      created_at: '2026-08-20T10:00:00Z',
    })
    h.outbox.push(ev('e1', 'm1-x', 'm1', {
      status: 'claimed', claim_token: 'dead-token',
      claimed_at: new Date(Date.now() - 60_000).toISOString(),
      claim_expires_at: new Date(Date.now() - 30_000).toISOString(),
    }))

    const s = await drainIntroductionOutbox(fakeAdmin())

    expect(h.emails).toHaveLength(0)                    // NOT re-sent
    expect(s.recovered).toBe(1)                         // finished by observing the accepted ledger
    expect(h.outbox[0].status).toBe('sent')             // no longer stuck
    expect(h.outbox[0].processed_at).toBeTruthy()
    expect(h.deliveries).toHaveLength(1)                // no second ledger row
  })

  it('the recovered event does not come back on a later run', async () => {
    const key = eventKeyForCards(['m1-x'])
    h.deliveries.push({ id: 'd', member_id: 'm1', purpose: NEW_INTRODUCTIONS, cycle_key: '2026-W34',
      event_key: key, status: 'accepted', created_at: '2026-08-20T10:00:00Z' })
    h.outbox.push(ev('e1', 'm1-x', 'm1', { status: 'claimed', claim_token: 't',
      claimed_at: new Date(Date.now() - 60_000).toISOString(),
      claim_expires_at: new Date(Date.now() - 30_000).toISOString() }))
    await drainIntroductionOutbox(fakeAdmin())
    const again = await drainIntroductionOutbox(fakeAdmin())
    expect(again.scanned).toBe(0)
    expect(h.emails).toHaveLength(0)
  })

  it('AMBIGUOUS is treated differently: ledger still claimed -> events released, not settled', async () => {
    const key = eventKeyForCards(['m1-x'])
    h.deliveries.push({ id: 'd', member_id: 'm1', purpose: NEW_INTRODUCTIONS, cycle_key: '2026-W34',
      event_key: key, status: 'claimed', created_at: '2026-08-20T10:00:00Z' })
    h.outbox.push(ev('e1', 'm1-x', 'm1'))
    const s = await drainIntroductionOutbox(fakeAdmin())
    expect(s.released).toBe(1)
    expect(s.recovered).toBe(0)
    expect(h.outbox[0].status).toBe('pending')          // retryable once the delivery lease resolves
    expect(h.emails).toHaveLength(0)
  })

  it('a provider THROW leaves the ledger claimed and the events retryable', async () => {
    h.outbox.push(ev('e1', 'm1-x', 'm1'))
    h.emailThrows = true
    const s = await drainIntroductionOutbox(fakeAdmin())
    expect(s.failed).toBe(1)
    expect(h.outbox[0].status).toBe('pending')
    expect(h.outbox[0].last_error_class).toBe('provider_error')
    expect(h.deliveries[0].status).toBe('claimed')      // NOT marked failed: it may have been sent
  })

  it('writes the ledger BEFORE settling the outbox, so the gap is the recoverable state', () => {
    const src = readFileSync('lib/introductions/newIntroductionOutbox.ts', 'utf8')
    const blk = src.slice(src.indexOf('if (res.sent) {'), src.indexOf('} else {', src.indexOf('if (res.sent) {')))
    expect(blk.indexOf('markAccepted')).toBeLessThan(blk.indexOf('settleOwned'))
  })

  it('a repeated accepted-state write is idempotent (webhook replay is harmless)', async () => {
    h.outbox.push(ev('e1', 'm1-x', 'm1'))
    await drainIntroductionOutbox(fakeAdmin())
    const before = JSON.stringify(h.deliveries)
    const { markAccepted } = await import('@/lib/reminders/deliveryLedger')
    await markAccepted(fakeAdmin(), h.deliveries[0].id, 'p2')   // replayed webhook
    expect(h.deliveries).toHaveLength(1)
    expect(h.deliveries[0].status).toBe('accepted')
    expect(before).not.toBe('')                                 // row updated in place, not duplicated
    expect(h.emails).toHaveLength(1)
  })
})

describe('PART 2 — consolidation is structural, not timing luck', () => {
  beforeEach(() => { h.profiles.push(member('m1')) })

  it('two cards created sequentially in ONE admin approval -> one email, one event key', async () => {
    // approve-batch materialises every pair FIRST, then announces; both events exist by drain time
    h.introRows.push(card('m1', 'a'), card('m1', 'b'))
    h.outbox.push(ev('e1', 'm1-a', 'm1'), ev('e2', 'm1-b', 'm1'))
    const s = await drainIntroductionOutbox(fakeAdmin(), { memberId: 'm1' })
    expect(h.emails).toHaveLength(1)
    expect(s.sent).toBe(2)
    const keys = new Set(h.deliveries.map((d: any) => d.event_key))
    expect(keys.size).toBe(1)
    expect(Array.from(keys)[0]).toBe(eventKeyForCards(['m1-a', 'm1-b']))
  })

  it('a SECOND drain for the same member after that approval sends nothing', async () => {
    h.introRows.push(card('m1', 'a'), card('m1', 'b'))
    h.outbox.push(ev('e1', 'm1-a', 'm1'), ev('e2', 'm1-b', 'm1'))
    await drainIntroductionOutbox(fakeAdmin(), { memberId: 'm1' })
    await drainIntroductionOutbox(fakeAdmin(), { memberId: 'm1' })   // second placed[] entry
    expect(h.emails).toHaveLength(1)
  })

  it('a promotion that makes several cards visible at once produces one email', async () => {
    h.introRows.push(card('m1', 'p'), card('m1', 'q'))
    h.outbox.push(ev('e1', 'm1-p', 'm1'), ev('e2', 'm1-q', 'm1'))
    await drainIntroductionOutbox(fakeAdmin(), { memberId: 'm1' })
    expect(h.emails).toHaveLength(1)
  })

  it('a reciprocal operation sends at most one email per member', async () => {
    h.profiles.push(member('m2'))
    h.introRows.push(card('m1', 'm2'), card('m2', 'm1'))
    h.outbox.push(ev('e1', 'm1-m2', 'm1'), ev('e2', 'm2-m1', 'm2'))
    await drainIntroductionOutbox(fakeAdmin())
    expect(h.emails).toHaveLength(2)
    expect(new Set(h.emails.map((e: any) => e.to)).size).toBe(2)
  })

  it('even if a drain runs mid-operation, the scheduled worker still covers the rest', async () => {
    // worst case: an eager drain fires after only the first card committed
    h.introRows.push(card('m1', 'a'))
    h.outbox.push(ev('e1', 'm1-a', 'm1'))
    await drainIntroductionOutbox(fakeAdmin(), { memberId: 'm1' })
    expect(h.emails).toHaveLength(1)
    // the second card commits afterwards; its durable event is still drained
    h.introRows.push(card('m1', 'b'))
    h.outbox.push(ev('e2', 'm1-b', 'm1'))
    const s = await drainIntroductionOutbox(fakeAdmin())
    expect(s.sent).toBe(1)
    expect(h.emails).toHaveLength(2)   // never LOST — consolidation is best-effort, delivery is not
  })
})

describe('PART 2 — writer coverage is a database fact, not a call-site list', () => {
  const ENGAGEMENT = readFileSync('lib/notifications/engagement.ts', 'utf8')
  const GENERATE = readFileSync('lib/generate-recommendations.ts', 'utf8')
  const CRON = readFileSync('app/api/cron/engagement-reminders/route.ts', 'utf8')

  it('the trigger keys on row state, so every writer is covered by construction', () => {
    // materialize_admin_pair / create_reciprocal_suggestion / place_batch_rows all INSERT
    // 'suggested'; promote_queued_rows UPDATEs into it. All four hit the same trigger, as would any
    // future writer, because none of them is named anywhere in it.
    for (const writer of ['materialize_admin_pair', 'create_reciprocal_suggestion',
                          'promote_queued_rows', 'place_batch_rows']) {
      // the FUNCTION BODY only — the trailing COMMENT lists the writers for human readers
      const body = OUTBOX_SQL.slice(OUTBOX_SQL.indexOf('AS $tg$'), OUTBOX_SQL.indexOf('$tg$;'))
      expect(body, writer).not.toContain(writer)
    }
    expect(OUTBOX_SQL).toMatch(/AFTER INSERT OR UPDATE OF status ON public\.intro_requests/)
  })

  it('the scheduled recovery stage runs in the already-registered cron route', () => {
    expect(CRON).toMatch(/PART 7: bounded DURABLE new-introduction outbox drain/)
    expect(CRON).toMatch(/drainIntroductionOutbox\(admin, \{ budgetMs: OUTBOX_STAGE_BUDGET_MS \}\)/)
    expect(CRON).toMatch(/intro_outbox_stage_failed/)          // coarse failure, never fatal
  })

  it('eager drains are promptness only — correctness does not depend on them', async () => {
    expect(ENGAGEMENT).toMatch(/drainForMember\(admin, memberId\)/)
    expect(GENERATE).toMatch(/drainForMember\(drainClient, memberToAnnounce\)/)
    const OUTBOX_TS = readFileSync('lib/introductions/newIntroductionOutbox.ts', 'utf8')
    expect(OUTBOX_TS).toMatch(/Best-effort immediate drain/)
    expect(OUTBOX_TS).toMatch(/correctness never depends|nothing depends on that|if this never runs/i)
  })

  it('in-app new_batch notifications are preserved; only the duplicate senders were retired', () => {
    expect(ENGAGEMENT).toMatch(/type: 'new_batch'/)
    expect(ENGAGEMENT).toMatch(/dedupeKey: `batch:\$\{batchId\}`/)
    for (const f of ['lib/notifications/engagement.ts', 'lib/generate-recommendations.ts',
                     'app/api/admin/approve-batch/route.ts']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/sendNewBatchEmail\(|sendAdminBatchReadyEmail\(/)
    }
  })

  it('no member or batch identifier reaches a log on any of these paths', () => {
    for (const f of ['lib/notifications/engagement.ts', 'lib/introductions/newIntroductionOutbox.ts',
                     'app/api/cron/engagement-reminders/route.ts']) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!/console\.(log|warn|error)/.test(line)) continue
        expect(line, `${f}: ${line.trim()}`).not.toMatch(/\$\{(memberId|batchId|queuedBatchId|userId|p\.email)\b/)
      }
    }
  })
})

describe('PART 2 — outbox privileges are least-privilege (migration 071)', () => {
  const M070 = readFileSync('supabase/migrations/070_introduction_email_outbox.sql', 'utf8')
  const M071 = readFileSync('supabase/migrations/071_outbox_service_role_least_privilege.sql', 'utf8')
  const AUDIT = readFileSync('supabase/audits/postapply_069_070.sql', 'utf8')

  it('071 REVOKES before granting — a narrow GRANT cannot remove a wide one', () => {
    const rev = M071.indexOf('REVOKE ALL\nON TABLE public.introduction_email_outbox\nFROM service_role;')
    const grant = M071.indexOf('GRANT SELECT, INSERT, UPDATE\nON TABLE public.introduction_email_outbox\nTO service_role;')
    expect(rev).toBeGreaterThan(-1)
    expect(grant).toBeGreaterThan(-1)
    expect(rev).toBeLessThan(grant)          // order is the whole fix
  })

  it('071 grants exactly SELECT, INSERT, UPDATE — never DELETE or TRUNCATE', () => {
    const code = M071.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    const grants = code.match(/GRANT[^;]+;/g) ?? []
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatch(/SELECT, INSERT, UPDATE/)
    expect(grants[0]).not.toMatch(/DELETE|TRUNCATE|ALL/)
    expect(grants[0]).toMatch(/TO service_role;/)
    expect(code).not.toMatch(/\b(anon|authenticated|PUBLIC)\b/)   // nothing widened for browser roles
  })

  it('071 self-verifies the contract and refuses to succeed on a mismatch', () => {
    expect(M071).toMatch(/DO \$\$/)
    for (const verb of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(M071, verb).toContain(`'${verb}'`)
    }
    expect(M071).toMatch(/RAISE EXCEPTION 'Outbox service_role privileges do not match the required contract'/)
    // the DELETE arm is the one WITHOUT a NOT — it must fail when the privilege is present
    const guard = M071.slice(M071.indexOf('DO $$'), M071.indexOf('END\n$$;'))
    expect(guard).toMatch(/OR has_table_privilege\(\s*\n?\s*'service_role',\s*\n?\s*'public\.introduction_email_outbox',\s*\n?\s*'DELETE'/)
  })

  it('071 explains the Supabase default-privilege cause', () => {
    expect(M071).toMatch(/A GRANT IS ADDITIVE/)
    expect(M071).toMatch(/ALTER DEFAULT PRIVILEGES/)
    expect(M071).toMatch(/born with DELETE/)
  })

  it('071 does not touch applied migrations or restore delegate access', () => {
    const code = M071.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(code).not.toMatch(/consume_credits_and_create_match/)
    expect(code).not.toMatch(/DROP|ALTER TABLE|CREATE /)
  })

  it('070 remains byte-for-byte as applied — 071 is additive, not an edit', () => {
    expect(createHash('sha256').update(readFileSync('supabase/migrations/070_introduction_email_outbox.sql')).digest('hex'))
      .toBe('a8298bfa56b92f5747dc75976e8e7f5d80f8142a38f1a528a0f4b1ea210f56cb')
    expect(createHash('sha256').update(readFileSync('supabase/migrations/069_delivery_purposes_and_event_key.sql')).digest('hex'))
      .toBe('6565de57a0d49ddb6de6ba2279a241789177ec4fe57f4828bdb2ad1fa9cbd311')
    // 070's own GRANT is left exactly as applied; the correction lives in 071
    expect(M070).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE public\.introduction_email_outbox TO service_role;/)
  })

  it('the post-apply audit checks all four verbs SEPARATELY', () => {
    for (const verb of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(AUDIT, verb).toContain(`'service_role privilege: ${verb}`)
    }
    // and asserts the correct polarity for each
    expect(AUDIT).toMatch(/'service_role privilege: DELETE \(must be denied\)',[\s\S]{0,140}'false'\)/)
    expect(AUDIT).toMatch(/'service_role privilege: SELECT',[\s\S]{0,140}'true'\)/)
  })

  it('the audit has no SQL relation or CTE named "visible" (English is fine)', () => {
    expect(AUDIT).not.toMatch(/\b(AS|FROM|JOIN|WITH)\s+visible\b/)
    expect(AUDIT).not.toMatch(/\bvisible\s+AS\s*\(/)
    expect(AUDIT).toMatch(/visible cards/)    // descriptive English retained
  })

  it('the worker never deletes an outbox row — settlement is a status change', () => {
    const OUTBOX_TS = readFileSync('lib/introductions/newIntroductionOutbox.ts', 'utf8')
    expect(OUTBOX_TS).not.toMatch(/\.delete\(\)/)
    expect(OUTBOX_TS).not.toMatch(/DELETE FROM/i)
  })
})

describe('PART 2 — copy', () => {
  it('is the approved copy, verbatim', () => {
    const c = newIntroductionsCopy('Daniel')
    expect(c.subject).toBe('New introductions are available in Andrel')
    expect(c.greeting).toBe('Hi Daniel,')
    expect(c.body).toBe('New curated introductions are available for you to review in Andrel.')
    expect(c.privacy).toBe('Your response remains private. A connection is made only when interest is mutual.')
    expect(c.cta).toBe('Review introductions')
    expect(c.closing).toEqual(['Best,', 'Daniel', 'Founder, Andrel'])
  })

  it('uses the canonical www URL', () => {
    expect(INTRODUCTIONS_URL).toBe('https://www.andrel.app/dashboard/introductions')
    const { html, text } = buildNewIntroductionsEmail('Jane')
    expect(html).toContain(INTRODUCTIONS_URL)
    expect(text).toContain(INTRODUCTIONS_URL)
    expect(html).not.toMatch(/https:\/\/andrel\.app/)   // the old sender's non-canonical link
  })

  it('falls back to a neutral greeting with no name', () => {
    expect(newIntroductionsCopy(null).greeting).toBe('Hi there,')
    expect(newIntroductionsCopy('   ').greeting).toBe('Hi there,')
  })

  it('identifies nobody, reveals no response, and states no count', () => {
    const { html, text } = buildNewIntroductionsEmail('Jane')
    for (const body of [html, text]) {
      expect(body).not.toMatch(/\b(responded|interested|expressed|accepted|declined|passed)\b/i)
      expect(body).not.toMatch(/\b\d+\s+(new\s+)?introduction/i)   // no count
      expect(body).not.toMatch(/\b(match|matched|connection is guaranteed|every week)\b/i)
    }
  })

  it('promises no match, no quality, and no weekly cadence', () => {
    const joined = JSON.stringify(newIntroductionsCopy('Jane'))
    // NB: 'Best,' is the required sign-off, so the claim words are matched without it
    expect(joined).not.toMatch(/guarantee|perfect|hand-?picked|every member|each week|will be matched|great match/i)
    expect(joined).toMatch(/only when interest is mutual/)
  })

  it('escapes a name that contains markup', () => {
    expect(buildNewIntroductionsEmail('<script>x</script>').html).not.toContain('<script>')
  })
})
