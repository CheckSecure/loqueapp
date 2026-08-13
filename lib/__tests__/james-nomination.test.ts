import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  RECIPIENTS, NOMINATOR, maskEmail, classifyRecipient, runNominationCampaign,
  type NominationDeps, type DeliveryState,
} from '@/lib/campaigns/jamesNomination'

describe('campaign recipient set', () => {
  it('is exactly 12 unique lowercase recipients, nominator excluded; Barry once; names preserved', () => {
    expect(RECIPIENTS).toHaveLength(12)
    const emails = RECIPIENTS.map((r) => r.email)
    expect(new Set(emails).size).toBe(12)
    expect(emails.every((e) => e === e.toLowerCase())).toBe(true)
    expect(emails).not.toContain(NOMINATOR.email)
    expect(RECIPIENTS.filter((r) => r.email === 'barry.murphy@merlinatlantic.com')).toHaveLength(1)
    expect(RECIPIENTS.filter((r) => r.firstName === 'Jim')).toHaveLength(2)
  })
  it('nominator carries James real profile UUID', () => {
    expect(NOMINATOR.userId).toBe('f9cf644b-1ee4-49cc-92bc-691145013d02')
  })
})

describe('maskEmail', () => {
  it('masks the local part, keeps the domain', () => {
    expect(maskEmail('bcoffee@sourceamerica.org')).toBe('b***@sourceamerica.org')
  })
})

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
    ensureWaitlist: async (e, fn) => { rec('ensureWaitlist', { e, fn }); return `wl_${e}` },
    ensureReferral: async (nom, wid) => { rec('ensureReferral', { nom, wid }) },
    sendInvite: async (a) => { rec('sendInvite', a); return cfg.sendResult?.(a.email) ?? { sent: true, state: 'invited', deliveryId: `del_${a.email}` } },
    canSend: (e) => cfg.mode === 'on' ? true : cfg.mode === 'test' ? !!cfg.allowlist?.has(e) : false,
    mode: () => cfg.mode ?? 'on',
    log: (event, fields) => rec('log', { event, fields }),
  }
  return { deps, calls, of: (n: string) => calls.filter((c) => c.name === n) }
}

describe('classifyRecipient — precise current state (each non-ready needs operator review)', () => {
  it('ready when nothing exists', async () => expect(await classifyRecipient(harness().deps, 'new@x.com')).toBe('ready'))
  it('already_member when activated', async () => {
    expect(await classifyRecipient(harness({ auth: { 'm@x.com': { count: 1, user: { id: 'u', last_sign_in_at: '2026-01-01' } } } }).deps, 'm@x.com')).toBe('already_member')
    expect(await classifyRecipient(harness({ auth: { 'm@x.com': { count: 1, user: { id: 'u', last_sign_in_at: null } } }, profiles: new Set(['u']) }).deps, 'm@x.com')).toBe('already_member')
  })
  it('active_invite_exists: not-activated auth, invited waitlist, or an active delivery', async () => {
    expect(await classifyRecipient(harness({ auth: { 'a@x.com': { count: 1, user: { id: 'u', last_sign_in_at: null } } } }).deps, 'a@x.com')).toBe('active_invite_exists')
    expect(await classifyRecipient(harness({ waitlist: { 'w@x.com': { id: 'wl', status: 'invited' } } }).deps, 'w@x.com')).toBe('active_invite_exists')
    expect(await classifyRecipient(harness({ delivery: { 'd@x.com': ds({ active: true }) } }).deps, 'd@x.com')).toBe('active_invite_exists')
  })
  it('previously_declined / previously_revoked from the waitlist status', async () => {
    expect(await classifyRecipient(harness({ waitlist: { 'x@x.com': { id: 'wl', status: 'declined' } } }).deps, 'x@x.com')).toBe('previously_declined')
    expect(await classifyRecipient(harness({ waitlist: { 'x@x.com': { id: 'wl', status: 'revoked' } } }).deps, 'x@x.com')).toBe('previously_revoked')
  })
  it('prior_delivery_failed (bounced/failed) and suppressed (complained/blocked)', async () => {
    expect(await classifyRecipient(harness({ delivery: { 'f@x.com': ds({ failed: true }) } }).deps, 'f@x.com')).toBe('prior_delivery_failed')
    expect(await classifyRecipient(harness({ delivery: { 's@x.com': ds({ suppressed: true }) } }).deps, 's@x.com')).toBe('suppressed')
  })
  it('suppression outranks a stale invited waitlist row (no blind resend)', async () => {
    const h = harness({ waitlist: { 'y@x.com': { id: 'wl', status: 'invited' } }, delivery: { 'y@x.com': ds({ suppressed: true }) } })
    expect(await classifyRecipient(h.deps, 'y@x.com')).toBe('suppressed')
  })
  it('conflict (duplicate auth) / invalid', async () => {
    expect(await classifyRecipient(harness({ auth: { 'd@x.com': { count: 2, user: { id: 'u', last_sign_in_at: null } } } }).deps, 'd@x.com')).toBe('conflict')
    expect(await classifyRecipient(harness().deps, 'nope')).toBe('invalid')
  })
})

describe('dry run — zero writes, zero sends, masked output', () => {
  it('classifies all 12; no referral/waitlist/send writes', async () => {
    const h = harness({ mode: 'on' })
    const r = await runNominationCampaign(h.deps, { dryRun: true })
    expect(r.dryRun).toBe(true); expect(r.recipients).toHaveLength(12)
    expect(h.of('sendInvite')).toHaveLength(0)
    expect(h.of('ensureWaitlist')).toHaveLength(0)
    expect(h.of('ensureReferral')).toHaveLength(0)
    for (const x of r.recipients) expect(x.emailMasked).toMatch(/^.\*\*\*@/)
    expect(JSON.stringify(r)).not.toContain('bcoffee@')
  })
})

describe('execute — attribution before send, one isolated invite per ready recipient', () => {
  it('records James attribution then sends per recipient (12 ready → 12 sends)', async () => {
    const h = harness({ mode: 'on' })
    const r = await runNominationCampaign(h.deps, { dryRun: false })
    expect(h.of('ensureReferral')).toHaveLength(12)
    expect(h.of('ensureReferral').every((c) => c.args.nom === NOMINATOR.userId)).toBe(true) // James real UUID
    expect(h.of('sendInvite')).toHaveLength(12)
    // attribution precedes the send for each recipient
    const referralIdx = h.calls.findIndex((c) => c.name === 'ensureReferral')
    const sendIdx = h.calls.findIndex((c) => c.name === 'sendInvite')
    expect(referralIdx).toBeLessThan(sendIdx)
    expect(new Set(h.of('sendInvite').map((c) => c.args.email)).size).toBe(12)
    expect(r.summary.sent).toBe(12)
  })
  it('skips non-ready states without any send (already_member/declined/suppressed/failed)', async () => {
    const h = harness({
      mode: 'on',
      auth: { 'bcoffee@sourceamerica.org': { count: 1, user: { id: 'u1', last_sign_in_at: '2026-01-01' } } },
      waitlist: { 'john.ustica@siemensgovt.com': { id: 'wl', status: 'declined' } },
      delivery: { 'jason@readysetlaunch.net': ds({ suppressed: true }), 'dyson@foxsteadpartners.com': ds({ failed: true }) },
    })
    const r = await runNominationCampaign(h.deps, { dryRun: false })
    const sent = h.of('sendInvite').map((c) => c.args.email)
    for (const e of ['bcoffee@sourceamerica.org', 'john.ustica@siemensgovt.com', 'jason@readysetlaunch.net', 'dyson@foxsteadpartners.com']) expect(sent).not.toContain(e)
    expect(r.summary).toMatchObject({ already_member: 1, previously_declined: 1, suppressed: 1, prior_delivery_failed: 1, sent: 8 })
    expect(h.of('ensureReferral')).toHaveLength(8) // only ready recipients get attribution+send
  })
  it('INVITATIONS_MODE off → nothing sent', async () => {
    const h = harness({ mode: 'off' })
    const r = await runNominationCampaign(h.deps, { dryRun: false })
    expect(h.of('sendInvite')).toHaveLength(0); expect(r.summary.skipped_paused).toBe(12)
  })
  it('INVITATIONS_MODE test → only allowlisted send', async () => {
    const h = harness({ mode: 'test', allowlist: new Set(['bcoffee@sourceamerica.org']) })
    const r = await runNominationCampaign(h.deps, { dryRun: false })
    expect(h.of('sendInvite').map((c) => c.args.email)).toEqual(['bcoffee@sourceamerica.org'])
    expect(r.summary.sent).toBe(1); expect(r.summary.skipped_not_allowlisted).toBe(11)
  })
  it('in-flight (pending) delivery → already_processed (no resend)', async () => {
    const h = harness({ mode: 'on', sendResult: () => ({ sent: false, state: 'pending', deliveryId: 'd' }) })
    const r = await runNominationCampaign(h.deps, { dryRun: false })
    expect(r.summary.already_processed).toBe(12); expect(r.summary.sent).toBeUndefined()
  })
  it('DEFINITE pre-dispatch failure (error) → send_failed (retryable); succeeded not resent', async () => {
    const h = harness({ mode: 'on', sendResult: (e) => e === 'jason@readysetlaunch.net'
      ? { sent: false, state: 'error', deliveryId: 'd', errorClass: 'provider_error' }
      : { sent: true, state: 'invited', deliveryId: 'd' } })
    const r = await runNominationCampaign(h.deps, { dryRun: false })
    expect(r.summary.sent).toBe(11); expect(r.summary.send_failed).toBe(1)
  })
  it('AMBIGUOUS post-dispatch result (uncertain / needs_review) → ambiguous_review, NEVER auto-resent', async () => {
    // uncertain = provider outcome unknown after dispatch (timeout / crash after send); needs_review =
    // a stale still-claimed row the provider may already have accepted. Both surface for manual review.
    for (const state of ['uncertain', 'needs_review'] as const) {
      const h = harness({ mode: 'on', sendResult: () => ({ sent: false, state, deliveryId: 'd' }) })
      const r = await runNominationCampaign(h.deps, { dryRun: false })
      expect(r.summary.ambiguous_review).toBe(12)
      expect(r.summary.sent).toBeUndefined()      // nothing counted as sent
      expect(r.summary.send_failed).toBeUndefined() // and NOT classed as a retryable failure
    }
  })
  it('unavailable send state surfaces as unavailable (not a retryable failure)', async () => {
    const h = harness({ mode: 'on', sendResult: () => ({ sent: false, state: 'unavailable', deliveryId: null }) })
    const r = await runNominationCampaign(h.deps, { dryRun: false })
    expect(r.summary.unavailable).toBe(12); expect(r.summary.sent).toBeUndefined()
  })
  it('a link_sent state (link minted, email dispatched) counts as sent', async () => {
    const h = harness({ mode: 'on', sendResult: () => ({ sent: false, state: 'link_sent', deliveryId: 'd' }) })
    const r = await runNominationCampaign(h.deps, { dryRun: false })
    expect(r.summary.sent).toBe(12)
  })
  it('single-recipient test (only) sends JUST that nominee; the other 11 are skipped_not_selected (still classified)', async () => {
    const h = harness({ mode: 'on' })
    const r = await runNominationCampaign(h.deps, { dryRun: false, only: 'bcoffee@sourceamerica.org' })
    expect(h.of('sendInvite').map((c) => c.args.email)).toEqual(['bcoffee@sourceamerica.org']) // exactly one send
    expect(h.of('ensureReferral')).toHaveLength(1)                                              // attribution for the one
    expect(r.summary.sent).toBe(1)
    expect(r.summary.skipped_not_selected).toBe(11)
    expect(r.recipients).toHaveLength(12)                                                        // all still reported
  })
  it('only-mode normalizes the selector (case/whitespace) before matching', async () => {
    const h = harness({ mode: 'on' })
    const r = await runNominationCampaign(h.deps, { dryRun: false, only: '  BCoffee@SourceAmerica.org ' })
    expect(h.of('sendInvite').map((c) => c.args.email)).toEqual(['bcoffee@sourceamerica.org'])
    expect(r.summary.sent).toBe(1)
  })
  it('after a single-recipient test, a FULL rerun treats that nominee as already processed → NO second send', async () => {
    // Simulate post-test production state for Brett: a prior invite minted an auth user + an active
    // delivery. classifyRecipient must now return active_invite_exists (not ready) → never re-sent.
    const h = harness({
      mode: 'on',
      auth: { 'bcoffee@sourceamerica.org': { count: 1, user: { id: 'u_brett', last_sign_in_at: null } } },
      delivery: { 'bcoffee@sourceamerica.org': ds({ active: true }) },
    })
    const r = await runNominationCampaign(h.deps, { dryRun: false }) // full rerun, no `only`
    expect(h.of('sendInvite').map((c) => c.args.email)).not.toContain('bcoffee@sourceamerica.org')
    expect(h.of('ensureReferral').some((c) => false)).toBe(false) // no attribution write for the skipped one
    const brett = r.recipients.find((x) => x.emailMasked.startsWith('b***@'))
    expect(brett?.classification).toBe('active_invite_exists')
    expect(r.summary.sent).toBe(11)              // the other 11 ready recipients send
    expect(r.summary.active_invite_exists).toBe(1)
  })
  it('only-mode has NO effect on a dry run (a dry run always previews all 12, sends nothing)', async () => {
    const h = harness({ mode: 'on' })
    const r = await runNominationCampaign(h.deps, { dryRun: true, only: 'bcoffee@sourceamerica.org' })
    expect(h.of('sendInvite')).toHaveLength(0)
    expect(r.recipients).toHaveLength(12)
    expect(r.summary.skipped_not_selected).toBeUndefined() // dry run never marks skipped_not_selected
  })
  it('logs are coarse — no email/name/link/token', async () => {
    const h = harness({ mode: 'on' })
    await runNominationCampaign(h.deps, { dryRun: false })
    const dump = JSON.stringify(h.of('log'))
    expect(dump).not.toContain('@'); expect(dump).not.toMatch(/token|hashed|link|Brett|Mitchell/i)
  })
})

describe('structural guarantees', () => {
  it('email sender: exact subject, CC nominator, one To, no password', () => {
    const src = readFileSync('lib/email.ts', 'utf8')
    const fn = src.slice(src.indexOf('export async function sendNominationInviteEmail'), src.indexOf('[sendNominationInviteEmail] exception'))
    expect(fn).toContain("subject: 'James Kahrs invited you to join Andrel'")
    expect(fn).toContain('cc: args.cc'); expect(fn).toContain('to: args.to')
    expect(fn).toContain('Create your Andrel account')
    expect(fn).not.toMatch(/password/i)
  })
  it('route: referrals attribution + cc marker, NO campaign ledger, fixed campaign', () => {
    const src = readFileSync('app/api/admin/campaigns/james-nomination/route.ts', 'utf8')
    expect(src.indexOf('assertSameOrigin(req)')).toBeLessThan(src.indexOf('requireAdmin()'))
    expect(src).toContain('const dryRun = body.dryRun !== false')
    expect(src).toContain("from('referrals')")                        // attribution via referrals
    expect(src).toContain('cc: NOMINATOR.email')                       // email still CCs the nominator
    expect(src).toContain('hasAdditionalRecipients: true')             // minimal multi-recipient marker on the claim
    expect(src).not.toMatch(/cc_recipient/)                            // NO CC address stored on the delivery row
    expect(src).toContain("select('has_additional_recipients')")      // fail-closed on migration 054
    expect(src).not.toMatch(/nomination_campaign_sends/)               // NO separate ledger table
    expect(src).not.toMatch(/body\.recipients|body\.emails/)
  })
})
