import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  JESSE_CAMPAIGN, RECIPIENTS, NOMINATOR, CAMPAIGN_KEY, REFERRAL_NOTE,
} from '@/lib/campaigns/jesseSolomonNomination'
import {
  maskEmail, classifyRecipient, runNominationCampaign, defineNominationCampaign,
  type NominationDeps, type DeliveryState,
} from '@/lib/campaigns/nominationEngine'
import { buildNominationInviteEmail } from '@/lib/email/nominationInvite'

const ROUTE = readFileSync('app/api/admin/campaigns/jesse-nomination/route.ts', 'utf8')
const HANDLER = readFileSync('lib/campaigns/campaignRouteHandler.ts', 'utf8')

/**
 * Strip comments so assertions test CODE, not explanatory prose that quotes the very thing being
 * banned (e.g. a comment saying "no CC/BCC"). Trailing comments are stripped too, while `https://`
 * is preserved by requiring the `//` not to follow a colon.
 */
const codeOnly = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

// ── The recipient set ────────────────────────────────────────────────────────

describe('Jesse campaign — exactly three recipients, exact names and addresses', () => {
  it('is exactly 3 unique lowercase recipients', () => {
    expect(RECIPIENTS).toHaveLength(3)
    const emails = RECIPIENTS.map((r) => r.email)
    expect(new Set(emails).size).toBe(3)
    expect(emails.every((e) => e === e.toLowerCase())).toBe(true)
  })

  it('carries the exact approved names and addresses', () => {
    expect(RECIPIENTS).toEqual([
      { firstName: 'Bill', fullName: 'Bill Martin', email: 'billmartin245@gmail.com' },
      { firstName: 'Mike', fullName: 'Mike O’Neill', email: 'michael.t.oneill@lilly.com' },
      { firstName: 'Mark', fullName: 'Mark Toskey', email: 'mark.toskey@takeda.com' },
    ])
  })

  it('names Jesse Solomon as nominator, and he is never a recipient', () => {
    expect(NOMINATOR.name).toBe('Jesse Solomon')
    expect(NOMINATOR.email).toBe('jsolomon@paulweiss.com')
    expect(RECIPIENTS.map((r) => r.email)).not.toContain(NOMINATOR.email)
  })

  it('uses the unique immutable campaign key and its own referral note', async () => {
    expect(CAMPAIGN_KEY).toBe('jesse-solomon-nomination-2026-08')
    expect(JESSE_CAMPAIGN.campaignKey).toBe(CAMPAIGN_KEY)
    expect(REFERRAL_NOTE).toBe('Jesse Solomon nomination campaign 2026-08')
    // Distinct from the James campaign in every identity field.
    const james = await import('@/lib/campaigns/jamesNomination')
    expect(CAMPAIGN_KEY).not.toBe(james.CAMPAIGN_KEY)
    expect(REFERRAL_NOTE).not.toBe(james.REFERRAL_NOTE)
  })

  it('never fabricates a nominator profile UUID', () => {
    expect((NOMINATOR as any).userId).toBeUndefined()
    expect(JESSE_CAMPAIGN.nominator.userId).toBeUndefined()
  })

  it('emails are treated case-insensitively (normalized at definition time)', () => {
    const c = defineNominationCampaign({
      campaignKey: 'k', nominator: { name: 'N', email: 'NOM@X.COM' }, referralNote: 'n',
      ccNominator: false, expectedRecipients: 1, email: { subject: 's', intro: 'i' },
      recipients: [{ firstName: 'A', email: '  Mixed.Case@Example.COM ' }, { firstName: 'A2', email: 'mixed.case@example.com' }],
    })
    expect(c.recipients).toEqual([{ firstName: 'A', email: 'mixed.case@example.com' }])
    expect(c.nominator.email).toBe('nom@x.com')
  })
})

describe('Jesse campaign — the list cannot be widened', () => {
  it('rejects an extra recipient, a bulk paste, or a wildcard via the count tripwire', () => {
    const base = {
      campaignKey: 'k', nominator: { name: 'N', email: 'n@x.com' }, referralNote: 'n',
      ccNominator: false, expectedRecipients: 3, email: { subject: 's', intro: 'i' },
    }
    expect(() => defineNominationCampaign({
      ...base,
      recipients: [
        { firstName: 'Bill', email: 'billmartin245@gmail.com' },
        { firstName: 'Mike', email: 'michael.t.oneill@lilly.com' },
        { firstName: 'Mark', email: 'mark.toskey@takeda.com' },
        { firstName: 'Extra', email: 'extra@x.com' },   // one more than approved
      ],
    })).toThrow(/does not match the approved 3/)
    expect(() => defineNominationCampaign({
      ...base, recipients: [{ firstName: 'Only', email: 'only@x.com' }],
    })).toThrow(/does not match the approved 3/)
  })

  it('drops the nominator if ever added to the list', () => {
    expect(defineNominationCampaign({
      campaignKey: 'k', nominator: { name: 'N', email: 'n@x.com' }, referralNote: 'n',
      ccNominator: false, expectedRecipients: 2, email: { subject: 's', intro: 'i' },
      recipients: [{ firstName: 'A', email: 'a@x.com' }, { firstName: 'N', email: 'n@x.com' }, { firstName: 'B', email: 'b@x.com' }],
    }).recipients.map((r) => r.email)).toEqual(['a@x.com', 'b@x.com'])
  })
})

// ── The email ────────────────────────────────────────────────────────────────

describe('Jesse campaign — email subject and body', () => {
  const built = (firstName: string) => buildNominationInviteEmail({
    nominatorName: JESSE_CAMPAIGN.nominator.name,
    intro: JESSE_CAMPAIGN.email.intro,
    subject: JESSE_CAMPAIGN.email.subject,
    firstName,
    link: 'https://andrel.app/auth/recover#token_hash=abc&type=magiclink',
  })

  it('uses the exact approved subject', () => {
    expect(JESSE_CAMPAIGN.email.subject).toBe('Jesse Solomon is inviting you to join Andrel')
    expect(built('Bill').subject).toBe('Jesse Solomon is inviting you to join Andrel')
  })

  it('greets each recipient by their own first name', () => {
    expect(built('Bill').text).toContain('Hi Bill,')
    expect(built('Mike').text).toContain('Hi Mike,')
    expect(built('Mark').text).toContain('Hi Mark,')
    expect(built('Bill').text).not.toContain('Hi Mike,')
  })

  it('reproduces the approved body copy', () => {
    const t = built('Bill').text
    expect(t).toContain('Jesse Solomon invited you to join Andrel, a private network for senior professionals and executives built around thoughtful, mutually valuable introductions.')
    expect(t).toContain('Members are connected through selective introductions based on their experience, interests, and goals. There are no public feeds and no cold outreach.')
    expect(t).toContain('The secure link below will set up your account:')
    expect(t).toContain('Create your Andrel account:')
    expect(t).toContain('Best,\nDaniel\nFounder, Andrel')
  })

  it('contains EXACTLY ONE account-setup CTA', () => {
    const b = built('Bill')
    expect((b.html.match(/Create your Andrel account/g) || []).length).toBe(1)
    expect((b.html.match(/<a href=/g) || []).length).toBe(1)
    expect((b.text.match(/Create your Andrel account/g) || []).length).toBe(1)
  })

  it('does not claim Jesse wrote the email — it is signed by Daniel', () => {
    const t = built('Bill').text
    expect(t).toMatch(/Jesse Solomon invited you/)   // third person
    expect(t).not.toMatch(/^From: Jesse/m)
    expect(t).not.toMatch(/Best,\s*\nJesse/)
    expect(t).toContain('Best,\nDaniel\nFounder, Andrel')
  })

  it('promises no admission, match, or particular introduction, and no password', () => {
    const t = built('Bill').text.toLowerCase()
    for (const claim of ['you have been accepted', 'you are approved', 'guaranteed', 'we will introduce you to', 'your match', 'admission']) {
      expect(t).not.toContain(claim)
    }
    expect(t).not.toMatch(/password/i)
  })

  it('exposes no other recipient in any recipient’s email', () => {
    for (const r of RECIPIENTS) {
      const b = built(r.firstName)
      for (const other of RECIPIENTS.filter((x) => x.email !== r.email)) {
        expect(b.text).not.toContain(other.email)
        expect(b.html).not.toContain(other.email)
        expect(b.text).not.toContain(other.fullName!)
      }
    }
  })
})

describe('Jesse campaign — no CC, no BCC, no additional recipient', () => {
  it('the campaign definition disables the nominator courtesy copy', () => {
    expect(JESSE_CAMPAIGN.ccNominator).toBe(false)
  })

  it('the handler omits the cc key entirely when ccNominator is false', () => {
    expect(HANDLER).toContain('...(campaign.ccNominator ? { cc: campaign.nominator.email } : {})')
    // The claim marker follows the same flag, so a no-CC send is never marked multi-recipient.
    expect(HANDLER).toContain('hasAdditionalRecipients: campaign.ccNominator')
  })

  it('nothing in the campaign or route introduces a bcc or extra recipient', () => {
    const src = readFileSync('lib/campaigns/jesseSolomonNomination.ts', 'utf8')
    for (const s of [src, ROUTE, HANDLER]) expect(codeOnly(s)).not.toMatch(/\bbcc\b/i)
    expect(codeOnly(src)).not.toMatch(/cc:/)
  })

  it('the email builder places exactly one address — the sender adds cc only when given', () => {
    const emailSrc = readFileSync('lib/email.ts', 'utf8')
    const fn = emailSrc.slice(emailSrc.indexOf('export async function sendNominationInviteEmail'))
    expect(fn).toContain('to: args.to')
    expect(fn).toContain('...(args.cc ? { cc: args.cc } : {})')
    expect(fn).not.toMatch(/bcc/i)
  })
})

// ── Engine behaviour with Jesse's definition ─────────────────────────────────

type Cfg = {
  auth?: Record<string, { count: number; user: { id: string; last_sign_in_at: string | null } | null }>
  profiles?: Set<string>
  waitlist?: Record<string, { id: string; status: string }>
  delivery?: Record<string, DeliveryState>
  mode?: 'off' | 'test' | 'on'
  allowlist?: Set<string>
  sendResult?: (email: string) => { sent: boolean; state: string; deliveryId: string | null; errorClass?: string }
}
const ds = (o: Partial<DeliveryState> = {}): DeliveryState => ({ suppressed: false, failed: false, active: false, ...o })
function harness(cfg: Cfg = {}) {
  const calls: any[] = []
  const rec = (name: string, args?: any) => calls.push({ name, args })
  const deps: NominationDeps = {
    lookupAuth: async (e) => cfg.auth?.[e] ?? { count: 0, user: null },
    hasProfile: async (uid) => !!cfg.profiles?.has(uid),
    findWaitlist: async (e) => cfg.waitlist?.[e] ?? null,
    deliveryState: async (e) => cfg.delivery?.[e] ?? ds(),
    ensureWaitlist: async (e, name) => { rec('ensureWaitlist', { e, name }); return `wl_${e}` },
    ensureReferral: async (nom, wid) => { rec('ensureReferral', { nom, wid }) },
    sendInvite: async (a) => { rec('sendInvite', a); return cfg.sendResult?.(a.email) ?? { sent: true, state: 'invited', deliveryId: `del_${a.email}` } },
    canSend: (e) => cfg.mode === 'on' ? true : cfg.mode === 'test' ? !!cfg.allowlist?.has(e) : false,
    mode: () => cfg.mode ?? 'on',
    log: (event, fields) => rec('log', { event, fields }),
  }
  return { deps, calls, of: (n: string) => calls.filter((c) => c.name === n) }
}

describe('Jesse campaign — dry run makes zero mutations and sends zero emails', () => {
  it('classifies all three and writes/sends nothing', async () => {
    const h = harness({ mode: 'on' })
    const r = await runNominationCampaign(JESSE_CAMPAIGN, h.deps, { dryRun: true })
    expect(r.dryRun).toBe(true)
    expect(r.recipients).toHaveLength(3)
    expect(h.of('sendInvite')).toHaveLength(0)
    expect(h.of('ensureWaitlist')).toHaveLength(0)
    expect(h.of('ensureReferral')).toHaveLength(0)
  })

  it('returns only masked addresses and classifications — no links, tokens, or raw addresses', async () => {
    const h = harness({ mode: 'on' })
    const r = await runNominationCampaign(JESSE_CAMPAIGN, h.deps, { dryRun: true })
    const blob = JSON.stringify(r)
    for (const rec of RECIPIENTS) {
      expect(blob).not.toContain(rec.email)
      expect(blob).toContain(maskEmail(rec.email))
    }
    expect(blob).not.toContain('jsolomon@paulweiss.com')
    expect(blob).not.toMatch(/token_hash|hashed_token|auth\/recover|re_[A-Za-z0-9]/)
    for (const x of r.recipients) expect(x.emailMasked).toMatch(/^.\*\*\*@/)
  })

  it('reports the required classifications', async () => {
    const classifications = {
      ready: harness({ mode: 'on' }),
      already_member: harness({ mode: 'on', auth: { 'billmartin245@gmail.com': { count: 1, user: { id: 'u', last_sign_in_at: '2026-01-01' } } } }),
      active_invite_exists: harness({ mode: 'on', waitlist: { 'billmartin245@gmail.com': { id: 'wl', status: 'invited' } } }),
      conflict: harness({ mode: 'on', auth: { 'billmartin245@gmail.com': { count: 2, user: null } } }),
    }
    for (const [expected, h] of Object.entries(classifications)) {
      const r = await runNominationCampaign(JESSE_CAMPAIGN, h.deps, { dryRun: true })
      const bill = r.recipients.find((x) => x.emailMasked === 'b***@gmail.com')!
      expect(bill.classification).toBe(expected === 'ready' ? 'ready' : expected)
    }
  })

  it('classifies an invalid address without throwing', async () => {
    expect(await classifyRecipient(harness().deps, 'not-an-email')).toBe('invalid')
  })
})

describe('Jesse campaign — duplicate account / active invite protection', () => {
  it('never sends to an existing account or an overlapping active invitation', async () => {
    const h = harness({
      mode: 'on',
      auth: { 'billmartin245@gmail.com': { count: 1, user: { id: 'u1', last_sign_in_at: '2026-01-01' } } },
      waitlist: { 'michael.t.oneill@lilly.com': { id: 'wl', status: 'invited' } },
    })
    const r = await runNominationCampaign(JESSE_CAMPAIGN, h.deps, { dryRun: false })
    const sent = h.of('sendInvite').map((c) => c.args.email)
    expect(sent).not.toContain('billmartin245@gmail.com')
    expect(sent).not.toContain('michael.t.oneill@lilly.com')
    expect(sent).toEqual(['mark.toskey@takeda.com'])
    expect(r.summary).toMatchObject({ already_member: 1, active_invite_exists: 1, sent: 1 })
    // No waitlist row is created for a skipped recipient → no duplicate account.
    expect(h.of('ensureWaitlist').map((c) => c.args.e)).toEqual(['mark.toskey@takeda.com'])
  })

  it('an active delivery claim also blocks a send', async () => {
    const h = harness({ mode: 'on', delivery: { 'mark.toskey@takeda.com': ds({ active: true }) } })
    await runNominationCampaign(JESSE_CAMPAIGN, h.deps, { dryRun: false })
    expect(h.of('sendInvite').map((c) => c.args.email)).not.toContain('mark.toskey@takeda.com')
  })
})

describe('Jesse campaign — execution, idempotency, partial failure', () => {
  it('sends one isolated invite per ready recipient, attribution first', async () => {
    const h = harness({ mode: 'on' })
    const r = await runNominationCampaign(JESSE_CAMPAIGN, h.deps, { dryRun: false })
    expect(h.of('sendInvite')).toHaveLength(3)
    expect(new Set(h.of('sendInvite').map((c) => c.args.email)).size).toBe(3)
    expect(r.summary.sent).toBe(3)
    expect(h.calls.findIndex((c) => c.name === 'ensureReferral'))
      .toBeLessThan(h.calls.findIndex((c) => c.name === 'sendInvite'))
    // The waitlist record gets the FULL name; the email greeting uses the first name.
    expect(h.of('ensureWaitlist').map((c) => c.args.name)).toEqual(['Bill Martin', 'Mike O’Neill', 'Mark Toskey'])
    expect(h.of('sendInvite').map((c) => c.args.firstName)).toEqual(['Bill', 'Mike', 'Mark'])
  })

  it('a retry never resends a recipient the claim already succeeded for', async () => {
    // Second run: the delivery claim reports an in-flight/!completed active claim → already_processed.
    const h = harness({ mode: 'on', sendResult: () => ({ sent: false, state: 'pending', deliveryId: 'd' }) })
    const r = await runNominationCampaign(JESSE_CAMPAIGN, h.deps, { dryRun: false })
    expect(r.summary.already_processed).toBe(3)
    expect(r.summary.sent).toBeUndefined()
  })

  it('an ambiguous dispatch is never auto-resent — it surfaces for manual review', async () => {
    const h = harness({ mode: 'on', sendResult: () => ({ sent: false, state: 'uncertain', deliveryId: 'd' }) })
    const r = await runNominationCampaign(JESSE_CAMPAIGN, h.deps, { dryRun: false })
    expect(r.summary.ambiguous_review).toBe(3)
  })

  it('one recipient failing does not stop the others', async () => {
    const h = harness({
      mode: 'on',
      sendResult: (e) => e === 'michael.t.oneill@lilly.com'
        ? { sent: false, state: 'error', deliveryId: null, errorClass: 'provider_error' }
        : { sent: true, state: 'invited', deliveryId: 'd' },
    })
    const r = await runNominationCampaign(JESSE_CAMPAIGN, h.deps, { dryRun: false })
    expect(r.summary.sent).toBe(2)
    expect(r.summary.send_failed).toBe(1)
    expect(h.of('sendInvite')).toHaveLength(3) // every recipient was still attempted
  })

  it('a single-recipient test sends to exactly one and skips the rest', async () => {
    const h = harness({ mode: 'on' })
    const r = await runNominationCampaign(JESSE_CAMPAIGN, h.deps, { dryRun: false, only: 'mark.toskey@takeda.com' })
    expect(h.of('sendInvite').map((c) => c.args.email)).toEqual(['mark.toskey@takeda.com'])
    expect(r.summary.skipped_not_selected).toBe(2)
  })

  it('INVITATIONS_MODE off sends nothing', async () => {
    const h = harness({ mode: 'off' })
    const r = await runNominationCampaign(JESSE_CAMPAIGN, h.deps, { dryRun: false })
    expect(h.of('sendInvite')).toHaveLength(0)
    expect(r.summary.skipped_paused).toBe(3)
  })

  it('attribution is created exactly once per nominee, and a retry cannot duplicate it', async () => {
    const h = harness({ mode: 'on' })
    await runNominationCampaign(JESSE_CAMPAIGN, h.deps, { dryRun: false })
    expect(h.of('ensureReferral')).toHaveLength(3)
    expect(new Set(h.of('ensureReferral').map((c) => c.args.wid)).size).toBe(3)
    // The handler's implementation is insert-if-absent, keyed on the nominee waitlist row.
    expect(HANDLER).toContain("from('referrals').select('id').eq('waitlist_id', waitlistId)")
    expect(HANDLER).toContain('if (existing) return')
  })
})

// ── Route + security posture ─────────────────────────────────────────────────

describe('Jesse campaign — route authorization and hardening', () => {
  it('the route is a thin wrapper over the shared handler — no forked implementation', () => {
    expect(ROUTE).toContain('handleNominationCampaignRequest(req, JESSE_CAMPAIGN')
    expect(ROUTE.split('\n').filter((l) => l.trim() && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).length).toBeLessThan(15)
    // No campaign logic duplicated into the route.
    expect(ROUTE).not.toMatch(/from\('waitlist'\)|from\('referrals'\)|generateLink|resend/i)
  })

  it('same-origin is enforced BEFORE admin authorization, then JSON-only', () => {
    expect(HANDLER.indexOf('assertSameOrigin(req)')).toBeLessThan(HANDLER.indexOf('requireAdmin()'))
    expect(HANDLER).toContain("Content-Type must be application/json")
  })

  it('GET is not allowed', () => {
    expect(ROUTE).toContain('methodNotAllowed()')
  })

  it('recipients are server-owned — no client list, array, or bulk expansion is accepted', () => {
    expect(HANDLER).not.toMatch(/body\.recipients|body\.emails|body\.to\b/)
    expect(HANDLER).toContain("Only { dryRun, testRecipient, confirmFullCampaign } are accepted")
    expect(HANDLER).toContain('Array.isArray(body)')
    expect(HANDLER).toContain('campaign.recipients.some((r) => r.email === target)')
  })

  it('execute is fail-closed: dry run is the default and needs an explicit selector to send', () => {
    expect(HANDLER).toContain('const dryRun = body.dryRun !== false')
    expect(HANDLER).toContain('Execute requires exactly one of testRecipient or confirmFullCampaign')
    expect(HANDLER).toContain('confirmFullCampaign must be exactly true for a full send')
  })

  it('fails closed when the multi-recipient safety column is unavailable', () => {
    expect(HANDLER).toContain("select('has_additional_recipients')")
    expect(HANDLER).toContain('Nothing was sent.')
  })

  it('no credits are touched anywhere in the campaign path', () => {
    for (const src of [ROUTE, HANDLER, readFileSync('lib/campaigns/jesseSolomonNomination.ts', 'utf8'), readFileSync('lib/campaigns/nominationEngine.ts', 'utf8')]) {
      expect(codeOnly(src)).not.toMatch(/meeting_credits|credit_transactions|deductCredit|free_credits/)
    }
  })

  it('no reminder or follow-up sequence is created by this campaign', () => {
    for (const src of [ROUTE, HANDLER, readFileSync('lib/campaigns/nominationEngine.ts', 'utf8')]) {
      expect(codeOnly(src)).not.toMatch(/sendInviteReminder|reminder|follow_?up|resend_?after/i)
    }
  })
})

describe('Jesse campaign — nothing sensitive reaches logs or responses', () => {
  it('per-recipient logs carry only coarse classification and outcome', async () => {
    const h = harness({ mode: 'on' })
    await runNominationCampaign(JESSE_CAMPAIGN, h.deps, { dryRun: false })
    for (const call of h.of('log')) {
      const blob = JSON.stringify(call.args)
      for (const rec of RECIPIENTS) {
        expect(blob).not.toContain(rec.email)
        expect(blob).not.toContain(rec.fullName!)
        expect(blob).not.toContain(rec.firstName)
      }
      expect(blob).not.toMatch(/token|link|secret|hashed/i)
    }
  })

  it('the handler logs no address, name, link, or token', () => {
    // Every console.log goes through the coarse `log(event, fields)` helper.
    const logs = HANDLER.match(/console\.log\([^)]*\)/g) || []
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('logPrefix')
    expect(HANDLER).not.toMatch(/console\.log\([^)]*email/)
  })

  it('the engine never returns an unmasked address', async () => {
    const h = harness({ mode: 'on' })
    const r = await runNominationCampaign(JESSE_CAMPAIGN, h.deps, { dryRun: false })
    // Masking deliberately keeps the domain; what must never appear is the local part.
    const blob = JSON.stringify(r)
    for (const local of ['billmartin245', 'michael.t.oneill', 'mark.toskey', 'jsolomon']) {
      expect(blob).not.toContain(local)
    }
  })
})

describe('James campaign is unaffected by the generalization', () => {
  it('keeps its key, 12 recipients, confirmed UUID, and CC behaviour', async () => {
    const james = await import('@/lib/campaigns/jamesNomination')
    expect(james.CAMPAIGN_KEY).toBe('james-kahrs-nomination-2026-08')
    expect(james.RECIPIENTS).toHaveLength(12)
    expect(james.NOMINATOR.userId).toBe('f9cf644b-1ee4-49cc-92bc-691145013d02')
    expect(james.JAMES_CAMPAIGN.ccNominator).toBe(true)
  })
})


// ── Blocker 2: the nominator gate must FAIL CLOSED ───────────────────────────

describe('Jesse attribution — fail-closed nominator gate', () => {
  it('requires exactly one active profile', async () => {
    const { evaluateNominator } = await import('@/lib/campaigns/nominatorGate')
    expect(evaluateNominator([{ id: 'u1', account_status: 'active' }])).toEqual({ ok: true, userId: 'u1' })
  })

  it('fails when Jesse is missing, ambiguous, inactive, or unreadable', async () => {
    const { evaluateNominator } = await import('@/lib/campaigns/nominatorGate')
    expect(evaluateNominator([])).toEqual({ ok: false, reason: 'not_found' })
    expect(evaluateNominator(null)).toEqual({ ok: false, reason: 'not_found' })
    expect(evaluateNominator([{ id: 'a', account_status: 'active' }, { id: 'b', account_status: 'active' }]))
      .toEqual({ ok: false, reason: 'ambiguous' })
    for (const status of ['deactivated', 'paused', 'suspended', null]) {
      expect(evaluateNominator([{ id: 'u1', account_status: status as any }]))
        .toEqual({ ok: false, reason: 'inactive' })
    }
    // A lookup ERROR is never read as "absent".
    expect(evaluateNominator(null, new Error('db down'))).toEqual({ ok: false, reason: 'lookup_failed' })
    expect(evaluateNominator([{ id: 'u1', account_status: 'active' }], new Error('db down')))
      .toEqual({ ok: false, reason: 'lookup_failed' })
  })

  it('applies the SAME active-account rule the referral system already enforces', () => {
    // /api/profile/complete awards the referral credit only for an active referrer…
    expect(readFileSync('app/api/profile/complete/route.ts', 'utf8'))
      .toContain("referrerProfile?.account_status !== 'active'")
    // …and referral-campaign eligibility uses the same rule.
    expect(readFileSync('lib/referralCampaign/eligibility.ts', 'utf8'))
      .toContain("m.account_status !== 'active'")
    expect(readFileSync('lib/campaigns/nominatorGate.ts', 'utf8'))
      .toContain("row.account_status !== 'active'")
  })

  it('the gate runs BEFORE any recipient is classified, mutated, or emailed', () => {
    const gateIdx = HANDLER.indexOf('const gate = await resolveNominatorGate()')
    const depsIdx = HANDLER.indexOf('const deps: NominationDeps = {')
    const runIdx = HANDLER.indexOf('await runNominationCampaign(campaign, deps')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeLessThan(depsIdx)   // before the write dependencies even exist
    expect(gateIdx).toBeLessThan(runIdx)    // and before a single recipient is touched
  })

  it('an execute with an unverified nominator returns 409 and processes nothing', () => {
    expect(HANDLER).toContain('if (!dryRun) return json({ error: NOMINATOR_GATE_ERROR, nominatorVerified: false, reason: gate.reason }, 409)')
    // The failure BRANCH (not the import) precedes every dependency that could write.
    const failIdx = HANDLER.indexOf('if (!dryRun) return json({ error: NOMINATOR_GATE_ERROR')
    expect(failIdx).toBeGreaterThan(-1)
    expect(failIdx).toBeLessThan(HANDLER.indexOf('const deps: NominationDeps = {'))
    expect(failIdx).toBeLessThan(HANDLER.indexOf("await admin.from('waitlist')"))
    expect(failIdx).toBeLessThan(HANDLER.indexOf('await sendSecureInvite(inviteDeps'))
  })

  it('never hardcodes a UUID — the server-owned email is resolved at run time', () => {
    const def = readFileSync('lib/campaigns/jesseSolomonNomination.ts', 'utf8')
    expect(def).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(HANDLER).toContain("ilike('email', likeLiteral(campaign.nominator.email))")
  })

  it('attribution can never be silently skipped — no null-referrer path remains', () => {
    expect(HANDLER).not.toMatch(/if \(!referrerId\) return/)
    expect(HANDLER).not.toMatch(/attribution_skipped/)
    expect(HANDLER).toContain("throw new Error('nominator not verified')")
  })

  it('the gate error exposes no email, UUID, or profile data', async () => {
    const { NOMINATOR_GATE_ERROR } = await import('@/lib/campaigns/nominatorGate')
    expect(NOMINATOR_GATE_ERROR).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}/i)
    expect(NOMINATOR_GATE_ERROR).toContain('Nothing was sent')
    // The log line carries only the coarse reason.
    expect(HANDLER).toContain("log('nominator_gate_failed', { reason: gate.reason, dryRun })")
  })

  it('a dry run surfaces the nominator status instead of hiding it', () => {
    expect(HANDLER).toContain('nominatorVerified: gate.ok')
    expect(HANDLER).toContain('nominatorReason: gate.reason')
  })
})

describe('Jesse campaign — Bill-first then full send cannot resend Bill', () => {
  it('the second run classifies Bill from his own delivery/waitlist evidence and skips him', async () => {
    // Run 1: Bill only.
    const h1 = harness({ mode: 'on' })
    await runNominationCampaign(JESSE_CAMPAIGN, h1.deps, { dryRun: false, only: 'billmartin245@gmail.com' })
    expect(h1.of('sendInvite').map((c) => c.args.email)).toEqual(['billmartin245@gmail.com'])

    // Run 2 (full): Bill now has an invited waitlist row + an active delivery claim.
    const h2 = harness({
      mode: 'on',
      waitlist: { 'billmartin245@gmail.com': { id: 'wl_bill', status: 'invited' } },
      delivery: { 'billmartin245@gmail.com': ds({ active: true }) },
    })
    const r2 = await runNominationCampaign(JESSE_CAMPAIGN, h2.deps, { dryRun: false })
    const sent = h2.of('sendInvite').map((c) => c.args.email)
    expect(sent).not.toContain('billmartin245@gmail.com')
    expect(sent).toEqual(['michael.t.oneill@lilly.com', 'mark.toskey@takeda.com'])
    expect(r2.summary.active_invite_exists).toBe(1)
    expect(r2.summary.sent).toBe(2)
    // No second referral row for Bill either.
    expect(h2.of('ensureReferral').map((c) => c.args.wid)).not.toContain('wl_bill')
  })
})
