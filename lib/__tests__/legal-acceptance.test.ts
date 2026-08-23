import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Endpoint mock state (hoisted so the vi.mock factories capture it) ─────────
const h = vi.hoisted(() => ({
  user: { id: 'U1' } as any,
  updates: [] as any[],
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      update: (payload: any) => ({
        eq: async () => { h.updates.push(payload); return { error: null } },
      }),
    }),
  }),
}))

import { needsReacceptance, needsReacceptanceAt, TERMS_VERSION, PRIVACY_VERSION } from '@/lib/legal/terms'
import { POST } from '@/app/api/legal/accept/route'

const req = (body: any) =>
  new Request('http://localhost/api/legal/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify(body),
  })

// ==============================================================================
// Gate logic — grandfathering vs affirmative acceptance
// ==============================================================================
describe('needsReacceptance — grandfathering gate', () => {
  it('Existing V1 grandfathered user is NOT redirected', () => {
    expect(needsReacceptance({
      acceptedTermsVersion: null,
      acceptedPrivacyVersion: null,
      grandfatheredTermsVersion: 1,
      grandfatheredPrivacyVersion: 1,
    })).toBe(false)
  })

  it('New user with all legal fields null IS redirected', () => {
    expect(needsReacceptance({
      acceptedTermsVersion: null,
      acceptedPrivacyVersion: null,
      grandfatheredTermsVersion: null,
      grandfatheredPrivacyVersion: null,
    })).toBe(true)
  })

  it('New profiles are not automatically grandfathered (undefined == not exempt)', () => {
    expect(needsReacceptance({})).toBe(true)
  })

  it('User who affirmatively accepts the current versions is NOT redirected', () => {
    expect(needsReacceptance({
      acceptedTermsVersion: TERMS_VERSION,
      acceptedPrivacyVersion: PRIVACY_VERSION,
      grandfatheredTermsVersion: null,
      grandfatheredPrivacyVersion: null,
    })).toBe(false)
  })

  it('Grandfathering is never represented as affirmative acceptance', () => {
    // A grandfathered user satisfies the GATE (not redirected) while their
    // accepted-version fields remain null — i.e. exemption ≠ acceptance.
    const grandfathered = {
      acceptedTermsVersion: null,
      acceptedPrivacyVersion: null,
      grandfatheredTermsVersion: 1,
      grandfatheredPrivacyVersion: 1,
    }
    expect(needsReacceptance(grandfathered)).toBe(false)     // exempt from the gate
    expect(grandfathered.acceptedTermsVersion).toBeNull()     // but NOT recorded as accepted
    expect(grandfathered.acceptedPrivacyVersion).toBeNull()
  })
})

describe('needsReacceptanceAt — a later version bump re-gates grandfathered users', () => {
  const grandfatheredThroughV1 = {
    acceptedTermsVersion: null,
    acceptedPrivacyVersion: null,
    grandfatheredTermsVersion: 1,
    grandfatheredPrivacyVersion: 1,
  }

  it('V1 grandfathered user IS redirected when Terms becomes Version 2', () => {
    expect(needsReacceptanceAt(2, 1, grandfatheredThroughV1)).toBe(true)
  })

  it('V1 grandfathered user IS redirected when Privacy becomes Version 2', () => {
    expect(needsReacceptanceAt(1, 2, grandfatheredThroughV1)).toBe(true)
  })

  it('after affirmatively accepting v2, the user is satisfied again', () => {
    expect(needsReacceptanceAt(2, 2, {
      acceptedTermsVersion: 2,
      acceptedPrivacyVersion: 2,
      grandfatheredTermsVersion: 1, // grandfathering retained as audit; no longer needed
      grandfatheredPrivacyVersion: 1,
    })).toBe(false)
  })

  it('null-safe: no signals at all → must accept', () => {
    expect(needsReacceptanceAt(1, 1, {})).toBe(true)
  })
})

// ==============================================================================
// Acceptance endpoint — writes affirmative acceptance, never grandfathering
// ==============================================================================
describe('POST /api/legal/accept', () => {
  beforeEach(() => { h.updates.length = 0; h.user = { id: 'U1' } })

  it('Declining/partial acceptance does NOT write acceptance values (400, no update)', async () => {
    const res = await POST(req({ acceptTerms: false, acceptPrivacy: true }))
    expect(res.status).toBe(400)
    expect(h.updates).toHaveLength(0)
  })

  it('Abandoning (empty body) does NOT write acceptance values', async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect(h.updates).toHaveLength(0)
  })

  it('Affirmatively accepting BOTH writes the current accepted versions + timestamps, and never touches grandfathering fields', async () => {
    const res = await POST(req({ acceptTerms: true, acceptPrivacy: true }))
    expect(res.status).toBe(200)
    expect(h.updates).toHaveLength(1)
    const payload = h.updates[0]
    expect(payload.terms_version_accepted).toBe(TERMS_VERSION)
    expect(payload.privacy_version_accepted).toBe(PRIVACY_VERSION)
    expect(typeof payload.terms_accepted_at).toBe('string')
    expect(typeof payload.privacy_accepted_at).toBe('string')
    // Grandfathering columns are audit-only and must never be written here.
    expect(payload).not.toHaveProperty('terms_grandfathered_through_version')
    expect(payload).not.toHaveProperty('privacy_grandfathered_through_version')
    expect(payload).not.toHaveProperty('legal_grandfathered_at')
  })

  it('Unauthorized when there is no user', async () => {
    h.user = null
    const res = await POST(req({ acceptTerms: true, acceptPrivacy: true }))
    expect(res.status).toBe(401)
    expect(h.updates).toHaveLength(0)
  })
})
