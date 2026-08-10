import { describe, it, expect } from 'vitest'
import { inviteStatusModel, INVITE_RETRY_WINDOW_MS } from '@/lib/waitlist/inviteStatus'

// The ONE admin invitation-state model. Pins every display state + its action affordances and
// the privacy invariant that invited_at ALONE never reads as "Delivered".
const NOW = Date.parse('2026-08-10T12:00:00Z')
const model = (o: Partial<Parameters<typeof inviteStatusModel>[0]> = {}) =>
  inviteStatusModel({ waitlistStatus: 'invited', invitedAt: null, profileComplete: false, delivery: null, nowMs: NOW, ...o })

describe('inviteStatusModel — precedence & activation', () => {
  it('an activated member is terminal: no invitation action, even with a delivery record', () => {
    const m = model({ profileComplete: true, delivery: { status: 'bounced' }, invitedAt: '2026-01-01T00:00:00Z' })
    expect(m.key).toBe('activated')
    expect(m.noAction).toBe(true)
    expect(m.canResend).toBe(false)
    expect(m.canRetry).toBe(false)
  })
})

describe('inviteStatusModel — durable delivery states', () => {
  const cases: Array<[string, string, string, Partial<Record<'canResend' | 'canRetry' | 'needsConfirmResend', boolean>>]> = [
    ['claimed',    'sending',    'Delivery status pending',  {}],                    // within window → DO NOT resend
    ['accepted',   'accepted',   'Accepted by provider',     {}],                    // awaiting delivery → DO NOT resend
    ['delivered',  'delivered',  'Delivered',                { needsConfirmResend: true }],
    ['deferred',   'deferred',   'Deferred—delivery pending', {}],                   // in-flight → DO NOT resend
    ['bounced',    'bounced',    'Bounced',                  {}],
    ['blocked',    'blocked',    'Suppressed / blocked',     {}],
    ['complained', 'complained', 'Complained',               {}],
    ['failed',     'failed',     'Failed—retry available',   { canRetry: true }],
  ]
  for (const [status, key, label, flags] of cases) {
    it(`delivery '${status}' → ${key} / "${label}"`, () => {
      const m = model({ delivery: { status } })
      expect(m.key).toBe(key)
      expect(m.label).toBe(label)
      expect(m.canResend).toBe(!!flags.canResend)
      expect(m.canRetry).toBe(!!flags.canRetry)
      expect(m.needsConfirmResend).toBe(!!flags.needsConfirmResend)
    })
  }

  it('claimed within the window → "Delivery status pending", NO action at all (do not resend)', () => {
    const m = model({ delivery: { status: 'claimed', attemptedAt: new Date(NOW - 60_000).toISOString() } })
    expect(m.key).toBe('sending')
    expect(m.canRetry).toBe(false)          // NOT a same-key retry (would be a 409 changed-payload)
    expect(m.canResend).toBe(false)
    expect(m.needsConfirmResend).toBe(false)
    expect(m.tooltip).toMatch(/do not resend/i)
  })
  it('claimed PAST the 24h window → "stale", warning, requires confirmation for a NEW attempt', () => {
    const m = model({ delivery: { status: 'claimed', attemptedAt: new Date(NOW - INVITE_RETRY_WINDOW_MS - 1000).toISOString() } })
    expect(m.key).toBe('stale')
    expect(m.tone).toBe('warning')
    expect(m.needsConfirmResend).toBe(true) // explicit review → new attempt (force)
    expect(m.canRetry).toBe(false)          // never a silent same-key resume
    expect(m.canResend).toBe(false)
  })
  it('claimed with NO timestamp defaults to pending, not stale (never silently retired)', () => {
    const m = model({ delivery: { status: 'claimed' } })
    expect(m.key).toBe('sending')
  })
  it('accepted offers NO resend (awaiting delivery; do not resend within the window)', () => {
    const m = model({ delivery: { status: 'accepted' } })
    expect(m.canResend).toBe(false)
    expect(m.canRetry).toBe(false)
    expect(m.needsConfirmResend).toBe(false)
    expect(m.tooltip).toMatch(/do not resend/i)
  })
  it('deferred offers NO blind resend (still in flight)', () => {
    const m = model({ delivery: { status: 'deferred' } })
    expect(m.canResend).toBe(false)
    expect(m.canRetry).toBe(false)
    expect(m.needsConfirmResend).toBe(false)
    expect(m.tooltip).toMatch(/do not resend/i)
  })
  it('accepted/deferred INSIDE the window → pending (no resend); OUTSIDE → stale (review + new attempt)', () => {
    const fresh = new Date(NOW - 60_000).toISOString()
    const old = new Date(NOW - INVITE_RETRY_WINDOW_MS - 1000).toISOString()
    for (const status of ['accepted', 'deferred']) {
      const inside = model({ delivery: { status, attemptedAt: fresh } })
      expect(inside.key).toBe(status)             // still its in-flight state
      expect(inside.needsConfirmResend).toBe(false)
      const outside = model({ delivery: { status, attemptedAt: old } })
      expect(outside.key).toBe('stale')           // lost-webhook safety valve
      expect(outside.needsConfirmResend).toBe(true)
      expect(outside.canResend).toBe(false)
    }
  })

  it('bounced / blocked / complained all DISABLE a blind resend', () => {
    for (const status of ['bounced', 'blocked', 'complained']) {
      const m = model({ delivery: { status } })
      expect(m.canResend).toBe(false)
      expect(m.canRetry).toBe(false)
      expect(m.tone).toBe('danger')
    }
  })

  it('accepted vs delivered are DISTINCT and their tooltips explain the difference', () => {
    const acc = model({ delivery: { status: 'accepted' } })
    const del = model({ delivery: { status: 'delivered' } })
    expect(acc.key).not.toBe(del.key)
    expect(acc.tooltip).toMatch(/not.*proof of inbox delivery/i)
    expect(del.tooltip).toMatch(/delivered/i)
  })
})

describe('inviteStatusModel — records absent (privacy invariant)', () => {
  it('invited WITH invited_at but no durable record → "Delivery status unavailable" (NOT Delivered)', () => {
    const m = model({ waitlistStatus: 'invited', invitedAt: '2026-01-01T00:00:00Z', delivery: null })
    expect(m.key).toBe('unavailable')
    expect(m.label).not.toMatch(/delivered/i)
    expect(m.canResend).toBe(true) // a fresh secure link is allowed
  })
  it('invited WITHOUT invited_at (reinstated / never sent) → "Invitation not sent"', () => {
    const m = model({ waitlistStatus: 'invited', invitedAt: null, delivery: null })
    expect(m.key).toBe('not_sent')
    expect(m.label).toBe('Invitation not sent')
    expect(m.canResend).toBe(true)
  })
  it('an unrecognized delivery status fails safe to "unavailable" with a resend option', () => {
    const m = model({ delivery: { status: 'weird_future_status' } })
    expect(m.key).toBe('unavailable')
    expect(m.canResend).toBe(true)
  })
})
