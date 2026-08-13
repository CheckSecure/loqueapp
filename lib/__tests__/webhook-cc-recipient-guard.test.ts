import { describe, it, expect } from 'vitest'
import { applyDeliveryEvent } from '@/lib/invitations/delivery'

/**
 * Official Resend webhook payload shape (v6-era), for reference — the event is MESSAGE-level: `data.to`
 * is the To list and (when present) `data.cc` the CC list, but the payload does NOT reliably say WHICH
 * mailbox produced a bounce/complaint/delivery on a multi-recipient message. So we do NOT try to
 * attribute per-mailbox; a send that had additional recipients (has_additional_recipients=true) is
 * frozen at provider-'accepted'. NO CC/BCC address is stored — only the boolean fact.
 *
 *   email.delivered: { data: { email_id, from, to:[nominee], subject, created_at } }
 *   email.bounced:   { data: { email_id, from, to:[nominee], subject, bounce:{type,subType,message}, created_at } }
 *   email.complained/failed/delivery_delayed: same shape (message-level; no per-recipient attribution)
 */

function fakeAdmin(deliveryRow: any) {
  const events: any[] = []
  const deliveryUpdates: any[] = []
  return {
    _deliveryUpdates: () => deliveryUpdates,
    from(table: string) {
      if (table === 'invitation_delivery_events') {
        return {
          insert: async (r: any) => { if (events.some((e) => e.svix_id === r.svix_id)) return { error: { code: '23505' } }; events.push({ ...r }); return { error: null } },
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: events[0] ?? null }) }) }),
          update: (p: any) => ({ eq: async (_c: string, v: string) => { const e = events.find((x) => x.svix_id === v); if (e) Object.assign(e, p); return { error: null } } }),
        }
      }
      const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: deliveryRow, error: null }), update: (p: any) => ({ eq: async () => { deliveryUpdates.push(p); return { error: null } } }) }
      return b
    },
  }
}
const evt = (over: any = {}) => ({ svixId: `s_${Math.random().toString(36).slice(2)}`, providerMessageId: 'm1', eventType: 'email.delivered', eventCreatedAt: '2026-08-13T00:00:00Z', status: 'delivered' as const, ...over })
const ccRow = { id: 'd1', status: 'accepted', last_event_at: null, has_additional_recipients: true }
const plainRow = { id: 'd2', status: 'accepted', last_event_at: null, has_additional_recipients: false }

describe('applyDeliveryEvent — multi-recipient fail-safe (CC/BCC sends frozen at provider-accepted)', () => {
  it('a multi-recipient delivery FREEZES on a bounce — nominee is never marked bounced by a possible CC bounce', async () => {
    const a = fakeAdmin(ccRow)
    expect(await applyDeliveryEvent(a as any, evt({ eventType: 'email.bounced', status: 'bounced' }))).toBe('ignored')
    expect(a._deliveryUpdates()).toHaveLength(0)
  })
  it('a multi-recipient delivery FREEZES on a delivered event too — never marks the nominee delivered on the CC mailbox', async () => {
    const a = fakeAdmin(ccRow)
    expect(await applyDeliveryEvent(a as any, evt({ status: 'delivered' }))).toBe('ignored')
    expect(a._deliveryUpdates()).toHaveLength(0) // state stays 'accepted' (provider-accepted preserved)
  })
  it('a multi-recipient delivery FREEZES on complained/failed/blocked (no auto-resend, no state change)', async () => {
    for (const [t, s] of [['email.complained', 'complained'], ['email.failed', 'failed'], ['email.suppressed', 'blocked']] as const) {
      const a = fakeAdmin(ccRow)
      expect(await applyDeliveryEvent(a as any, evt({ eventType: t, status: s }))).toBe('ignored')
      expect(a._deliveryUpdates()).toHaveLength(0)
    }
  })
  it('a single-recipient delivery applies events normally (legacy invites unchanged)', async () => {
    const a = fakeAdmin(plainRow)
    expect(await applyDeliveryEvent(a as any, evt({ status: 'delivered' }))).toBe('applied')
    expect(a._deliveryUpdates()[0]).toMatchObject({ status: 'delivered' })
    const a2 = fakeAdmin(plainRow)
    expect(await applyDeliveryEvent(a2 as any, evt({ eventType: 'email.bounced', status: 'bounced' }))).toBe('applied')
  })
  it('a missing has_additional_recipients column (pre-migration) → treated as single-recipient (legacy apply)', async () => {
    const a = fakeAdmin({ id: 'd3', status: 'accepted', last_event_at: null }) // no has_additional_recipients key
    expect(await applyDeliveryEvent(a as any, evt({ status: 'delivered' }))).toBe('applied')
  })
})
