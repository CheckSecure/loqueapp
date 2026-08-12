import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { changeInviteEmail, isValidEmailFormat, type ChangeEmailDeps } from '@/lib/invitations/changeInviteEmail'
import { lookupAuthUsersByEmail } from '@/lib/invitations'
import { buildRecoverLink } from '@/lib/invitations/secureInvite'

const WID = 'f565c7e4-def6-44a1-a190-5fcf90f9042a'
const UID = 'c5ab245b-64f9-49e4-a03c-a795e457a4f8'
const DID = 'del-1111'
const OLD = 'robert.broadbent@wbd-us.com'
const OLD_RAW = 'Robert.broadbent@wbd-us.com'
const NEW = 'broadbent2@hotmail.com'
const SITE = 'https://www.andrel.app' // canonical production origin

type Cfg = {
  status?: string
  rowEmail?: string
  signedIn?: boolean
  hasProfile?: boolean
  authByEmail?: Record<string, { count: number; user: { id: string; last_sign_in_at: string | null } | null }>
  profileAtNew?: boolean
  waitlistConflict?: boolean
  claim?: { deliveryId: string | null; isNew: boolean; claimFailed?: boolean; existingStatus?: string | null; stale?: boolean; existingRecipient?: string | null }
  authUpdateResults?: boolean[] // consumed per updateAuthEmail call (default: always true)
  guardResult?: { rows: number; uniqueViolation?: boolean; error?: boolean } // overrides default mutate
  guardThrows?: boolean // updateWaitlistEmailGuarded throws (unexpected failure → must compensate)
  breakVerifyAuth?: boolean // readAuthEmail keeps returning the OLD email → verification fails
  genThrows?: boolean
  linkUserId?: string | null // userId generateLink resolves to (default UID)
  send?: { success: boolean; messageId?: string | null; errorClass?: string; uncertain?: boolean }
}

function harness(cfg: Cfg = {}) {
  const calls: Array<{ name: string; args: any }> = []
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = []
  const rec = (name: string, args?: any) => calls.push({ name, args })

  const authUser = { id: UID, email: cfg.rowEmail ?? OLD_RAW, last_sign_in_at: cfg.signedIn ? '2026-08-01T00:00:00Z' : null }
  const wl = { id: WID, email: cfg.rowEmail ?? OLD_RAW, status: cfg.status ?? 'invited', full_name: 'Robert Al Broadbent' }
  const authResults = [...(cfg.authUpdateResults ?? [])]

  const norm = (e: string) => (e ?? '').trim().toLowerCase()
  const defaultAuthByEmail: Cfg['authByEmail'] = { [OLD]: { count: 1, user: { id: UID, last_sign_in_at: authUser.last_sign_in_at } } }

  const deps: ChangeEmailDeps = {
    siteUrl: SITE,
    loadWaitlist: async () => ({ id: wl.id, email: wl.email, status: wl.status, fullName: wl.full_name }),
    lookupAuth: async (e) => {
      const table = cfg.authByEmail ?? defaultAuthByEmail
      return table[norm(e)] ?? { count: 0, user: null }
    },
    hasProfile: async () => !!cfg.hasProfile,
    profileExistsForEmail: async () => !!cfg.profileAtNew,
    waitlistEmailConflict: async () => !!cfg.waitlistConflict,
    claimDelivery: async (authUserId, recipientEmail) => {
      rec('claimDelivery', { authUserId, recipientEmail })
      return cfg.claim ?? { deliveryId: DID, isNew: true }
    },
    updateAuthEmail: async (userId, email) => {
      rec('updateAuthEmail', { userId, email })
      const ok = authResults.length ? authResults.shift()! : true
      if (ok) authUser.email = email
      return ok
    },
    updateWaitlistEmailGuarded: async ({ waitlistId, oldEmail, newEmail }) => {
      rec('updateWaitlistEmailGuarded', { waitlistId, oldEmail, newEmail })
      if (cfg.guardThrows) throw new Error('waitlist update threw')
      if (cfg.guardResult) return cfg.guardResult
      if (wl.id === waitlistId && norm(wl.email) === norm(oldEmail) && wl.status === 'invited') {
        wl.email = newEmail
        return { rows: 1 }
      }
      return { rows: 0 }
    },
    readAuthEmail: async (userId) => {
      rec('readAuthEmail', { userId })
      return cfg.breakVerifyAuth ? OLD_RAW : authUser.email
    },
    readWaitlist: async () => ({ email: wl.email, status: wl.status }),
    generateLink: async (email) => {
      rec('generateLink', { email })
      if (cfg.genThrows) throw new Error('generateLink failed')
      return { hashedToken: 'HT-secret-token', userId: cfg.linkUserId === undefined ? UID : cfg.linkUserId }
    },
    sendEmail: async (a) => {
      rec('sendEmail', a)
      return cfg.send ?? { success: true, messageId: 'msg-1' }
    },
    markAccepted: async (id, msgId, authUserId) => { rec('markAccepted', { id, msgId, authUserId }) },
    markFailed: async (id, errClass) => { rec('markFailed', { id, errClass }) },
    log: (event, fields) => logs.push({ event, fields }),
  }

  const of = (name: string) => calls.filter((c) => c.name === name)
  return { deps, calls, logs, of, wl, authUser }
}

const run = (cfg?: Cfg, newEmail = NEW) => changeInviteEmail(harness(cfg).deps, { waitlistId: WID, newEmail })

// ── email format ─────────────────────────────────────────────────────────────────────
describe('isValidEmailFormat', () => {
  it('accepts a normal address, rejects whitespace / wildcard / multi-@ / no-domain', () => {
    expect(isValidEmailFormat(NEW)).toBe(true)
    expect(isValidEmailFormat('a@b')).toBe(false)          // no TLD
    expect(isValidEmailFormat('a b@x.com')).toBe(false)    // whitespace
    expect(isValidEmailFormat('a%@x.com')).toBe(false)     // SQL-LIKE wildcard (ilike safety)
    expect(isValidEmailFormat('a@@x.com')).toBe(false)     // multiple @
    expect(isValidEmailFormat('')).toBe(false)
  })
})

// ── preconditions ──────────────────────────────────────────────────────────────────────
describe('preconditions fail closed (no mutation, no send)', () => {
  const noMutation = (h: ReturnType<typeof harness>) => {
    expect(h.of('updateAuthEmail')).toHaveLength(0)
    expect(h.of('updateWaitlistEmailGuarded')).toHaveLength(0)
    expect(h.of('sendEmail')).toHaveLength(0)
    expect(h.of('claimDelivery')).toHaveLength(0) // rejected before claiming the mutex
  }

  it('rejects an invalid replacement email', async () => {
    const h = harness(); const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: 'nope' })
    expect(r.state).toBe('error'); noMutation(h)
  })
  it('rejects a non-invited (wrong status) record → conflict', async () => {
    const h = harness({ status: 'approved' }); const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('conflict'); noMutation(h)
  })
  it('rejects a signed-in auth user → already_activated', async () => {
    const h = harness({ signedIn: true }); const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('already_activated'); noMutation(h)
  })
  it('rejects a user that already has a profile → already_activated', async () => {
    const h = harness({ hasProfile: true }); const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('already_activated'); noMutation(h)
  })
  it('rejects a MISSING auth identity → ambiguous', async () => {
    const h = harness({ authByEmail: {} }); const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('ambiguous'); noMutation(h)
  })
  it('rejects an AMBIGUOUS (duplicate) auth identity → ambiguous', async () => {
    const h = harness({ authByEmail: { [OLD]: { count: 2, user: { id: UID, last_sign_in_at: null } } } })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('ambiguous'); noMutation(h)
  })
  it('rejects when the replacement email already has ANOTHER auth account → conflict', async () => {
    const h = harness({ authByEmail: { [OLD]: { count: 1, user: { id: UID, last_sign_in_at: null } }, [NEW]: { count: 1, user: { id: 'other-uid', last_sign_in_at: null } } } })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('conflict'); noMutation(h)
  })
  it('rejects when the replacement email already has a PROFILE → conflict', async () => {
    const h = harness({ profileAtNew: true }); const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('conflict'); noMutation(h)
  })
  it('rejects when the replacement email is used by another WAITLIST row → conflict', async () => {
    const h = harness({ waitlistConflict: true }); const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('conflict'); noMutation(h)
  })
})

// ── happy path + identity preservation ──────────────────────────────────────────────────
describe('happy path: Auth update → guarded waitlist update → verify → send', () => {
  it('changes both identities and sends ONE secure link; preserves the SAME auth + waitlist ids', async () => {
    const h = harness()
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r).toMatchObject({ ok: true, state: 'changed_and_sent', changed: true, sent: true, deliveryId: DID })

    // Ordering: auth email updated BEFORE the guarded waitlist update.
    const order = h.calls.map((c) => c.name)
    expect(order.indexOf('updateAuthEmail')).toBeLessThan(order.indexOf('updateWaitlistEmailGuarded'))
    // Verification reads happen BEFORE the send.
    expect(order.indexOf('readAuthEmail')).toBeLessThan(order.indexOf('sendEmail'))

    // Same ids throughout — never a create.
    expect(h.of('updateAuthEmail')[0].args).toEqual({ userId: UID, email: NEW })
    expect(h.of('updateWaitlistEmailGuarded')[0].args).toMatchObject({ waitlistId: WID, oldEmail: OLD, newEmail: NEW })
    expect(h.of('claimDelivery')[0].args).toEqual({ authUserId: UID, recipientEmail: NEW })
    expect(h.of('markAccepted')[0].args).toMatchObject({ id: DID, authUserId: UID })

    // Final state converged to the new email on both sides.
    expect(h.authUser.email).toBe(NEW)
    expect(h.wl.email).toBe(NEW)
  })

  it('the secure send is a RECOVERY LINK on the canonical origin, never a password, sent exactly once', async () => {
    const h = harness()
    await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(h.of('sendEmail')).toHaveLength(1)        // exactly one tracked secure invite
    expect(h.of('markAccepted')).toHaveLength(1)
    const sent = h.of('sendEmail')[0].args
    expect(sent.to).toBe(NEW)
    expect(sent.link.startsWith(`${SITE}/auth/recover#`)).toBe(true) // canonical origin
    expect(sent.link).toContain('type=recovery')
    expect(sent.idempotencyKey).toBe(`invite:${DID}`)
    // The sender receives ONLY a link (no password field/value ever).
    expect(Object.keys(sent).sort()).toEqual(['idempotencyKey', 'link', 'to', 'toName'])
  })

  it('generateLink is issued for the new email and the link binds to the SAME preserved auth user', async () => {
    const h = harness()
    await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(h.of('generateLink')[0].args).toEqual({ email: NEW })
    expect(h.of('markAccepted')[0].args.authUserId).toBe(UID) // same user id after replacement
  })

  it('a recovery link that resolves to a DIFFERENT auth user → critical, nothing sent', async () => {
    const h = harness({ linkUserId: 'someone-else' })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('critical')
    expect(h.of('sendEmail')).toHaveLength(0)
    expect(h.of('markFailed')[0].args.errClass).toBe('link_user_mismatch')
  })

  it('the new tracked delivery targets the REPLACEMENT address (claim recipient = new email, purpose access_resend in route)', async () => {
    const h = harness()
    await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(h.of('claimDelivery')[0].args.recipientEmail).toBe(NEW)
    // Only the fresh delivery id is ever touched — the old delivery record is never rewritten here.
    for (const c of [...h.of('markAccepted'), ...h.of('markFailed')]) expect(c.args.id).toBe(DID)
  })
})

// ── compensation + verification ───────────────────────────────────────────────────────
describe('compensated rollback + verification', () => {
  it('a guarded waitlist FAILURE rolls the Auth email back and sends nothing', async () => {
    const h = harness({ guardResult: { rows: 0 } })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('conflict')
    expect(r.changed).toBe(false)
    // Auth updated to NEW then restored to OLD.
    expect(h.of('updateAuthEmail').map((c) => c.args.email)).toEqual([NEW, OLD])
    expect(h.authUser.email).toBe(OLD) // restored
    expect(h.of('sendEmail')).toHaveLength(0)
    expect(h.of('markFailed')[0].args).toMatchObject({ id: DID, errClass: 'waitlist_guard_failed' })
  })

  it('a unique-violation on the waitlist update rolls back and reports a conflict', async () => {
    const h = harness({ guardResult: { rows: 0, uniqueViolation: true, error: true } })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('conflict')
    expect(h.of('markFailed')[0].args.errClass).toBe('waitlist_email_conflict')
    expect(h.authUser.email).toBe(OLD)
  })

  it('a FAILED rollback returns CRITICAL and sends nothing (no silent divergence swept under the rug)', async () => {
    const h = harness({ guardResult: { rows: 0 }, authUpdateResults: [true, false] }) // new ok, restore FAILS
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('critical')
    expect(r.changed).toBe(true) // divergent — needs manual repair
    expect(h.of('sendEmail')).toHaveLength(0)
    expect(h.of('markFailed')[0].args.errClass).toBe('compensation_failed')
  })

  it('an UNEXPECTED THROW from the waitlist update still compensates the Auth email', async () => {
    const h = harness({ guardThrows: true })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('conflict')
    expect(h.of('updateAuthEmail').map((c) => c.args.email)).toEqual([NEW, OLD]) // changed then restored
    expect(h.authUser.email).toBe(OLD)
    expect(h.of('sendEmail')).toHaveLength(0)
  })
  it('a throw during the waitlist update whose compensation ALSO fails → critical, nothing sent', async () => {
    const h = harness({ guardThrows: true, authUpdateResults: [true, false] })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('critical')
    expect(h.of('sendEmail')).toHaveLength(0)
    expect(h.of('markFailed')[0].args.errClass).toBe('compensation_failed')
  })

  it('post-update verification MISMATCH → critical, nothing sent', async () => {
    const h = harness({ breakVerifyAuth: true }) // waitlist moved, but auth read still shows OLD
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('critical')
    expect(h.of('sendEmail')).toHaveLength(0)
    expect(h.of('markFailed')[0].args.errClass).toBe('verify_mismatch')
  })
})

// ── recipient binding (blocker: (waitlist_id, purpose) unique, not recipient) ────────────
describe('the delivery claim can never drift to the wrong recipient', () => {
  const activeClaim = (recipient: string, stale = false) => ({ deliveryId: 'old-del', isNew: false, existingStatus: 'claimed', stale, existingRecipient: recipient })

  it('an active claim bound to a DIFFERENT (old) address → needs_review BEFORE any Auth/waitlist change', async () => {
    const h = harness({ claim: activeClaim('robert.broadbent@wbd-us.com') })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('needs_review')
    expect(r.changed).toBe(false)
    // Nothing mutated, nothing sent, and the existing delivery is never rewritten (no mark* on it).
    expect(h.of('updateAuthEmail')).toHaveLength(0)
    expect(h.of('updateWaitlistEmailGuarded')).toHaveLength(0)
    expect(h.of('sendEmail')).toHaveLength(0)
    expect(h.of('markFailed')).toHaveLength(0)
    expect(h.of('markAccepted')).toHaveLength(0)
  })
  it('a claim with an UNKNOWN (null) recipient fails closed to needs_review', async () => {
    const h = harness({ claim: { deliveryId: 'old-del', isNew: false, existingStatus: 'accepted', stale: false, existingRecipient: null } })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('needs_review')
    expect(h.of('updateAuthEmail')).toHaveLength(0)
  })
  it('an in-flight claim bound to the SAME (new) address → pending (our own double-click), no mutation', async () => {
    const h = harness({ claim: activeClaim(NEW, false) })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('pending')
    expect(h.of('updateAuthEmail')).toHaveLength(0)
    expect(h.of('sendEmail')).toHaveLength(0)
  })
  it('a stale claim bound to the SAME (new) address past 24h → needs_review', async () => {
    const h = harness({ claim: activeClaim(NEW, true) })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('needs_review')
  })
})

// ── delivery-outcome handling (identity kept) ───────────────────────────────────────────
describe('delivery outcomes keep the updated identity (never roll back for a send failure)', () => {
  it('a provider send FAILURE → changed_send_failed, retryable, identity kept', async () => {
    const h = harness({ send: { success: false, errorClass: 'provider_error' } })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r).toMatchObject({ ok: false, state: 'changed_send_failed', changed: true, sent: false })
    expect(h.authUser.email).toBe(NEW) // NOT rolled back
    expect(h.wl.email).toBe(NEW)
    expect(h.of('updateAuthEmail').map((c) => c.args.email)).toEqual([NEW]) // no restore call
    expect(h.of('markFailed')[0].args.errClass).toBe('provider_error')
  })

  it('an UNCERTAIN provider outcome → changed_send_uncertain, claim left in-flight (no accept/fail)', async () => {
    const h = harness({ send: { success: false, uncertain: true } })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('changed_send_uncertain')
    expect(h.authUser.email).toBe(NEW)
    expect(h.of('markAccepted')).toHaveLength(0)
    expect(h.of('markFailed')).toHaveLength(0)
  })

  it('link generation failure → changed_send_failed (identity kept)', async () => {
    const h = harness({ genThrows: true })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('changed_send_failed')
    expect(h.authUser.email).toBe(NEW)
    expect(h.of('sendEmail')).toHaveLength(0)
    expect(h.of('markFailed')[0].args.errClass).toBe('link_generation_failed')
  })
})

// ── idempotency / concurrency ───────────────────────────────────────────────────────────
describe('idempotency + concurrency', () => {
  it('an in-flight claim for the SAME address (isNew=false) → pending, NOTHING mutated', async () => {
    const h = harness({ claim: { deliveryId: DID, isNew: false, existingStatus: 'claimed', stale: false, existingRecipient: NEW } })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('pending')
    expect(h.of('updateAuthEmail')).toHaveLength(0)
    expect(h.of('updateWaitlistEmailGuarded')).toHaveLength(0)
    expect(h.of('sendEmail')).toHaveLength(0)
  })
  it('a STALE unresolved claim (same address) past 24h → needs_review, nothing mutated', async () => {
    const h = harness({ claim: { deliveryId: DID, isNew: false, existingStatus: 'claimed', stale: true, existingRecipient: NEW } })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('needs_review')
    expect(h.of('updateAuthEmail')).toHaveLength(0)
  })
  it('a claim that could not be persisted → unavailable (fail closed, nothing mutated)', async () => {
    const h = harness({ claim: { deliveryId: null, isNew: false, claimFailed: true } })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('unavailable')
    expect(h.of('updateAuthEmail')).toHaveLength(0)
    expect(h.of('sendEmail')).toHaveLength(0)
  })
  it('ALREADY at the new email (idempotent re-call) → resend only, NO identity mutation', async () => {
    const h = harness({ rowEmail: NEW, authByEmail: { [NEW]: { count: 1, user: { id: UID, last_sign_in_at: null } } } })
    const r = await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(r.state).toBe('already_current')
    expect(r.sent).toBe(true)
    expect(h.of('updateAuthEmail')).toHaveLength(0)      // no auth mutation
    expect(h.of('updateWaitlistEmailGuarded')).toHaveLength(0) // no waitlist mutation
    expect(h.of('sendEmail')).toHaveLength(1)             // a fresh secure link IS (re)claimed+sent
  })
})

// ── privacy (results + logs carry no identity) ─────────────────────────────────────────
describe('no sensitive values in results or logs', () => {
  it('the result message never contains an email / uuid / token', async () => {
    for (const cfg of [{}, { guardResult: { rows: 0 } }, { send: { success: false, errorClass: 'x' } }, { breakVerifyAuth: true }] as Cfg[]) {
      const r = await run(cfg)
      const m = r.message ?? ''
      for (const secret of [OLD, OLD_RAW, NEW, UID, WID, DID, 'HT-secret-token']) expect(m).not.toContain(secret)
      expect(m).not.toContain('@')
    }
  })
  it('logs emit event + coarse fields ONLY (no email/uuid/token values)', async () => {
    const h = harness({ send: { success: false, errorClass: 'provider_error' } })
    await changeInviteEmail(h.deps, { waitlistId: WID, newEmail: NEW })
    expect(h.logs.length).toBeGreaterThan(0)
    const dump = JSON.stringify(h.logs)
    for (const secret of [OLD, OLD_RAW, NEW, UID, WID, DID, 'HT-secret-token']) expect(dump).not.toContain(secret)
    expect(dump).not.toContain('@')
  })
})

// ── structural guarantees (no create paths / never a password) ─────────────────────────
describe('structural guarantees', () => {
  const src = readFileSync('lib/invitations/changeInviteEmail.ts', 'utf8')
  it('the orchestrator never creates a user/profile/waitlist row and never mints a password', () => {
    expect(src).not.toMatch(/createUser|signUp|\.insert\(/i)
    // No password is ever minted/set (the word only appears in comments / the reset-password path).
    expect(src).not.toMatch(/generatePassword|temp.?password|password\s*[:=]/i)
    // it uses the recovery link builder (passwordless).
    expect(src).toContain("buildRecoverLink")
    expect(src).toContain("type: 'recovery'")
  })
})

// ── auth lookup pagination + canonical URL (real helpers) ───────────────────────────────
describe('lookupAuthUsersByEmail — complete pagination, fails closed on 0 / >1', () => {
  const pagedAdmin = (pages: any[][]) => ({ auth: { admin: { listUsers: async ({ page }: any) => ({ data: { users: pages[page - 1] ?? [] }, error: null }) } } })
  const users = (n: number, email: string) => Array.from({ length: n }, (_, i) => ({ id: `${email}-${i}`, email, last_sign_in_at: null }))

  it('scans PAST a full 1000-row page to find a later match', async () => {
    const admin = pagedAdmin([users(1000, 'noise@x.com'), [{ id: 'T', email: 'Target@X.com', last_sign_in_at: null }]])
    const r = await lookupAuthUsersByEmail(admin as any, 'target@x.com')
    expect(r.count).toBe(1); expect(r.user?.id).toBe('T')
  })
  it('counts duplicates spread ACROSS pages (→ ambiguous)', async () => {
    const p1 = [...users(999, 'noise@x.com'), { id: 'A', email: 'dup@x.com', last_sign_in_at: null }] // 1000 → next page
    const admin = pagedAdmin([p1, [{ id: 'B', email: 'DUP@x.com', last_sign_in_at: null }]])
    const r = await lookupAuthUsersByEmail(admin as any, 'dup@x.com')
    expect(r.count).toBe(2)
  })
  it('zero matches → count 0, user null', async () => {
    const admin = pagedAdmin([users(3, 'other@x.com')])
    const r = await lookupAuthUsersByEmail(admin as any, 'nobody@x.com')
    expect(r.count).toBe(0); expect(r.user).toBeNull()
  })
})

describe('canonical recovery URL', () => {
  it('builds on the configured origin, strips a trailing slash, keeps the token in the FRAGMENT', () => {
    const link = buildRecoverLink({ siteUrl: 'https://www.andrel.app/', hashedToken: 'HT', type: 'recovery' })
    expect(link.startsWith('https://www.andrel.app/auth/recover#')).toBe(true)
    expect(link).not.toContain('andrel.app//auth')  // trailing slash stripped
    expect(link).toContain('token_hash=HT')
    expect(link).toContain('type=recovery')
    expect(link.split('#')[0]).not.toContain('HT')  // token never in the server-visible path/query
  })
})
