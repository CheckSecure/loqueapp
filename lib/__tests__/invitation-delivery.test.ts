import { describe, it, expect, beforeEach } from 'vitest'
import { claimInviteDelivery, markDeliveryAccepted, applyDeliveryEvent } from '@/lib/invitations/delivery'
import { mapResendEvent, shouldApplyStatus, isTerminal, type DeliveryStatus } from '@/lib/webhooks/resendVerify'

// In-memory fake of invitation_deliveries + invitation_delivery_events with the two unique
// constraints the schema enforces: active-claim (waitlist_id,purpose) and svix_id.
// Active/in-flight statuses that block a second claim (mirrors the migration's partial index).
const ACTIVE_CLAIM = ['claimed', 'accepted', 'deferred']
function fakeAdmin() {
  const deliveries: any[] = []
  const events: any[] = []
  // Test controls: fail the NEXT N deliveries UPDATEs (models a partial DB failure mid-apply).
  const control = { failDeliveryUpdate: 0 }
  let seq = 0
  const q = (table: string) => {
    const rows = table === 'invitation_deliveries' ? deliveries : events
    let op: 'insert' | 'select' | 'update' = 'select'
    let insertRow: any = null
    let updatePatch: any = null
    const eqs: [string, any][] = []
    const ins: [string, any[]][] = []
    const match = () => rows.filter((r) => eqs.every(([c, v]) => r[c] === v) && ins.every(([c, a]) => a.includes(r[c])))
    const b: any = {
      insert(r: any) { op = 'insert'; insertRow = { ...r }; return b },
      select() { op = op === 'insert' ? 'insert' : 'select'; return b },
      update(p: any) { op = 'update'; updatePatch = p; return b },
      eq(c: string, v: any) { eqs.push([c, v]); return b },
      in(c: string, a: any[]) { ins.push([c, a]); return b },
      order() { return b },
      limit() { return b },
      maybeSingle() { return Promise.resolve({ data: match()[0] ?? null, error: null }) },
      single() {
        if (op === 'insert') return this.then()
        return Promise.resolve({ data: match()[0] ?? null, error: null })
      },
      then(res: any, rej: any) {
        if (op === 'insert') {
          // enforce unique constraints
          if (table === 'invitation_delivery_events' && events.some((e) => e.svix_id === insertRow.svix_id)) {
            return Promise.resolve({ data: null, error: { code: '23505' } }).then(res, rej)
          }
          if (table === 'invitation_deliveries' && ACTIVE_CLAIM.includes(insertRow.status) &&
              deliveries.some((d) => d.waitlist_id === insertRow.waitlist_id && d.purpose === insertRow.purpose && ACTIVE_CLAIM.includes(d.status))) {
            return Promise.resolve({ data: null, error: { code: '23505' } }).then(res, rej)
          }
          const row = { id: 'row_' + (++seq), ...insertRow }
          rows.push(row)
          return Promise.resolve({ data: { id: row.id }, error: null }).then(res, rej)
        }
        if (op === 'update') {
          // Inject a partial failure on the deliveries UPDATE (the crash point in blocker #1).
          if (table === 'invitation_deliveries' && control.failDeliveryUpdate > 0) {
            control.failDeliveryUpdate--
            return Promise.resolve({ data: null, error: { code: 'XX000', message: 'update failed' } }).then(res, rej)
          }
          for (const r of match()) Object.assign(r, updatePatch)
          return Promise.resolve({ data: null, error: null }).then(res, rej)
        }
        return Promise.resolve({ data: match(), error: null }).then(res, rej)
      },
    }
    return b
  }
  return { from: q, _deliveries: deliveries, _events: events, _control: control }
}

// The (waitlist_id, purpose) active-claim index is NOT keyed on recipient. Prove that a NEW-address
// claim against an existing OLD-address access_resend behaves safely for EVERY prior status, and that
// the existing row's recipient/id are surfaced but never rewritten.
describe('claimInviteDelivery — recipient binding across an existing old-address access_resend', () => {
  const OLDR = 'robert.broadbent@wbd-us.com'
  const NEWR = 'broadbent2@hotmail.com'
  const seed = (admin: any, status: string) => admin._deliveries.push({
    id: 'old_del', waitlist_id: 'w1', purpose: 'access_resend', recipient_email: OLDR, status,
    attempted_at: new Date().toISOString(),
  })
  const claimNew = (admin: any) => claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: 'u', email: NEWR, purpose: 'access_resend' })

  for (const status of ['claimed', 'accepted', 'deferred']) {
    it(`ACTIVE '${status}' old-address delivery BLOCKS a new-address claim (isNew=false, old recipient surfaced, row untouched)`, async () => {
      const admin = fakeAdmin(); seed(admin, status)
      const r = await claimNew(admin)
      expect(r.isNew).toBe(false)
      expect(r.deliveryId).toBe('old_del')          // resolves onto the EXISTING row, never a new one
      expect(r.existingStatus).toBe(status)
      expect(r.existingRecipient).toBe(OLDR)        // stored recipient surfaced …
      expect(admin._deliveries).toHaveLength(1)     // … no new row inserted …
      expect(admin._deliveries[0].recipient_email).toBe(OLDR) // … and never rewritten.
    })
  }
  for (const status of ['delivered', 'bounced', 'failed']) {
    it(`TERMINAL '${status}' old-address delivery ALLOWS a fresh new-address claim (isNew=true, new row bound to new recipient, old row immutable)`, async () => {
      const admin = fakeAdmin(); seed(admin, status)
      const r = await claimNew(admin)
      expect(r.isNew).toBe(true)
      expect(admin._deliveries).toHaveLength(2)     // a NEW row alongside the untouched old one
      const oldRow = admin._deliveries.find((d: any) => d.id === 'old_del')
      expect(oldRow.recipient_email).toBe(OLDR); expect(oldRow.status).toBe(status) // immutable history
      const newRow = admin._deliveries.find((d: any) => d.id !== 'old_del')
      expect(newRow.recipient_email).toBe(NEWR)     // fresh delivery bound to the NEW recipient
      expect(newRow.status).toBe('claimed')
    })
  }
})

describe('claimInviteDelivery — pre-send atomic claim (one active attempt / waitlist+purpose)', () => {
  it('first claim is new; a concurrent second resolves onto the SAME claim (no duplicate send)', async () => {
    const admin = fakeAdmin()
    const a = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    expect(a.isNew).toBe(true)
    const b = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    expect(b.isNew).toBe(false)                 // hit the active-claim unique → no-op
    expect(b.deliveryId).toBe(a.deliveryId)     // resolves onto the same attempt
    expect(admin._deliveries).toHaveLength(1)   // exactly ONE attempt row
  })
  it('after a terminal (failed) attempt, a fresh claim is allowed', async () => {
    const admin = fakeAdmin()
    const a = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    admin._deliveries[0].status = 'failed' // simulate a definite failure
    const b = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    expect(b.isNew).toBe(true)
    expect(a.deliveryId).not.toBe(b.deliveryId)
  })
  it('a DEFERRED (in-flight) attempt still blocks a blind new claim', async () => {
    const admin = fakeAdmin()
    const a = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    admin._deliveries[0].status = 'deferred' // provider delayed → still in flight
    const b = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    expect(b.isNew).toBe(false)              // hit the active-claim unique → no second send
    expect(b.existingStatus).toBe('deferred')
    expect(b.deliveryId).toBe(a.deliveryId)
    expect(admin._deliveries).toHaveLength(1)
  })
  it('an existing claim within 24h is NOT stale; past 24h it IS stale', async () => {
    const admin = fakeAdmin()
    await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    const fresh = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    expect(fresh.isNew).toBe(false)
    expect(fresh.existingStatus).toBe('claimed')
    expect(fresh.stale).toBe(false) // just claimed → within window
    admin._deliveries[0].attempted_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    const aged = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    expect(aged.stale).toBe(true) // > 24h → stale
  })
})

describe('claimInviteDelivery — FAILS CLOSED (migration 049 mandatory)', () => {
  // A fake that errors on the invitation_deliveries INSERT with a given pg code.
  const failingInsertAdmin = (code: string, message: string) => ({
    from: (_t: string) => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code, message } }) }) }),
    }),
  })
  it('missing table (42P01) → claimFailed, no id (caller must not send)', async () => {
    const admin = failingInsertAdmin('42P01', 'relation "invitation_deliveries" does not exist')
    const r = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    expect(r.claimFailed).toBe(true)
    expect(r.isNew).toBe(false)
    expect(r.deliveryId).toBeNull()
  })
  it('permission error (42501) → claimFailed', async () => {
    const admin = failingInsertAdmin('42501', 'permission denied for table invitation_deliveries')
    const r = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    expect(r.claimFailed).toBe(true)
  })
  it('transient DB error → claimFailed (never a blind untracked send)', async () => {
    const admin = failingInsertAdmin('08006', 'connection failure')
    const r = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    expect(r.claimFailed).toBe(true)
  })
  it('insert "succeeds" but returns no id → claimFailed (defensive, still no send)', async () => {
    const admin = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }) }) }
    const r = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    expect(r.claimFailed).toBe(true)
  })
  it('unique-violation but the existing claim cannot be READ → claimFailed (fail closed, no blind send)', async () => {
    const admin = {
      from: () => ({
        insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: '23505' } }) }) }),
        select: () => ({ eq: () => ({ eq: () => ({ in: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: { code: '42501', message: 'permission denied' } }) }) }) }) }) }) }),
      }),
    }
    const r = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    expect(r.claimFailed).toBe(true)
  })
})

describe('webhook resolves a pending (accepted) claim', () => {
  it('a claim advanced to accepted (message id stored) is resolved to delivered by the webhook', async () => {
    const admin = fakeAdmin()
    const c = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    await markDeliveryAccepted(admin as any, c.deliveryId, 'msg_9', 'u1') // send accepted → status accepted, msg id stored
    expect(admin._deliveries[0].status).toBe('accepted')
    const out = await applyDeliveryEvent(admin as any, { svixId: 's1', providerMessageId: 'msg_9', eventType: 'email.delivered', eventCreatedAt: '2026-08-10T00:05:00Z', status: 'delivered' })
    expect(out).toBe('applied')
    expect(admin._deliveries[0].status).toBe('delivered') // claim resolved by the webhook
  })
})

describe('applyDeliveryEvent — replay + ordering + terminal safety', () => {
  let admin: ReturnType<typeof fakeAdmin>
  beforeEach(async () => {
    admin = fakeAdmin()
    const c = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    await markDeliveryAccepted(admin as any, c.deliveryId, 'msg_1', 'u1') // status accepted, provider_message_id=msg_1
  })
  const evt = (svixId: string, status: any, createdAt: string) => applyDeliveryEvent(admin as any, { svixId, providerMessageId: 'msg_1', eventType: 't', eventCreatedAt: createdAt, status })

  it('applies a forward event and records history', async () => {
    expect(await evt('svix_1', 'delivered', '2026-08-10T00:01:00Z')).toBe('applied')
    expect(admin._deliveries[0].status).toBe('delivered')
    expect(admin._events).toHaveLength(1)
  })
  it('duplicate svix_id is a safe no-op', async () => {
    await evt('svix_1', 'delivered', '2026-08-10T00:01:00Z')
    expect(await evt('svix_1', 'delivered', '2026-08-10T00:01:00Z')).toBe('duplicate')
  })
  it('an OLDER out-of-order event cannot overwrite a newer applied state', async () => {
    await evt('svix_2', 'delivered', '2026-08-10T00:05:00Z')
    expect(await evt('svix_3', 'accepted', '2026-08-10T00:01:00Z')).toBe('ignored') // older + lower rank
    expect(admin._deliveries[0].status).toBe('delivered')
  })
  it('a terminal state never regresses (delivered → bounced ignored)', async () => {
    await evt('svix_4', 'delivered', '2026-08-10T00:05:00Z')
    expect(await evt('svix_5', 'bounced', '2026-08-10T00:06:00Z')).toBe('ignored')
    expect(admin._deliveries[0].status).toBe('delivered')
  })
  it('an event for an unknown message id → not_found (retryable, not a completed ack)', async () => {
    expect(await applyDeliveryEvent(admin as any, { svixId: 'svix_x', providerMessageId: 'nope', eventType: 't', eventCreatedAt: '2026-08-10T00:01:00Z', status: 'delivered' })).toBe('not_found')
  })
})

describe('applyDeliveryEvent — recoverable after a partial DB failure (blocker #1)', () => {
  it('event row inserted, delivery UPDATE fails → error; same svix_id retry REAPPLIES to the correct status; later duplicate is a no-op', async () => {
    const admin = fakeAdmin()
    const c = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    await markDeliveryAccepted(admin as any, c.deliveryId, 'msg_1', 'u1')
    const evt = (createdAt: string) => applyDeliveryEvent(admin as any, { svixId: 'svix_1', providerMessageId: 'msg_1', eventType: 'email.delivered', eventCreatedAt: createdAt, status: 'delivered' })

    admin._control.failDeliveryUpdate = 1                 // the delivery UPDATE fails on the first pass
    expect(await evt('2026-08-10T00:05:00Z')).toBe('error')
    expect(admin._deliveries[0].status).toBe('accepted')  // NOT applied yet
    expect(admin._events[0].result).toBe('error')         // event row left RETRYABLE

    // Resend redelivers the same svix_id → we re-apply (prior result was retryable, not terminal).
    expect(await evt('2026-08-10T00:05:00Z')).toBe('applied')
    expect(admin._deliveries[0].status).toBe('delivered') // reaches the correct status
    expect(admin._events[0].result).toBe('applied')

    // Any further redelivery is now a completed duplicate.
    expect(await evt('2026-08-10T00:05:00Z')).toBe('duplicate')
    expect(admin._deliveries[0].status).toBe('delivered')
  })
})

describe('applyDeliveryEvent — provider-message race reconciliation (blocker #2)', () => {
  it('webhook first (no delivery row) → not_found; after the message id is persisted, a retry APPLIES; later retry is a no-op', async () => {
    const admin = fakeAdmin()
    const c = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    const evt = () => applyDeliveryEvent(admin as any, { svixId: 'svix_9', providerMessageId: 'msg_race', eventType: 'email.delivered', eventCreatedAt: '2026-08-10T00:05:00Z', status: 'delivered' })

    // 1–2) Webhook arrives BEFORE markDeliveryAccepted persists provider_message_id.
    expect(await evt()).toBe('not_found')
    expect(admin._events[0].result).toBe('not_found')     // retained, retryable — not acknowledged as done

    // 3) The send finishes and stores the message id.
    await markDeliveryAccepted(admin as any, c.deliveryId, 'msg_race', 'u1')

    // 4) Resend redelivers the same svix_id → now it applies (prior result was retryable).
    expect(await evt()).toBe('applied')
    expect(admin._deliveries[0].status).toBe('delivered') // 5) final state correct
    // 6) later retry → no-op
    expect(await evt()).toBe('duplicate')
  })
})

describe('applyDeliveryEvent — timestamp validation (blocker #5)', () => {
  it('a missing/invalid provider timestamp → invalid, no event row, NO state change', async () => {
    const admin = fakeAdmin()
    const c = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    await markDeliveryAccepted(admin as any, c.deliveryId, 'msg_1', 'u1')
    expect(await applyDeliveryEvent(admin as any, { svixId: 's_bad', providerMessageId: 'msg_1', eventType: 'email.delivered', eventCreatedAt: null, status: 'delivered' })).toBe('invalid')
    expect(await applyDeliveryEvent(admin as any, { svixId: 's_bad2', providerMessageId: 'msg_1', eventType: 'email.delivered', eventCreatedAt: 'not-a-date', status: 'delivered' })).toBe('invalid')
    expect(admin._deliveries[0].status).toBe('accepted') // never overwritten
    expect(admin._events).toHaveLength(0)                 // no row written (never local-time substituted)
  })
})

describe('mapResendEvent — complete Resend event → status matrix', () => {
  const CASES: [string, DeliveryStatus | null][] = [
    ['email.sent', 'accepted'],            // provider accepted — NOT delivery
    ['email.delivered', 'delivered'],
    ['email.delivery_delayed', 'deferred'],
    ['email.bounced', 'bounced'],
    ['email.complained', 'complained'],
    ['email.failed', 'failed'],
    ['email.suppressed', 'blocked'],       // account suppression list
    ['email.opened', null],                // engagement — not a delivery outcome
    ['email.clicked', null],
    ['bogus.event', null],
    ['', null],
  ]
  for (const [event, status] of CASES) {
    it(`${event || '(empty)'} → ${status ?? 'ignored'}`, () => expect(mapResendEvent(event)).toBe(status))
  }
})

describe('shouldApplyStatus — ordering/regression matrix', () => {
  it('any status applies over an empty/undefined current', () => {
    for (const s of ['accepted', 'delivered', 'bounced', 'failed'] as DeliveryStatus[]) expect(shouldApplyStatus(null, s)).toBe(true)
  })
  it('accepted → delivered advances', () => expect(shouldApplyStatus('accepted', 'delivered')).toBe(true))
  it('deferred → delivered advances (delayed then delivered wins)', () => expect(shouldApplyStatus('deferred', 'delivered')).toBe(true))
  it('delivered → delivered is a no-op at the status guard (terminal); true replays are deduped by svix_id', () => expect(shouldApplyStatus('delivered', 'delivered')).toBe(false))
  it('delivered → accepted (a late "sent") does NOT regress', () => expect(shouldApplyStatus('delivered', 'accepted')).toBe(false))
  it('delivered → bounced does NOT regress (terminal)', () => expect(shouldApplyStatus('delivered', 'bounced')).toBe(false))
  it('bounced / blocked / complained are terminal — nothing overwrites them', () => {
    for (const term of ['bounced', 'blocked', 'complained'] as DeliveryStatus[]) {
      expect(isTerminal(term)).toBe(true)
      for (const next of ['delivered', 'accepted', 'deferred', 'failed'] as DeliveryStatus[]) expect(shouldApplyStatus(term, next)).toBe(false)
    }
  })
  it('failed is NOT terminal — a later delivered/bounced can still supersede it (retry can succeed)', () => {
    expect(isTerminal('failed')).toBe(false)
    expect(shouldApplyStatus('failed', 'delivered')).toBe(true)
    expect(shouldApplyStatus('failed', 'bounced')).toBe(true)
  })
})

describe('applyDeliveryEvent — full delivery lifecycle transitions', () => {
  let admin: ReturnType<typeof fakeAdmin>
  beforeEach(async () => {
    admin = fakeAdmin()
    const c = await claimInviteDelivery(admin as any, { waitlistId: 'w1', authUserId: null, email: 'x@y.co', purpose: 'first_invite' })
    await markDeliveryAccepted(admin as any, c.deliveryId, 'msg_1', 'u1')
  })
  const evt = (svixId: string, status: any, createdAt: string) => applyDeliveryEvent(admin as any, { svixId, providerMessageId: 'msg_1', eventType: 't', eventCreatedAt: createdAt, status })

  it('delayed (deferred) then delivered → ends delivered, stamps delivered_at', async () => {
    expect(await evt('s1', 'deferred', '2026-08-10T00:01:00Z')).toBe('applied')
    expect(admin._deliveries[0].status).toBe('deferred')
    expect(await evt('s2', 'delivered', '2026-08-10T00:02:00Z')).toBe('applied')
    expect(admin._deliveries[0].status).toBe('delivered')
    expect(admin._deliveries[0].delivered_at).toBeTruthy()
  })
  it('a late "sent" (accepted) after delivered does not regress', async () => {
    await evt('s1', 'delivered', '2026-08-10T00:02:00Z')
    expect(await evt('s2', 'accepted', '2026-08-10T00:03:00Z')).toBe('ignored')
    expect(admin._deliveries[0].status).toBe('delivered')
  })
  for (const term of ['bounced', 'complained'] as const) {
    it(`${term} is terminal — a subsequent delivered is ignored, failed_at stamped`, async () => {
      expect(await evt('s1', term, '2026-08-10T00:02:00Z')).toBe('applied')
      expect(admin._deliveries[0].status).toBe(term)
      expect(admin._deliveries[0].failed_at).toBeTruthy()
      expect(await evt('s2', 'delivered', '2026-08-10T00:03:00Z')).toBe('ignored')
      expect(admin._deliveries[0].status).toBe(term)
    })
  }
  it('suppressed→blocked is terminal', async () => {
    expect(await evt('s1', 'blocked', '2026-08-10T00:02:00Z')).toBe('applied')
    expect(await evt('s2', 'delivered', '2026-08-10T00:03:00Z')).toBe('ignored')
    expect(admin._deliveries[0].status).toBe('blocked')
  })
  it('persists svix_id and event_created_at on the event log row', async () => {
    await evt('s_persist', 'delivered', '2026-08-10T00:09:00Z')
    const row = admin._events.find((e) => e.svix_id === 's_persist')
    expect(row).toBeTruthy()
    expect(row.event_created_at).toBe('2026-08-10T00:09:00Z')
  })
})
