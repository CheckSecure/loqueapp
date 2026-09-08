import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

/**
 * CONNECTION EMAIL — ACTIONABLE CTA (Tier 2).
 *
 * The connection email's call to action was "View in Network", pointing at the member directory.
 * The useful next step after a connection is the MESSAGE, and the conversation already exists by the
 * time the email is sent — so the CTA is now "Start the conversation", deep-linked to that exact
 * thread, for every path that has a conversation to link to.
 *
 * The two admin callers (adminForceMatch, /api/admin/facilitate-intro) pass no conversation id and
 * must keep their existing Network destination byte-for-byte; the optional argument exists precisely
 * so this change cannot reach them. That compatibility is asserted here, not assumed.
 *
 * The URL is not a capability. /api/messages/conversations/[conversationId] authorizes on match
 * participation, so a deep link that reaches the wrong inbox opens nothing — see the security
 * assertions at the end.
 */

const sent = vi.hoisted(() => [] as any[])

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const b: any = {}
      b.select = () => b; b.eq = () => b; b.in = () => b
      // No suppression row, and no notification_preferences row → isPrefEnabled defaults to true.
      b.maybeSingle = async () => ({ data: null, error: null })
      b.then = (res: any, rej: any) => Promise.resolve({ data: [], error: null }).then(res, rej)
      return b
    },
  }),
}))

// Capture what would be handed to Resend instead of sending it.
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: async (payload: any) => { sent.push(payload); return { data: { id: 'e1' }, error: null } } }
  },
}))

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  sent.length = 0
  process.env = { ...ORIGINAL_ENV, RESEND_API_KEY: 'test-key', NEXT_PUBLIC_SITE_URL: 'https://www.andrel.app' }
  vi.resetModules()
})

/** Import fresh so the module reads the env set above. */
async function send(args: Parameters<typeof import('@/lib/email')['sendMatchCreatedEmail']>) {
  const { sendMatchCreatedEmail } = await import('@/lib/email')
  await (sendMatchCreatedEmail as any)(...args)
  return sent[sent.length - 1]
}

const CONV = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

describe('mutual-interest / opportunity connections: actionable CTA', () => {
  it('CTA reads "Start the conversation"', async () => {
    const mail = await send(['a@x.com', 'Alpha', 'Beta', 'GC', 'Acme', { conversationId: CONV }] as any)
    expect(mail.html).toContain('Start the conversation')
    expect(mail.html).not.toContain('View in Network')
  })

  it('links to the exact conversation on the canonical route', async () => {
    const mail = await send(['a@x.com', 'Alpha', 'Beta', 'GC', 'Acme', { conversationId: CONV }] as any)
    expect(mail.html).toContain(`https://www.andrel.app/dashboard/messages/${CONV}`)
  })

  it('uses getSiteUrl(), not a hardcoded host', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3000'
    vi.resetModules()
    const mail = await send(['a@x.com', 'Alpha', 'Beta', undefined, undefined, { conversationId: CONV }] as any)
    expect(mail.html).toContain(`http://localhost:3000/dashboard/messages/${CONV}`)
  })

  it("recipient A's email carries B's name, role and company", async () => {
    const mail = await send(['alpha@x.com', 'Alpha One', 'Beta Two', 'Partner', 'Skadden', { conversationId: CONV }] as any)
    expect(mail.to).toBe('alpha@x.com')
    expect(mail.html).toContain('Hi Alpha One')
    expect(mail.html).toContain('Beta Two')
    expect(mail.html).toContain('Partner at Skadden')
  })

  it("recipient B's email carries A's name — the mirror image", async () => {
    const mail = await send(['beta@x.com', 'Beta Two', 'Alpha One', 'GC', 'Acme', { conversationId: CONV }] as any)
    expect(mail.to).toBe('beta@x.com')
    expect(mail.html).toContain('Hi Beta Two')
    expect(mail.html).toContain('Alpha One')
  })
})

describe('admin callers are unaffected by the new optional argument', () => {
  it('omitting the conversation id preserves "View in Network" exactly', async () => {
    const mail = await send(['a@x.com', 'Alpha', 'Beta', 'GC', 'Acme'] as any)
    expect(mail.html).toContain('View in Network')
    expect(mail.html).toContain('https://andrel.app/dashboard/network')
    expect(mail.html).not.toContain('Start the conversation')
    expect(mail.html).not.toContain('/dashboard/messages/')
  })

  it('an explicitly null/undefined conversation id behaves the same as omitting it', async () => {
    for (const opts of [{ conversationId: null }, { conversationId: undefined }, {}]) {
      sent.length = 0
      const mail = await send(['a@x.com', 'Alpha', 'Beta', 'GC', 'Acme', opts] as any)
      expect(mail.html).toContain('View in Network')
    }
  })

  it('adminForceMatch still calls the helper with no conversation argument', () => {
    const src = readFileSync('app/actions.ts', 'utf8')
    const fn = src.slice(src.indexOf('export async function adminForceMatch'))
    const call = fn.slice(fn.indexOf('sendMatchCreatedEmail('), fn.indexOf('sendMatchCreatedEmail(') + 300)
    expect(call).not.toContain('conversationId')
  })

  it('/api/admin/facilitate-intro still calls the helper with no conversation argument', () => {
    const src = readFileSync('app/api/admin/facilitate-intro/route.ts', 'utf8')
    expect(src).toContain('sendMatchCreatedEmail(')
    // SCOPED TO THE CALL, as the adminForceMatch assertion above already is. The whole-file version
    // of this check started failing in Phase 3 Stage 1b for a reason that has nothing to do with
    // email: the route now reads `gated.conversationId` from create_gated_match. What the test
    // actually protects is that the EMAIL is sent without a conversation deep link, so it now looks
    // where that decision is made instead of anywhere the word appears.
    const from = src.indexOf('sendMatchCreatedEmail(')
    expect(src.slice(from, from + 600)).not.toContain('conversationId')
  })
})

describe('paths that must NOT send a peer-connection email', () => {
  const noEmail = (file: string) => {
    const src = readFileSync(file, 'utf8')
    expect(src, file).not.toContain('sendMatchCreatedEmail')
  }

  it('admin welcome flow does not send one', () => noEmail('lib/onboarding/welcomeFromAdmin.ts'))
  it('admin issue/support replies do not send one', () => noEmail('app/api/admin/issues/[id]/reply/route.ts'))
  // The simulator that this assertion used to guard has been REMOVED entirely
  // (chore/remove-simulate-matches). Its inability to email real members is now a
  // property of it not existing, which lib/__tests__/simulate-matches-removed.test.ts pins.
  it('the simulator that could have emailed real members no longer exists', () => {
    expect(existsSync('app/api/admin/simulate-matches/route.ts')).toBe(false)
  })
})

describe('no duplicate asynchronous connection-email path', () => {
  it('only the four intended call sites reference the helper', () => {
    const files = [
      'lib/introductions/finalizeMutualMatch.ts',
      'lib/opportunities/connect.ts',
      'app/actions.ts',
      'app/api/admin/facilitate-intro/route.ts',
    ]
    for (const f of files) expect(readFileSync(f, 'utf8')).toContain('sendMatchCreatedEmail')
  })

  it('no cron route sends a connection email', () => {
    for (const f of [
      'app/api/cron/daily-digest/route.ts',
      'app/api/cron/engagement-reminders/route.ts',
      'app/api/cron/admin-weekly-digest/route.ts',
      'app/api/cron/weekly-refresh/route.ts',
      'app/api/cron/nudge-reply/route.ts',
    ]) {
      expect(readFileSync(f, 'utf8'), f).not.toContain('sendMatchCreatedEmail')
    }
  })
})

describe('the deep link is not a capability', () => {
  it('the conversation API authorizes on match participation, not URL knowledge', () => {
    const src = readFileSync('app/api/messages/conversations/[conversationId]/route.ts', 'utf8')
    expect(src).toMatch(/match\.user_a_id !== user\.id && match\.user_b_id !== user\.id/)
    expect(src).toContain('403')
  })

  it('the canonical conversation route exists as a real page', () => {
    const src = readFileSync('app/dashboard/messages/[conversationId]/page.tsx', 'utf8')
    expect(src).toContain('useParams')
    expect(src).toContain('/api/messages/conversations/')
  })
})
