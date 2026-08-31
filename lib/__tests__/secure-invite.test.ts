import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { Webhook } from 'svix'
import { Resend } from 'resend'
import {
  classifyInviteTarget, linkTypeForPlan, buildRecoverLink, sendSecureInvite,
  type SecureInviteDeps,
} from '@/lib/invitations/secureInvite'
import {
  verifyResendWebhook, mapResendEvent, shouldApplyStatus, isTerminal,
} from '@/lib/webhooks/resendVerify'

describe('classifyInviteTarget + link builder', () => {
  it('routes by auth state', () => {
    expect(classifyInviteTarget({ authCount: 0, activated: false })).toBe('create')
    expect(classifyInviteTarget({ authCount: 1, activated: false })).toBe('link_existing')
    expect(classifyInviteTarget({ authCount: 1, activated: true })).toBe('active')
    expect(classifyInviteTarget({ authCount: 2, activated: false })).toBe('ambiguous')
    expect(linkTypeForPlan('create')).toBe('invite')
    expect(linkTypeForPlan('link_existing')).toBe('recovery')
  })
  it('token goes ONLY in the /auth/recover fragment (canonical host, targets reset-password)', () => {
    const link = buildRecoverLink({ siteUrl: 'https://andrel.app', hashedToken: 'HT', type: 'invite' })
    expect(link.startsWith('https://andrel.app/auth/recover#')).toBe(true)
    const [path, frag] = link.split('#')
    expect(path).not.toContain('HT')
    const p = new URLSearchParams(frag)
    expect(p.get('token_hash')).toBe('HT')
    expect(p.get('type')).toBe('invite')
    expect(p.get('next')).toBe('/auth/reset-password')
  })
})

function deps(opts: any = {}): { deps: SecureInviteDeps; calls: any } {
  const {
    authCount = 0, user = null, hasProfile = false, claimIsNew = true, claimId = 'del_1',
    sendResult = { success: true, messageId: 'msg_1' }, ...over
  } = opts
  const calls: any = { claims: [], generate: [], emails: [], accepted: [], failed: [] }
  const d: SecureInviteDeps = {
    siteUrl: 'https://andrel.app',
    lookupAuth: async () => ({ count: authCount, user }),
    hasProfile: async () => !!hasProfile,
    claimDelivery: async (purpose, authUserId) => { calls.claims.push({ purpose, authUserId }); return { deliveryId: claimId, isNew: claimIsNew } },
    generateLink: async (type, email) => { calls.generate.push({ type, email }); return { hashedToken: 'HT-' + type, userId: 'u1' } },
    sendEmail: async (a) => { calls.emails.push(a); return sendResult },
    markAccepted: async (id, msg, uid) => { calls.accepted.push({ id, msg, uid }) },
    markFailed: async (id, ec) => { calls.failed.push({ id, ec }) },
    ...over,
  }
  return { deps: d, calls }
}

describe('sendSecureInvite — claim → generate → send, durable + concurrency-safe', () => {
  it('NEW invitee → claim, invite link, send with idempotency key invite:<claimId>, markAccepted; no token leak', async () => {
    const { deps: d, calls } = deps({ authCount: 0 })
    const r = await sendSecureInvite(d, { email: 'New@X.com ', fullName: 'New', waitlistId: 'w1' })
    expect(r).toMatchObject({ ok: true, state: 'invited', sent: true, deliveryId: 'del_1' })
    expect(calls.claims[0].purpose).toBe('first_invite')
    expect(calls.generate).toEqual([{ type: 'invite', email: 'new@x.com' }])
    expect(calls.emails[0].idempotencyKey).toBe('invite:del_1')  // stable key from the claim id
    expect(calls.emails[0].link).toContain('/auth/recover#token_hash=HT-invite')
    expect(calls.accepted[0]).toMatchObject({ id: 'del_1', msg: 'msg_1' })
    expect(JSON.stringify(r)).not.toMatch(/token_hash|auth\/recover|HT-/) // token NEVER in the result
  })
  it('existing inactive → recovery, no duplicate create', async () => {
    const { deps: d, calls } = deps({ authCount: 1, user: { id: 'u1', last_sign_in_at: null } })
    const r = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1' })
    expect(r.state).toBe('link_sent')
    expect(calls.generate[0].type).toBe('recovery')
    expect(calls.claims[0].purpose).toBe('access_resend')
  })
  it('active → neutral, NO claim/generate/send', async () => {
    const { deps: d, calls } = deps({ authCount: 1, user: { id: 'u1', last_sign_in_at: '2026-01-01T00:00:00Z' } })
    const r = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1' })
    expect(r.state).toBe('active')
    expect(calls.claims).toHaveLength(0)
    expect(calls.emails).toHaveLength(0)
  })
  it('ambiguous → hard-stop, NO claim/send', async () => {
    const { deps: d, calls } = deps({ authCount: 2, user: { id: 'u1', last_sign_in_at: null } })
    const r = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1' })
    expect(r.state).toBe('ambiguous')
    expect(calls.claims).toHaveLength(0)
  })
  it('FAIL CLOSED: a claim that cannot be persisted → unavailable, NO generateLink / NO send / NO Auth', async () => {
    const { deps: d, calls } = deps({ authCount: 0, claimDelivery: async () => ({ deliveryId: null, isNew: false, claimFailed: true }) })
    const r = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1' })
    expect(r.state).toBe('unavailable')
    expect(r.sent).toBe(false)
    expect(calls.generate).toHaveLength(0) // no Auth mutation / link generation
    expect(calls.emails).toHaveLength(0)   // no provider call
  })
  it('FAIL CLOSED: a "new" claim with a null delivery id → unavailable, NO send (never untracked)', async () => {
    const { deps: d, calls } = deps({ authCount: 0, claimDelivery: async () => ({ deliveryId: null, isNew: true }) })
    const r = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1' })
    expect(r.state).toBe('unavailable')
    expect(calls.emails).toHaveLength(0)
  })
  it('an existing ACCEPTED attempt (already sent) → pending, NO re-generate/re-send', async () => {
    const { deps: d, calls } = deps({ authCount: 0, claimDelivery: async () => ({ deliveryId: 'del_1', isNew: false, existingStatus: 'accepted' }) })
    const r = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1' })
    expect(r.state).toBe('pending')
    expect(calls.generate).toHaveLength(0)
    expect(calls.emails).toHaveLength(0)
  })
  it('a DEFERRED (in-flight) attempt within the window → pending, NO resend', async () => {
    const { deps: d, calls } = deps({ authCount: 0, claimDelivery: async () => ({ deliveryId: 'del_1', isNew: false, existingStatus: 'deferred', stale: false }) })
    const r = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1' })
    expect(r.state).toBe('pending')
    expect(calls.emails).toHaveLength(0)
  })
  it('a stale ACCEPTED attempt (lost webhook) + force → retire + FRESH attempt (new row/token/key)', async () => {
    let n = 0
    const { deps: d, calls } = deps({
      authCount: 0,
      claimDelivery: async () => { n++; return n === 1 ? { deliveryId: 'del_acc', isNew: false, existingStatus: 'accepted', stale: true } : { deliveryId: 'del_new', isNew: true } },
    })
    const r = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1', force: true })
    expect(r.state).toBe('invited')
    expect(calls.failed[0]).toMatchObject({ id: 'del_acc', ec: 'superseded_by_admin' })
    expect(calls.emails[0].idempotencyKey).toBe('invite:del_new')
  })
  it('a CLAIMED attempt within the window → pending, NO second provider request (never same-key changed-payload retry)', async () => {
    const { deps: d, calls } = deps({ authCount: 0, claimDelivery: async () => ({ deliveryId: 'del_1', isNew: false, existingStatus: 'claimed', stale: false }) })
    const r = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1' })
    expect(r.state).toBe('pending')
    expect(r.message).toMatch(/do not resend/i)
    expect(calls.generate).toHaveLength(0) // no token regenerated
    expect(calls.emails).toHaveLength(0)   // NO second provider request
  })
  it('resend is BLOCKED during the window even with force=true (no new attempt inside 24h)', async () => {
    const { deps: d, calls } = deps({ authCount: 0, claimDelivery: async () => ({ deliveryId: 'del_1', isNew: false, existingStatus: 'claimed', stale: false }) })
    const r = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1', force: true })
    expect(r.state).toBe('pending') // force is only honored once the claim is stale (past 24h)
    expect(calls.emails).toHaveLength(0)
  })
  it('PAST WINDOW (stale), no force → needs_review, NO send', async () => {
    const { deps: d, calls } = deps({ authCount: 0, claimDelivery: async () => ({ deliveryId: 'del_1', isNew: false, existingStatus: 'claimed', stale: true }) })
    const r = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1' })
    expect(r.state).toBe('needs_review')
    expect(calls.generate).toHaveLength(0)
    expect(calls.emails).toHaveLength(0)
  })
  it('AFTER 24h + force → retire stale claim, FRESH attempt with a NEW row, NEW token, NEW key', async () => {
    let n = 0
    const { deps: d, calls } = deps({
      authCount: 0,
      claimDelivery: async () => { n++; return n === 1 ? { deliveryId: 'del_old', isNew: false, existingStatus: 'claimed', stale: true } : { deliveryId: 'del_new', isNew: true } },
    })
    const r = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1', force: true })
    expect(r.state).toBe('invited')
    expect(calls.failed[0]).toMatchObject({ id: 'del_old', ec: 'superseded_by_admin' }) // stale claim retired
    expect(r.deliveryId).toBe('del_new')                                                 // NEW delivery row
    expect(calls.generate).toHaveLength(1)                                               // NEW token generated
    expect(calls.emails[0].idempotencyKey).toBe('invite:del_new')                        // NEW idempotency key
  })
  it('UNCERTAIN send → state uncertain, NOT markFailed, claim retained, message says do-not-resend', async () => {
    const { deps: d, calls } = deps({ authCount: 0, sendResult: { success: false, uncertain: true, errorClass: 'timeout' } })
    const r = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1' })
    expect(r.state).toBe('uncertain')
    expect(calls.failed).toHaveLength(0)          // NOT marked failed → stays claimed, webhook can resolve
    expect(r.message).toMatch(/do not resend/i)
    expect(r.sent).toBe(false)
  })
  it('BEHAVIORAL: uncertain first call, then a re-click within the window makes NO second provider request', async () => {
    // The corrected policy: an uncertain outcome leaves the claim in place and a re-click within
    // the window is a no-send `pending` — it must NOT re-hit the provider (a same-key changed-payload
    // retry would be a 409 invalid_idempotent_request; a different key could double-send).
    const api: any[] = []
    let claimN = 0
    const d: SecureInviteDeps = {
      siteUrl: 'https://andrel.app',
      lookupAuth: async () => ({ count: 0, user: null }),
      hasProfile: async () => false,
      claimDelivery: async () => { claimN++; return claimN === 1 ? { deliveryId: 'del_1', isNew: true } : { deliveryId: 'del_1', isNew: false, existingStatus: 'claimed', stale: false } },
      generateLink: async (type) => ({ hashedToken: 'HT-' + type, userId: 'u1' }),
      sendEmail: async (a) => { api.push(a); return { success: false, uncertain: true } }, // first send: uncertain
      markAccepted: async () => {},
      markFailed: async () => {},
    }
    const r1 = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1' })
    expect(r1.state).toBe('uncertain')
    const r2 = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1' }) // re-click within window
    expect(r2.state).toBe('pending')
    expect(api).toHaveLength(1) // EXACTLY ONE provider request across both calls — no silent duplicate
  })
  it('AT-MOST-ONCE: provider ACCEPTED but the local accepted-state write FAILS → still sent, NOT a retryable error, NO second send', async () => {
    // The email already went out; a failure to record `accepted` locally must never become a retryable
    // `error` (which a re-run would treat as send-again). It stays sent=true; the claim row is left
    // `claimed` and reconciled by the webhook / after the 24h window — a second email is never sent.
    const { deps: d, calls } = deps({
      authCount: 0,
      sendResult: { success: true, messageId: 'msg_x' },
      markAccepted: async () => { throw new Error('db write failed post-dispatch') },
    })
    const r = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1' })
    expect(r.state).toBe('invited')     // NOT 'error'
    expect(r.sent).toBe(true)           // provider accepted; honestly reported
    expect(calls.emails).toHaveLength(1)  // exactly one provider request
    expect(calls.failed).toHaveLength(0)  // never marked failed → never auto-retried as a fresh send
  })
  it('DEFINITE failure → markFailed, state error, retryable message', async () => {
    const { deps: d, calls } = deps({ authCount: 0, sendResult: { success: false, errorClass: 'provider_error' } })
    const r = await sendSecureInvite(d, { email: 'x@y.co', fullName: null, waitlistId: 'w1' })
    expect(r.state).toBe('error')
    expect(calls.failed[0]).toMatchObject({ id: 'del_1', ec: 'provider_error' })
    expect(r.message).toMatch(/safe to retry/i)
  })
})

describe('Resend webhook — OFFICIAL SDK verification + event/state model', () => {
  const SECRET = 'whsec_' + Buffer.from('unit-test-webhook-secret-key!!').toString('base64')
  const client = new Resend('re_test_key') // verify() is local (svix); no network
  const signedHeaders = (payload: string, id = 'msg_evt_1', date = new Date()) => {
    const sig = new Webhook(SECRET).sign(id, date, payload)
    return new Headers({ 'svix-id': id, 'svix-timestamp': String(Math.floor(date.getTime() / 1000)), 'svix-signature': sig })
  }

  it('accepts a genuinely svix-signed webhook (fixture compatible with the official verifier)', () => {
    const payload = JSON.stringify({ type: 'email.delivered', created_at: '2026-08-10T00:00:00Z', data: { email_id: 'm1' } })
    const evt = verifyResendWebhook(payload, signedHeaders(payload), SECRET, client)
    expect(evt).toMatchObject({ type: 'email.delivered', messageId: 'm1' })
  })
  it('rejects a tampered payload, missing headers, and (via a throwing client) any verify exception', () => {
    const payload = JSON.stringify({ type: 'email.sent', data: { email_id: 'm1' } })
    const headers = signedHeaders(payload)
    expect(verifyResendWebhook('{"type":"email.sent","data":{}}', headers, SECRET, client)).toBeNull() // tampered
    expect(verifyResendWebhook(payload, new Headers(), SECRET, client)).toBeNull()                    // no svix headers
    const throwing = { webhooks: { verify: () => { throw new Error('bad sig') } } } as any
    expect(verifyResendWebhook(payload, signedHeaders(payload), SECRET, throwing)).toBeNull()
    expect(verifyResendWebhook(payload, signedHeaders(payload), '', client)).toBeNull()               // no secret
  })
  it('maps every relevant event incl. suppressed → blocked; unknown → null', () => {
    expect(mapResendEvent('email.sent')).toBe('accepted')
    expect(mapResendEvent('email.delivered')).toBe('delivered')
    expect(mapResendEvent('email.delivery_delayed')).toBe('deferred')
    expect(mapResendEvent('email.bounced')).toBe('bounced')
    expect(mapResendEvent('email.complained')).toBe('complained')
    expect(mapResendEvent('email.failed')).toBe('failed')
    expect(mapResendEvent('email.suppressed')).toBe('blocked')
    expect(mapResendEvent('email.opened')).toBeNull()
  })
  it('terminal states never regress; out-of-order safe', () => {
    expect(isTerminal('delivered')).toBe(true)
    expect(shouldApplyStatus('accepted', 'delivered')).toBe(true)
    expect(shouldApplyStatus('delivered', 'accepted')).toBe(false)
    expect(shouldApplyStatus('bounced', 'delivered')).toBe(false)
    expect(shouldApplyStatus('blocked', 'accepted')).toBe(false)
  })
})

describe('NO plaintext-password invitation code anywhere (repo-wide structural)', () => {
  const files = {
    email: readFileSync('lib/email.ts', 'utf8'),
    // The invite COPY moved to a pure builder so the admin preview renders the same code that
    // sends. The sender keeps the wiring; the builder keeps the words. Assert each where it is.
    inviteTemplate: readFileSync('lib/email/secureInvite.ts', 'utf8'),
    sendInvite: readFileSync('app/api/admin/send-invite/route.ts', 'utf8'),
    bulk: readFileSync('app/api/admin/bulk-invite/route.ts', 'utf8'),
    secure: readFileSync('lib/invitations/secureInvite.ts', 'utf8'),
    invitations: readFileSync('lib/invitations.ts', 'utf8'),
    migration: readFileSync('supabase/migrations/049_invitation_deliveries.sql', 'utf8'),
  }
  it('the deleted temp-password code is gone (helpers, generator, weak action)', () => {
    expect(files.email).not.toMatch(/export async function sendInviteEmail|export async function sendReferralInviteEmail/)
    expect(files.email).not.toMatch(/temporary password|Temporary password|tempPassword/i)
    expect(files.invitations).not.toMatch(/generateTempPassword|TEMP_PW_ALPHABET/)
  })
  it('invitation code contains NO createUser({password}), password reset, weak creds, or password interpolation', () => {
    for (const src of [files.sendInvite, files.bulk, files.secure, files.email.slice(files.email.indexOf('sendSecureInviteEmail'))]) {
      expect(src).not.toMatch(/createUser\(\{[^}]*password/)
      expect(src).not.toMatch(/updateUserById\([^)]*password/)
      expect(src).not.toMatch(/tempPassword|generateTempPassword/)
      expect(src).not.toMatch(/Math\.random\(\)/)               // no weak credentials
      expect(src).not.toMatch(/\$\{[^}]*[Pp]assword[^}]*\}/)     // no password value interpolated
    }
  })
  it('the secure email carries a link + set-up copy, generic expiry copy, and consent-gated referrer', () => {
    const fn = files.email.slice(files.email.indexOf('export async function sendSecureInviteEmail'), files.email.indexOf('export async function sendRecommendationIntroductionEmail'))
    const tpl = files.inviteTemplate
    expect(tpl).toContain('set up your account')
    expect(tpl).toContain('input.link')                          // the button targets the secure link
    expect(tpl).toMatch(/This secure link expires for your protection/)
    expect(tpl).not.toMatch(/expires in about an hour/)          // exact-lifetime copy removed
    expect(fn).toContain('idempotencyKey')                       // passed to Resend
    expect(fn).toContain('referrerName')                         // consent-gated naming preserved
    expect(tpl).toContain('referrerName')
  })
  it('the delivery table is service-role only (RLS, no policies) + webhook event log + active-claim index', () => {
    expect(files.migration).toContain('ENABLE ROW LEVEL SECURITY')
    expect(files.migration).not.toMatch(/CREATE POLICY/)
    expect(files.migration).toMatch(/invitation_deliveries_active_claim_uniq/)          // pre-send claim uniqueness
    expect(files.migration).toContain('invitation_delivery_events')                     // event log
    expect(files.migration).toMatch(/svix_id\s+text NOT NULL UNIQUE/)                    // replay protection
  })
})

describe('rollout-mode gate (default OFF) — enforced server-side in both send routes', () => {
  const send = readFileSync('app/api/admin/send-invite/route.ts', 'utf8')
  const bulk = readFileSync('app/api/admin/bulk-invite/route.ts', 'utf8')
  it('single send gates per-recipient via canSendInvitation + differentiates off vs test', () => {
    expect(send).toMatch(/if \(!canSendInvitation\(email\)\)/)
    expect(send).toMatch(/invitationsMode\(\) === 'off'/)
    expect(send).toContain('INVITATION_TEST_BLOCKED_MESSAGE')
  })
  it('bulk rejects the whole batch in off mode, and allowlist-filters each row otherwise', () => {
    expect(bulk).toMatch(/invitationsMode\(\)/)
    expect(bulk).toMatch(/mode === 'off'/)
    expect(bulk).toMatch(/if \(!canSendInvitation\(email\)\)/) // per-row, before insert/lookup/claim/send
  })
  it('the per-row allowlist check is the FIRST statement in the execute loop (before any mutation)', () => {
    // The canSendInvitation guard must appear before the Auth lookup + waitlist insert in the loop.
    const loop = bulk.slice(bulk.indexOf('for (const { email, name } of ready_to_invite)'))
    expect(loop.indexOf('canSendInvitation(email)')).toBeLessThan(loop.indexOf('lookupAuthUsersByEmail'))
    expect(loop.indexOf('canSendInvitation(email)')).toBeLessThan(loop.indexOf(".from('waitlist')"))
  })
})

describe('founding-member metadata is set via generateLink (no password), consistently in both routes', () => {
  it('single + bulk seed markAsFounding ONLY on the first-invite link (type invite)', () => {
    const send = readFileSync('app/api/admin/send-invite/route.ts', 'utf8')
    const bulk = readFileSync('app/api/admin/bulk-invite/route.ts', 'utf8')
    for (const src of [send, bulk]) {
      // metadata attached to the generateLink data option, gated on type === 'invite'
      expect(src).toMatch(/type === 'invite'\) options\.data = \{ markAsFounding: true \}/)
      // and NEVER via a password-bearing createUser
      expect(src).not.toMatch(/createUser\(\{[^}]*password/)
    }
  })
})
