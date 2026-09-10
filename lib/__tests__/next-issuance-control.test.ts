import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  normalizeDesignation, canDesignateAtStatus, designationRequested,
  isCommunityConflict, communityConflictMessage, COMMUNITY_CONFLICT_SENTINEL,
  DESIGNATION_LOCKED_MESSAGE, DEFAULT_INTENDED_MEMBER_TYPE,
} from '@/lib/invitations/communityDesignation'

/**
 * ANDREL NEXT — the admin issuance control.
 *
 * An administrator may designate a reviewed invitation Professional or Next BEFORE it is issued.
 * The invitee may not. Migration 099 owns the column and refuses conflicting live intent; migration
 * 100 binds the first profile to it and makes the result immutable. Nothing here can convert a
 * member between communities.
 *
 * ORDERING IS THE RELEASE-CRITICAL PROPERTY: the designation is validated and written BEFORE
 * sendSecureInvite, so a refusal leaves no auth user, no token and no email behind.
 */

const state = vi.hoisted(() => ({
  adminEmail: 'bizdev91@gmail.com',
  entry: {
    id: 'e1', email: 'Test@X.com', full_name: 'Test', status: 'approved',
    referral_source: null as string | null, intended_member_type: 'professional',
  },
  /** every UPDATE the SERVICE-ROLE client made against waitlist */
  adminWaitlistUpdates: [] as any[],
  /** every UPDATE the caller's own (authenticated) client made against waitlist */
  userWaitlistUpdates: [] as any[],
  /** error the service-role waitlist UPDATE should return */
  designationError: null as any,
  /** did the send path run at all? */
  sendInviteCalls: 0,
  generateLinkCalls: 0,
  result: { ok: true, state: 'invited', sent: true } as any,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { email: state.adminEmail, id: 'admin' } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: state.entry, error: null }) }) }),
      update: (payload: any) => { state.userWaitlistUpdates.push(payload); return { eq: async () => ({ error: null }) } },
    }),
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      update: (payload: any) => {
        if (table === 'waitlist') state.adminWaitlistUpdates.push(payload)
        return { eq: async () => ({ error: table === 'waitlist' ? state.designationError : null }) }
      },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
    auth: {
      admin: {
        generateLink: async () => {
          state.generateLinkCalls += 1
          return { data: { properties: { hashed_token: 'ht' }, user: { id: 'u1' } }, error: null }
        },
      },
    },
  }),
}))

vi.mock('@/lib/invitations/secureInvite', () => ({
  sendSecureInvite: async () => { state.sendInviteCalls += 1; return state.result },
}))
vi.mock('@/lib/invitations', () => ({
  normalizeEmail: (e: string) => (e || '').trim().toLowerCase(),
  lookupAuthUsersByEmail: async () => ({ count: 1, user: { id: 'u1', last_sign_in_at: null } }),
}))
vi.mock('@/lib/auth/recoveryRequest', () => ({ requestPasswordRecoveryForUserId: async () => ({ ok: true, sent: true }) }))
vi.mock('@/lib/config/siteUrl', () => ({ getSiteUrl: () => 'https://andrel.app', getRecoveryRedirectUrl: () => 'https://andrel.app/auth/recover' }))
vi.mock('@/lib/analytics/recommendationEvents', () => ({ logRecommendationEvent: () => {} }))
vi.mock('@/lib/email', () => ({ sendSecureInviteEmail: async () => ({ success: true, messageId: 'm1' }) }))
vi.mock('@/lib/invitations/delivery', () => ({
  claimInviteDelivery: async () => ({ deliveryId: 'd1', isNew: true }),
  markDeliveryAccepted: async () => {},
  markDeliveryFailed: async () => {},
}))
vi.mock('@/lib/invitations/featureGate', () => ({
  invitationsMode: () => 'on',
  canSendInvitation: () => true,
  INVITATIONS_PAUSED_MESSAGE: 'paused',
  INVITATION_TEST_BLOCKED_MESSAGE: 'blocked',
}))

import { POST } from '@/app/api/admin/send-invite/route'

const post = (body: any, headers: Record<string, string> = {}) =>
  POST(new Request('http://localhost/api/admin/send-invite', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'sec-fetch-site': 'same-origin', origin: 'http://localhost', host: 'localhost',
      ...headers,
    },
    body: JSON.stringify(body),
  }))

const ROUTE = readFileSync('app/api/admin/send-invite/route.ts', 'utf8')
const CLIENT = readFileSync('components/AdminWaitlistClient.tsx', 'utf8')

/** Executable lines only. Both files EXPLAIN in prose that there is no reclassification path and
 *  name the control's label in a comment; scanning prose for those words would flag the
 *  explanation rather than a mechanism. */
const code = (src: string) =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const designationWrites = () =>
  state.adminWaitlistUpdates.filter((p) => 'intended_member_type' in p)

beforeEach(() => {
  state.adminEmail = 'bizdev91@gmail.com'
  state.entry = {
    id: 'e1', email: 'Test@X.com', full_name: 'Test', status: 'approved',
    referral_source: null, intended_member_type: 'professional',
  }
  state.adminWaitlistUpdates = []
  state.userWaitlistUpdates = []
  state.designationError = null
  state.sendInviteCalls = 0
  state.generateLinkCalls = 0
  state.result = { ok: true, state: 'invited', sent: true }
})

// ═══ 1 / 7  ZERO INTERACTION STAYS PROFESSIONAL ═══════════════════════════════════════════════
describe('1 & 7. the ordinary Professional send is unchanged', () => {
  it('no intendedMemberType field → no designation write at all', async () => {
    const res = await post({ entryId: 'e1' })
    expect(res.status).toBe(200)
    expect(designationWrites()).toHaveLength(0)   // ← not even a no-op UPDATE
    expect(state.sendInviteCalls).toBe(1)
  })

  it('explicitly professional on an already-professional row → still no write', async () => {
    const res = await post({ entryId: 'e1', intendedMemberType: 'professional' })
    expect(res.status).toBe(200)
    expect(designationWrites()).toHaveLength(0)
    expect(state.sendInviteCalls).toBe(1)
  })

  it('the default is professional, and an unknown value becomes professional', () => {
    expect(DEFAULT_INTENDED_MEMBER_TYPE).toBe('professional')
    for (const v of [undefined, null, '', 'NEXT', 'Next', 'student', 0, true, {}, ['next']]) {
      expect(normalizeDesignation(v)).toBe('professional')
    }
    expect(normalizeDesignation('next')).toBe('next')
  })
})

// ═══ 2 / 6  EXPLICIT NEXT ═════════════════════════════════════════════════════════════════════
describe('2 & 6. an explicit Next selection is stored before issuance', () => {
  it('writes next, once, with the service-role client, then sends', async () => {
    const res = await post({ entryId: 'e1', intendedMemberType: 'next' })
    expect(res.status).toBe(200)
    expect(designationWrites()).toEqual([{ intended_member_type: 'next' }])
    expect(state.sendInviteCalls).toBe(1)
    // never written with the caller's own authenticated client
    expect(state.userWaitlistUpdates.some((p) => 'intended_member_type' in p)).toBe(false)
  })

  it('a Next row re-sent as next does not write again', async () => {
    state.entry.intended_member_type = 'next'
    await post({ entryId: 'e1', intendedMemberType: 'next' })
    expect(designationWrites()).toHaveLength(0)
    expect(state.sendInviteCalls).toBe(1)
  })
})

// ═══ 3 / 4 / 5  AUTHORIZATION ═════════════════════════════════════════════════════════════════
describe('3-5. only the admin route, and only an admin, may designate', () => {
  it('a non-admin session is rejected before anything happens', async () => {
    state.adminEmail = 'member@example.test'
    const res = await post({ entryId: 'e1', intendedMemberType: 'next' })
    expect(res.status).toBe(401)
    expect(designationWrites()).toHaveLength(0)
    expect(state.sendInviteCalls).toBe(0)
  })

  it('a cross-site request is rejected before the admin check', async () => {
    const res = await post({ entryId: 'e1', intendedMemberType: 'next' },
      { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(designationWrites()).toHaveLength(0)
    expect(state.sendInviteCalls).toBe(0)
  })

  it('the invitee has no route to either column', () => {
    // The onboarding form and the profile writers never name a community; migration 100 derives it.
    for (const f of ['components/OnboardingForm.tsx', 'app/actions.ts']) {
      const src = readFileSync(f, 'utf8')
      expect(src).not.toContain('intended_member_type')
      expect(src).not.toMatch(/member_type\s*[:=][^=]*'(next|professional)'/)
    }
  })

  it('the raw browser value never reaches the database', () => {
    expect(ROUTE).toMatch(/normalizeDesignation\(body\.intendedMemberType\)/)
    expect(ROUTE).not.toMatch(/intended_member_type:\s*body\./)
  })
})

// ═══ 9  CONFLICT FAILS CLOSED, BEFORE ANY SEND ════════════════════════════════════════════════
describe('9. a conflicting live intent fails closed before issuance', () => {
  it('refuses with admin-facing copy and NEVER reaches the invite path', async () => {
    state.designationError = { code: '23514', message: `waitlist: ${COMMUNITY_CONFLICT_SENTINEL}` }

    const res = await post({ entryId: 'e1', intendedMemberType: 'next' })
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.state).toBe('community_conflict')
    expect(body.message).toBe(communityConflictMessage('next'))
    // RELEASE-CRITICAL: no auth user, no token, no email.
    expect(state.sendInviteCalls).toBe(0)
    expect(state.generateLinkCalls).toBe(0)
    // and no invited_at / status stamping either
    expect(state.userWaitlistUpdates).toHaveLength(0)
  })

  it('an UNRELATED database error is not translated as a conflict', async () => {
    state.designationError = { code: '23514', message: 'violates check constraint "waitlist_intended_member_type_check"' }

    const res = await post({ entryId: 'e1', intendedMemberType: 'next' })
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.state).toBe('error')
    expect(body.message).not.toBe(communityConflictMessage('next'))
    expect(state.sendInviteCalls).toBe(0)   // still nothing sent
  })

  it('the conflict matcher keys on the message, never the SQLSTATE', () => {
    expect(isCommunityConflict({ code: '23514', message: `x ${COMMUNITY_CONFLICT_SENTINEL}` })).toBe(true)
    expect(isCommunityConflict({ code: '23514', message: 'some other check constraint' })).toBe(false)
    expect(isCommunityConflict({ message: COMMUNITY_CONFLICT_SENTINEL })).toBe(true)
    expect(isCommunityConflict(null)).toBe(false)
    expect(communityConflictMessage('next')).toContain('Andrel Professional')
    expect(communityConflictMessage('professional')).toContain('Andrel Next')
    for (const m of [communityConflictMessage('next'), communityConflictMessage('professional')]) {
      expect(m).not.toContain('@')          // no address
      expect(m).not.toContain('e1')         // no row id
    }
  })
})

// ═══ 10 / 11 / 18 / 19  LIFECYCLE ═════════════════════════════════════════════════════════════
describe('10, 11, 18, 19. designation is only possible before issuance', () => {
  // invited and declined both permit a transition to 'invited', so they reach the NEW designation
  // guard. pending and revoked are refused earlier by the pre-existing transition guard — also a
  // 409, also no write, just a different (and more specific) message.
  it.each(['invited', 'declined'])(
    'refuses a designation for a %s invitation with the locked message', async (status) => {
      state.entry.status = status
      const res = await post({ entryId: 'e1', intendedMemberType: 'next' })
      expect(res.status).toBe(409)
      expect((await res.json()).message).toBe(DESIGNATION_LOCKED_MESSAGE)
      expect(designationWrites()).toHaveLength(0)
      expect(state.sendInviteCalls).toBe(0)
    })

  it.each(['pending', 'revoked'])(
    'a %s invitation is refused by the existing transition guard, before designation', async (status) => {
      state.entry.status = status
      const res = await post({ entryId: 'e1', intendedMemberType: 'next' })
      expect(res.status).toBe(409)
      expect(designationWrites()).toHaveLength(0)
      expect(state.sendInviteCalls).toBe(0)
    })

  it('a resend of an INVITED row with no designation field is unaffected', async () => {
    state.entry.status = 'invited'
    const res = await post({ entryId: 'e1' })          // exactly what the invited tab posts
    expect(res.status).toBe(200)
    expect(designationWrites()).toHaveLength(0)
    expect(state.sendInviteCalls).toBe(1)
  })

  it('the client omits the field entirely on the invited tab', () => {
    // canDesignateCommunity gates the body field, so a resend cannot carry a fresh community value.
    expect(CLIENT).toMatch(/const canDesignateCommunity = activeTab === 'approved' \|\| activeTab === 'contacted'/)
    expect(CLIENT).toMatch(/if \(canDesignateCommunity && action === 'invite'\) \{\s*\n\s*body\.intendedMemberType/)
  })

  it('canDesignateAtStatus is a positive test over exactly two states', () => {
    expect(canDesignateAtStatus('approved')).toBe(true)
    expect(canDesignateAtStatus('contacted')).toBe(true)
    for (const s of ['pending', 'invited', 'declined', 'revoked', 'something_new', '', null, undefined]) {
      expect(canDesignateAtStatus(s as any)).toBe(false)
    }
  })

  it('designationRequested distinguishes absent from false', () => {
    expect(designationRequested({ entryId: 'e1' })).toBe(false)
    expect(designationRequested({ entryId: 'e1', intendedMemberType: 'professional' })).toBe(true)
    expect(designationRequested(null)).toBe(false)
  })
})

// ═══ 8 / 12 / 17  THE SQL ARCHITECTURE IS UNTOUCHED ═══════════════════════════════════════════
describe('8, 12, 17. the database remains the authority and nothing converts', () => {
  it('migrations 099 and 100 are not modified by this feature', () => {
    const m099 = readFileSync('supabase/migrations/099_next_community_designation_foundation.sql', 'utf8')
    const m100 = readFileSync('supabase/migrations/100_provisioning_authorization_and_community_binding.sql', 'utf8')
    expect(m099).toContain('CREATE TRIGGER waitlist_intent_no_conflict_biu')
    expect(m099).toContain('CREATE TRIGGER profiles_member_type_immutable_bu')
    expect(m100).toContain('CREATE TRIGGER profiles_provision_bind_bi')
    expect(m100).toContain('ALTER TABLE public.profiles ALTER COLUMN member_type DROP DEFAULT')
  })

  it('a Next invitation resolves through the existing resolver, not through this route', () => {
    // The route writes the INTENT. It never reads or writes profiles.member_type, and never calls
    // the resolver — migration 100's trigger is the only consumer.
    expect(ROUTE).not.toContain('resolve_intended_member_type')
    expect(ROUTE).not.toContain('may_provision_profile')
    // It READS profiles to decide whether an account is already activated — pre-existing, and the
    // reason sendSecureInvite can refuse an active member. It must never WRITE one.
    expect(ROUTE).not.toMatch(/from\('profiles'\)\s*\n?\s*\.(insert|update|upsert)/)
  })

  it('no conversion mechanism exists anywhere in the new surface', () => {
    const wl = readFileSync('lib/invitations/communityDesignation.ts', 'utf8')
    for (const src of [ROUTE, wl, CLIENT]) {
      expect(code(src)).not.toMatch(/promote|convert|reclassif|correct_member_type|change_member_type/i)
    }
  })
})

// ═══ 13  REVOKE ═══════════════════════════════════════════════════════════════════════════════
describe('13. revoke is unaffected', () => {
  it('the revoke route neither names nor changes a community', () => {
    const revoke = readFileSync('app/api/admin/waitlist/revoke/route.ts', 'utf8')
    expect(revoke).not.toContain('intended_member_type')
    expect(revoke).not.toContain('member_type')
  })
})

// ═══ 14  BULK / CAMPAIGN CANNOT ISSUE NEXT ════════════════════════════════════════════════════
describe('14. bulk and campaign issuance stay Professional-only', () => {
  it.each([
    'app/api/admin/bulk-invite/route.ts',
    'app/api/admin/campaigns/james-nomination/route.ts',
    'app/api/admin/campaigns/jesse-nomination/route.ts',
    'lib/campaigns/campaignRouteHandler.ts',
  ])('%s cannot name or accept a community', (f) => {
    const src = readFileSync(f, 'utf8')
    expect(src).not.toContain('intended_member_type')
    expect(src).not.toContain('intendedMemberType')
    expect(src).not.toMatch(/'next'/)
  })
})

// ═══ 15  FOUNDING IS INDEPENDENT ══════════════════════════════════════════════════════════════
describe('15. founding member and community are independent', () => {
  it('both can be set on one send, and neither derives from the other', async () => {
    await post({ entryId: 'e1', intendedMemberType: 'next', markAsFounding: true })
    expect(designationWrites()).toEqual([{ intended_member_type: 'next' }])
    expect(state.sendInviteCalls).toBe(1)
  })

  it('founding alone writes no community', async () => {
    await post({ entryId: 'e1', markAsFounding: true })
    expect(designationWrites()).toHaveLength(0)
  })

  it('the two client toggles are separate state', () => {
    expect(CLIENT).toMatch(/const \[markFounding, setMarkFounding\]/)
    expect(CLIENT).toMatch(/const \[markNext, setMarkNext\]/)
    expect(CLIENT).toContain('Mark as founding member')
    expect(CLIENT).toContain('Invite to Andrel Next')
  })
})

// ═══ 20  REINSTATE ════════════════════════════════════════════════════════════════════════════
describe('20. reinstate neither offers nor alters a community', () => {
  it('the reinstate route never names one', () => {
    const src = readFileSync('app/api/admin/waitlist/reinstate/route.ts', 'utf8')
    expect(src).not.toContain('intended_member_type')
    expect(src).not.toContain('member_type')
  })
})

// ═══ ORDERING — THE RELEASE-CRITICAL STRUCTURAL PROPERTY ══════════════════════════════════════
describe('the designation is decided before anything is issued', () => {
  it('the write appears before sendSecureInvite in the route source', () => {
    const designation = ROUTE.indexOf('.update({ intended_member_type')
    const send = ROUTE.indexOf('await sendSecureInvite(')
    const postSendStatus = ROUTE.indexOf("update({ status: 'invited', invited_at")
    expect(designation).toBeGreaterThan(-1)
    expect(designation).toBeLessThan(send)
    // and it is NOT folded into the post-send status stamp
    expect(designation).toBeLessThan(postSendStatus)
  })

  it('the UI control appears on both tabs that can issue an invitation', () => {
    const occurrences = code(CLIENT).split('Invite to Andrel Next').length - 1
    expect(occurrences).toBe(2)   // approved and contacted
  })
})
