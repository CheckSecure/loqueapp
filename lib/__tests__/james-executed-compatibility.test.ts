import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  RECIPIENTS, NOMINATOR, CAMPAIGN_KEY, REFERRAL_NOTE, JAMES_CAMPAIGN, runNominationCampaign,
  type NominationDeps, type DeliveryState,
} from '@/lib/campaigns/jamesNomination'
import { buildNominationInviteEmail } from '@/lib/email/nominationInvite'

/**
 * EXECUTED-CAMPAIGN COMPATIBILITY.
 *
 * The James Kahrs campaign ran successfully in production for all 12 recipients. Extracting the
 * generalized engine must therefore be provably inert: identical campaign key, identical recipients,
 * identical email, identical CC behaviour, and — critically — re-running the route must recognize the
 * already-invited/activated members and do nothing.
 */

const GOLDEN = JSON.parse(readFileSync('lib/__tests__/fixtures/james-executed-email.json', 'utf8'))
const ENGINE = readFileSync('lib/campaigns/nominationEngine.ts', 'utf8')

/** Strip comments so assertions test CODE, not prose that names the thing being checked for. */
const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const JAMES_ROUTE = readFileSync('app/api/admin/campaigns/james-nomination/route.ts', 'utf8')

describe('executed James campaign — identity is preserved exactly', () => {
  it('keeps the exact campaign key used by the executed run', () => {
    expect(CAMPAIGN_KEY).toBe('james-kahrs-nomination-2026-08')
    expect(JAMES_CAMPAIGN.campaignKey).toBe('james-kahrs-nomination-2026-08')
  })

  it('keeps the same 12 recipients, in the same order, with the same names', () => {
    expect(RECIPIENTS.map((r) => r.email)).toEqual([
      'bcoffee@sourceamerica.org', 'john.ustica@siemensgovt.com', 'jason@readysetlaunch.net',
      'mitchell.weintraub@cbh.com', 'dyson@foxsteadpartners.com', 'gklugh@falk-ventures.com',
      'jhathaway@jtekds.com', 'jim.waller@choreoadvisors.com', 'barry.murphy@merlinatlantic.com',
      'anthony.miller@cgsfederal.com', 'bobby.boucher@cgsfederal.com', 'lucas.miller@cgsfederal.com',
    ])
    expect(RECIPIENTS.map((r) => r.firstName)).toEqual([
      'Brett', 'John', 'Jason', 'Mitchell', 'Dyson', 'Garrett',
      'Jim', 'Jim', 'Barry', 'Anthony', 'Bobby', 'Lucas',
    ])
  })

  it('keeps the nominator identity, confirmed UUID, referral note, and CC behaviour', () => {
    expect(NOMINATOR.email).toBe('james.kahrs@cbh.com')
    expect(NOMINATOR.userId).toBe('f9cf644b-1ee4-49cc-92bc-691145013d02')
    expect(REFERRAL_NOTE).toBe('James Kahrs nomination campaign 2026-08')
    expect(JAMES_CAMPAIGN.ccNominator).toBe(true)
  })

  it('keeps full-name handling identical — James recipients carry no fullName, so the waitlist name is unchanged', () => {
    for (const r of RECIPIENTS) expect(r.fullName).toBeUndefined()
    // The engine falls back to firstName, which is exactly what the executed run wrote.
    expect(ENGINE).toContain('deps.ensureWaitlist(r.email, r.fullName ?? r.firstName)')
  })

  it('the executed route file is untouched by the generalization', () => {
    expect(JAMES_ROUTE).toContain('cc: NOMINATOR.email')
    expect(JAMES_ROUTE).toContain('hasAdditionalRecipients: true')
    expect(JAMES_ROUTE).toContain("select('has_additional_recipients')")
    expect(JAMES_ROUTE).toContain("from('referrals')")
    expect(JAMES_ROUTE).toContain('const dryRun = body.dryRun !== false')
  })
})

describe('executed James campaign — the email is byte-identical to what was sent', () => {
  it('reproduces the executed subject, HTML and text exactly', () => {
    const built = buildNominationInviteEmail({
      nominatorName: 'James Kahrs',
      intro: 'a private network for senior leaders across legal, government affairs, business, and executive leadership',
      subject: 'James Kahrs invited you to join Andrel',
      firstName: 'Brett',
      link: 'https://andrel.app/auth/recover#token_hash=TT&type=magiclink',
    })
    expect(built.subject).toBe('James Kahrs invited you to join Andrel')
    // Golden fixtures rendered from the pre-refactor lib/email.ts template at the executed commit.
    expect(built.html).toBe(GOLDEN.html)
    expect(built.text).toBe(GOLDEN.text)
  })

  it('the sender still defaults to James copy when no overrides are passed (the route passes none)', () => {
    const src = readFileSync('lib/email.ts', 'utf8')
    const fn = src.slice(src.indexOf('export async function sendNominationInviteEmail'))
    expect(fn).toContain("args.nominatorName ?? 'James Kahrs'")
    expect(fn).toContain("args.subject ?? 'James Kahrs invited you to join Andrel'")
    expect(fn).toContain("args.intro ?? 'a private network for senior leaders across legal, government affairs, business, and executive leadership'")
    expect(JAMES_ROUTE).not.toMatch(/nominatorName|subject:|intro:/) // route passes no overrides
  })
})

// ── Re-running the executed campaign must be inert ───────────────────────────

type Cfg = {
  auth?: Record<string, { count: number; user: { id: string; last_sign_in_at: string | null } | null }>
  profiles?: Set<string>
  waitlist?: Record<string, { id: string; status: string }>
  delivery?: Record<string, DeliveryState>
  mode?: 'off' | 'test' | 'on'
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
    sendInvite: async (a) => { rec('sendInvite', a); return { sent: true, state: 'invited', deliveryId: `del_${a.email}` } },
    canSend: () => true,
    mode: () => cfg.mode ?? 'on',
    log: (event, fields) => rec('log', { event, fields }),
  }
  return { deps, calls, of: (n: string) => calls.filter((c) => c.name === n) }
}

/**
 * The production state AFTER the executed run: every recipient has an invited waitlist row, an
 * accepted delivery record, and a not-yet-activated auth user. Two recipients have since activated
 * (auth user with a sign-in / a profile) — the completed case the classification model supports.
 */
function executedProductionState(): Cfg {
  const auth: Cfg['auth'] = {}
  const waitlist: Cfg['waitlist'] = {}
  const delivery: Cfg['delivery'] = {}
  RECIPIENTS.forEach((r, i) => {
    waitlist[r.email] = { id: `wl_${i}`, status: 'invited' }
    delivery[r.email] = ds({ active: true })           // accepted/delivered → active claim
    auth[r.email] = { count: 1, user: { id: `u_${i}`, last_sign_in_at: null } }
  })
  // Two members activated after the campaign.
  auth['bcoffee@sourceamerica.org'] = { count: 1, user: { id: 'u_0', last_sign_in_at: '2026-08-10T00:00:00Z' } }
  auth['john.ustica@siemensgovt.com'] = { count: 1, user: { id: 'u_1', last_sign_in_at: null } }
  return { auth, waitlist, delivery, profiles: new Set(['u_1']), mode: 'on' }
}

describe('executed James campaign — a full re-run is inert', () => {
  it('classifies every already-processed recipient as non-ready and sends nothing', async () => {
    const h = harness(executedProductionState())
    const r = await runNominationCampaign(h.deps, { dryRun: false, only: undefined })
    expect(r.recipients).toHaveLength(12)
    expect(r.summary.sent).toBeUndefined()
    // No replacement links, no duplicate auth users, no duplicate waitlist rows, no duplicate
    // referrals, no altered delivery records — because none of those deps is ever called.
    expect(h.of('sendInvite')).toHaveLength(0)
    expect(h.of('ensureWaitlist')).toHaveLength(0)
    expect(h.of('ensureReferral')).toHaveLength(0)
  })

  it('a previously SENT + activated recipient is already_member (never ready)', async () => {
    const h = harness(executedProductionState())
    const r = await runNominationCampaign(h.deps, { dryRun: false })
    const brett = r.recipients.find((x) => x.emailMasked === 'b***@sourceamerica.org')!
    expect(brett.classification).toBe('already_member')   // signed in
    expect(brett.outcome).toBe('already_member')
    const john = r.recipients.find((x) => x.emailMasked === 'j***@siemensgovt.com')!
    expect(john.classification).toBe('already_member')     // has a profile
  })

  it('a previously SENT but not-yet-activated recipient is active_invite_exists (never ready)', async () => {
    const h = harness(executedProductionState())
    const r = await runNominationCampaign(h.deps, { dryRun: false })
    const others = r.recipients.filter((x) => !['b***@sourceamerica.org', 'j***@siemensgovt.com'].includes(x.emailMasked))
    expect(others).toHaveLength(10)
    for (const x of others) {
      expect(x.classification).toBe('active_invite_exists')
      expect(x.outcome).toBe('active_invite_exists')
    }
  })

  it('an old successful claim is never reinterpreted as ready, even if the waitlist row were lost', async () => {
    // Delivery evidence alone (an accepted/delivered claim) is enough to block a resend.
    const cfg = executedProductionState()
    cfg.waitlist = {}   // simulate a missing waitlist row
    const h = harness(cfg)
    const r = await runNominationCampaign(h.deps, { dryRun: false })
    expect(h.of('sendInvite')).toHaveLength(0)
    expect(r.summary.ready).toBeUndefined()
  })

  it('a dry run over the executed state also writes and sends nothing', async () => {
    const h = harness(executedProductionState())
    const r = await runNominationCampaign(h.deps, { dryRun: true })
    expect(r.dryRun).toBe(true)
    expect(h.of('sendInvite')).toHaveLength(0)
    expect(h.of('ensureWaitlist')).toHaveLength(0)
    expect(h.of('ensureReferral')).toHaveLength(0)
  })

  it('the single-recipient test mode cannot resend an already-processed recipient either', async () => {
    const h = harness(executedProductionState())
    await runNominationCampaign(h.deps, { dryRun: false, only: 'barry.murphy@merlinatlantic.com' })
    expect(h.of('sendInvite')).toHaveLength(0)
  })
})

describe('executed James campaign — delivery-claim identifiers are unchanged', () => {
  it('the claim is still keyed on (waitlist_id, purpose) with the same purpose values', () => {
    const delivery = readFileSync('lib/invitations/delivery.ts', 'utf8')
    const secure = readFileSync('lib/invitations/secureInvite.ts', 'utf8')
    expect(delivery).toContain("purpose: 'first_invite' | 'access_resend' | 'reminder'")
    expect(delivery).toContain(".eq('waitlist_id', args.waitlistId).eq('purpose', args.purpose)")
    expect(secure).toContain("const purpose = plan === 'create' ? 'first_invite' : 'access_resend'")
    // The generalization touched neither file.
    expect(codeOnly(ENGINE)).not.toMatch(/first_invite|access_resend|invitation_deliveries/)
  })

  it('an already-activated member short-circuits inside secureInvite before any link is generated', () => {
    const secure = readFileSync('lib/invitations/secureInvite.ts', 'utf8')
    const activeIdx = secure.indexOf("state: 'active'")
    const claimIdx = secure.indexOf('deps.claimDelivery(')
    expect(activeIdx).toBeGreaterThan(-1)
    expect(activeIdx).toBeLessThan(claimIdx) // returns before claiming or generating a link
  })
})
