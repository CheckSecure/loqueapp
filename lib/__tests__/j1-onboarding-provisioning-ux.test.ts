import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  PROVISIONING_REFUSAL_PREFIX, PROVISIONING_REFUSED_MESSAGE,
  isProvisioningRefusal, provisioningRefusalReason,
} from '@/lib/onboarding/provisioningError'

/**
 * J1 — a neutral onboarding error instead of a raw PostgreSQL trigger reason.
 *
 * Migration 100 remains the authorization boundary. The pre-check asserted here is UX: it can only
 * turn a refusal the database would ALSO make into readable words, and every one of its own failure
 * modes proceeds to the write so the trigger decides.
 *
 * The three release-critical cases are 6, 13 and 14 — the ones that keep it UX. If any of them
 * regresses, the pre-check has become an authorization dependency and a legitimate member is being
 * blocked by the application.
 */

// ── The two production constraints, and the migration-100 boundary, modelled ─────────────────
type Row = Record<string, any> & { id: string; email?: string | null }
const db: { profiles: Row[] } = { profiles: [] }
const upserts: { table: string; target?: string; payload: Row }[] = []
const rpcCalls: { fn: string; args: any }[] = []

const cfg: {
  user: any
  /** verdict the RPC returns, or an error to simulate an unavailable pre-check */
  verdict: any
  rpcError: any
  /** simulate the profiles-existence read failing */
  existenceError: any
  /** make the upsert itself raise, as the trigger would */
  upsertError: any
} = { user: null, verdict: null, rpcError: null, existenceError: null, upsertError: null }

const TRIGGER_REFUSAL = {
  code: '23514',
  message: 'profiles: provisioning refused (waitlist_not_invited)',
  details: null,
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: cfg.user } }) } }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args })
      if (cfg.rpcError) return { data: null, error: cfg.rpcError }
      return { data: cfg.verdict, error: null }
    },
    from: (table: string) => {
      const b: any = {
        _res: { data: null, error: null },
        _sel: '',
        upsert: (payload: any, opts?: any) => {
          upserts.push({ table, target: opts?.onConflict, payload })
          if (table === 'profiles' && cfg.upsertError) { b._res = { data: null, error: cfg.upsertError }; return b }
          if (table === 'profiles') {
            const hit = db.profiles.find((r) => r.id === payload.id)
            if (hit) Object.assign(hit, payload); else db.profiles.push({ ...payload })
          }
          b._res = { data: null, error: null }
          return b
        },
        insert: () => b,
        update: () => b,
        delete: () => b,
        select: (s?: string) => { b._sel = s ?? ''; return b },
        eq: () => b, in: () => b, limit: () => b, order: () => b,
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => {
          // The J1 existence read is the one that selects exactly 'id'.
          if (table === 'profiles' && b._sel === 'id') {
            if (cfg.existenceError) return { data: null, error: cfg.existenceError }
            const hit = db.profiles.find((r) => r.id === cfg.user?.id)
            return { data: hit ? { id: hit.id } : null, error: null }
          }
          return { data: null, error: null }
        },
        then: (res: any, rej: any) => Promise.resolve(b._res).then(res, rej),
      }
      return b
    },
  }),
}))

vi.mock('@/lib/generate-recommendations', () => ({
  generateOnboardingRecommendations: async () => ({ outcome: 'empty_pool', count: 0, retryable: false }),
}))
vi.mock('@/lib/onboarding/retryQueue', () => ({ enqueueOnboardingRetry: async () => false }))
vi.mock('@/lib/referrals/awardReferralCredit', () => ({ awardReferralCreditOnCompletion: async () => ({ outcome: 'none' }) }))
vi.mock('@/lib/onboarding/welcomeFromAdmin', () => ({ sendAdminWelcome: async () => ({ created: false, reason: 'test' }) }))
vi.mock('@/lib/company/enrichment/schedule', () => ({ scheduleEnrichment: () => {} }))
vi.mock('@/lib/company/canonicalLink', () => ({ resolveCanonicalCompanyLink: async () => ({ action: 'preserve' }) }))
vi.mock('@/lib/profile/focusAreas', () => ({ persistFocusAreas: async () => {} }))
vi.mock('@/lib/email', () => new Proxy({}, { get: () => async () => ({ success: true }) }) as any)
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

import { completeOnboarding, updateProfile } from '@/app/actions'

const ACTIONS = readFileSync('app/actions.ts', 'utf8')
const MIGRATION = readFileSync(
  'supabase/migrations/100_provisioning_authorization_and_community_binding.sql', 'utf8')

const form = (over: Record<string, string> = {}) => {
  const fd = new FormData()
  const base: Record<string, string> = {
    full_name: 'Test Member', title: 'General Counsel', company: 'Apex Corporation',
    city: 'New York', state: 'NY', location: 'New York, NY',
    role_type: 'In-house attorney', seniority: 'Senior', expertise: 'M&A', bio: 'A bio.',
    looking_for: 'Peers', intro_preferences: 'In-house attorney',
    purposes: 'Business development', interests: 'privacy',
    meeting_format_preference: 'both', geographic_scope: 'us-wide', current_status: 'Employed',
  }
  for (const [k, v] of Object.entries({ ...base, ...over })) fd.append(k, v)
  return fd
}

beforeEach(() => {
  db.profiles = []
  upserts.length = 0
  rpcCalls.length = 0
  cfg.user = { id: 'u1', email: 'member@example.test' }
  cfg.verdict = { outcome: 'authorized' }
  cfg.rpcError = null
  cfg.existenceError = null
  cfg.upsertError = null
})

// ═══ 1-2  AUTHORIZED FIRST-TIME ONBOARDING ════════════════════════════════════════════════════
describe('1-2. authorized first-time onboarding succeeds', () => {
  it('1. Professional: the pre-check runs, authorizes, and the profile is written', async () => {
    const result = await completeOnboarding(form())

    expect(result).toEqual({ success: true })
    expect(rpcCalls).toEqual([{
      fn: 'may_provision_profile',
      args: { p_email: 'member@example.test', p_auth_user_id: 'u1' },
    }])
    expect(db.profiles).toHaveLength(1)
    expect(db.profiles[0].id).toBe('u1')
  })

  it('2. Next: identical client payload — the community is never sent by the caller', async () => {
    // The application cannot and does not distinguish communities. Whatever the invitation says,
    // the payload is the same and member_type is absent; migration 100 derives it.
    const result = await completeOnboarding(form())

    expect(result).toEqual({ success: true })
    const payload = upserts.find((u) => u.table === 'profiles')!.payload
    expect(Object.keys(payload)).not.toContain('member_type')
    expect(JSON.stringify(rpcCalls)).not.toContain('member_type')
  })
})

// ═══ 3  REFUSED AT THE PRE-CHECK ══════════════════════════════════════════════════════════════
describe('3. a refused first profile returns the neutral message and never writes', () => {
  it('returns the approved copy and skips the upsert entirely', async () => {
    cfg.verdict = { outcome: 'refused', reason: 'waitlist_absent' }

    const result = await completeOnboarding(form())

    expect(result).toEqual({ error: PROVISIONING_REFUSED_MESSAGE })
    expect(upserts).toHaveLength(0)   // nothing was attempted
    expect(db.profiles).toHaveLength(0)
  })
})

// ═══ 4  REFUSED AT THE WRITE (the race) ═══════════════════════════════════════════════════════
describe('4. a trigger refusal AFTER a passing pre-check returns identical copy', () => {
  it('the revoked-in-the-window case reads exactly like the pre-check refusal', async () => {
    cfg.verdict = { outcome: 'authorized' }   // pre-check passes…
    cfg.upsertError = TRIGGER_REFUSAL          // …and the trigger refuses anyway

    const result = await completeOnboarding(form())

    expect(result).toEqual({ error: PROVISIONING_REFUSED_MESSAGE })
    // Byte-identical to the pre-check branch: a member cannot tell which fired.
    cfg.upsertError = null
    cfg.verdict = { outcome: 'refused', reason: 'waitlist_not_invited' }
    db.profiles = []
    const viaPrecheck = await completeOnboarding(form())
    expect((viaPrecheck as any).error).toBe((result as any).error)
  })

  it('an UNRELATED database error keeps its existing behaviour', async () => {
    cfg.upsertError = { code: '23514', message: 'new row violates check constraint "profiles_complete_requires_location_chk"' }

    const result = await completeOnboarding(form())

    // Same SQLSTATE as a provisioning refusal, deliberately NOT translated.
    expect((result as any).error).toContain('profiles_complete_requires_location_chk')
    expect((result as any).error).not.toBe(PROVISIONING_REFUSED_MESSAGE)
  })
})

// ═══ 5  NOTHING LEAKS ═════════════════════════════════════════════════════════════════════════
describe('5. no reason code, identifier or SQL text reaches the browser', () => {
  it('neither refusal path leaks anything', async () => {
    for (const setup of [
      () => { cfg.verdict = { outcome: 'refused', reason: 'identity_mismatch' } },
      () => { cfg.upsertError = { code: '23514', message: 'profiles: provisioning refused (identity_mismatch)' } },
    ]) {
      db.profiles = []; cfg.verdict = { outcome: 'authorized' }; cfg.upsertError = null
      setup()
      const msg = (await completeOnboarding(form()) as any).error as string
      expect(msg).toBe(PROVISIONING_REFUSED_MESSAGE)
      for (const forbidden of [
        'identity_mismatch', 'waitlist', 'profiles:', 'provisioning refused',
        'member@example.test', 'u1', '23514', 'constraint',
      ]) {
        expect(msg, `leaked ${forbidden}`).not.toContain(forbidden)
      }
    }
  })
})

// ═══ 6  RELEASE-CRITICAL: EXISTING PROFILE, NO LIVE INVITATION ════════════════════════════════
describe('6. an existing profile resubmits without a live invitation', () => {
  it('the pre-check is SKIPPED and the write proceeds', async () => {
    db.profiles.push({ id: 'u1', email: 'member@example.test', member_type: 'professional',
                       profile_complete: false, full_name: 'Before' })
    // If the pre-check were consulted it would refuse — proving it is not consulted.
    cfg.verdict = { outcome: 'refused', reason: 'waitlist_not_invited' }

    const result = await completeOnboarding(form({ full_name: 'After Edit' }))

    expect(result).toEqual({ success: true })
    expect(rpcCalls).toHaveLength(0)          // ← the pre-check never ran
    expect(db.profiles).toHaveLength(1)
    expect(db.profiles[0].full_name).toBe('After Edit')
  })
})

// ═══ 13  RELEASE-CRITICAL: RPC ERROR FAILS OPEN ═══════════════════════════════════════════════
describe('13. an unavailable pre-check fails open', () => {
  it('proceeds to the write and lets the database decide', async () => {
    cfg.rpcError = { code: '57014', message: 'canceling statement due to statement timeout' }

    const result = await completeOnboarding(form())

    expect(result).toEqual({ success: true })
    expect(upserts).toHaveLength(1)   // the write was still attempted
  })

  it('and if the trigger then refuses, the member still gets the neutral copy', async () => {
    cfg.rpcError = { code: '57014', message: 'timeout' }
    cfg.upsertError = TRIGGER_REFUSAL

    expect(await completeOnboarding(form())).toEqual({ error: PROVISIONING_REFUSED_MESSAGE })
  })
})

// ═══ 14  RELEASE-CRITICAL: EXISTENCE-READ ERROR FAILS OPEN ════════════════════════════════════
describe('14. a failed profile-existence read never blocks a member', () => {
  it('skips the pre-check entirely and proceeds', async () => {
    cfg.existenceError = { code: '08006', message: 'connection failure' }
    // Would refuse if it were consulted.
    cfg.verdict = { outcome: 'refused', reason: 'waitlist_absent' }

    const result = await completeOnboarding(form())

    expect(result).toEqual({ success: true })
    expect(rpcCalls).toHaveLength(0)   // ← never asked, because we could not establish first-vs-existing
    expect(upserts).toHaveLength(1)
  })
})

// ═══ 7  member_type STAYS OUT OF CALLER CONTROL ═══════════════════════════════════════════════
describe('7. the caller cannot supply a community', () => {
  it('a member_type form field is ignored and never reaches the payload', async () => {
    await completeOnboarding(form({ member_type: 'next' }))
    for (const u of upserts) expect(Object.keys(u.payload)).not.toContain('member_type')
  })

  it('updateProfile likewise', async () => {
    db.profiles.push({ id: 'u1', email: 'member@example.test', member_type: 'professional' })
    await updateProfile(form({ member_type: 'next' }))
    for (const u of upserts) expect(Object.keys(u.payload)).not.toContain('member_type')
  })
})

// ═══ 6b  updateProfile DEFENSIVE TRANSLATION ══════════════════════════════════════════════════
describe('updateProfile translates a provisioning refusal the same way', () => {
  it('neutral copy, not raw SQL', async () => {
    cfg.upsertError = TRIGGER_REFUSAL
    expect(await updateProfile(form())).toEqual({ error: PROVISIONING_REFUSED_MESSAGE })
  })

  it('but leaves unrelated errors alone', async () => {
    cfg.upsertError = { code: '23505', message: 'duplicate key value violates unique constraint "profiles_email_key"' }
    expect((await updateProfile(form()) as any).error).toContain('profiles_email_key')
  })
})

// ═══ 8/9  THE GRANT IS UNCHANGED — service_role ONLY ══════════════════════════════════════════
describe('8-9. may_provision_profile remains service_role-only', () => {
  it('migration 100 still revokes the browser roles and grants only service_role', () => {
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION public\.may_provision_profile\(text, uuid\) FROM anon/)
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION public\.may_provision_profile\(text, uuid\) FROM authenticated/)
    expect(MIGRATION).toMatch(/GRANT EXECUTE ON FUNCTION public\.may_provision_profile\(text, uuid\) TO service_role/)
    // J1 adds no grant of any kind.
    expect(ACTIONS).not.toMatch(/GRANT|REVOKE/)
  })

  it('the pre-check runs on the service-role client, never the user client', () => {
    const body = ACTIONS.slice(
      ACTIONS.indexOf('export async function completeOnboarding'),
      ACTIONS.indexOf('export async function saveAvatarUrl'))
    expect(body).toMatch(/adminClient\s*\n?\s*\.rpc\('may_provision_profile'/)
    expect(body).not.toMatch(/supabase\s*\n?\s*\.rpc\('may_provision_profile'/)
  })
})

// ═══ 10  THE BOUNDARY IS STILL THE DATABASE ═══════════════════════════════════════════════════
describe('10. the pre-check is not authoritative', () => {
  it('every failure mode of the pre-check proceeds to the write', async () => {
    // Both fail-open paths already proved this behaviourally (13, 14). This pins the SHAPE: the
    // only `return` inside the pre-check block is the explicit refusal.
    const block = ACTIONS.slice(
      ACTIONS.indexOf('J1: A NEUTRAL ERROR FOR A REFUSED FIRST PROFILE'),
      ACTIONS.indexOf('const normalizedEmail = normalizeEmail(user.email)',
                      ACTIONS.indexOf('J1: A NEUTRAL ERROR FOR A REFUSED FIRST PROFILE')))
    const returns = Array.from(block.matchAll(/return \{/g))
    expect(returns).toHaveLength(1)
    expect(block).toContain('PROVISIONING_REFUSED_MESSAGE')
  })

  it('migration 100 is untouched by J1', () => {
    // The boundary must be byte-identical to what production verified.
    expect(MIGRATION).toContain('CREATE TRIGGER profiles_provision_bind_bi')
    expect(MIGRATION).toContain('ALTER TABLE public.profiles ALTER COLUMN member_type DROP DEFAULT')
  })
})

// ═══ 15  THE SENTINEL THE TRANSLATION DEPENDS ON ══════════════════════════════════════════════
describe('15. the sentinel migration 100 emits, and the matching rule', () => {
  it('every refusal in the trigger still carries the prefix', () => {
    const raises = Array.from(MIGRATION.matchAll(/'profiles: provisioning refused \(/g))
    expect(raises.length).toBeGreaterThanOrEqual(4)
  })

  it('the helper matches the prefix and NOT the SQLSTATE', () => {
    expect(isProvisioningRefusal(TRIGGER_REFUSAL)).toBe(true)
    // Same 23514, unrelated constraint → must not match.
    expect(isProvisioningRefusal({
      code: '23514', message: 'new row violates check constraint "profiles_member_type_check"',
    })).toBe(false)
    // Right text, no SQLSTATE at all → still a refusal.
    expect(isProvisioningRefusal({ message: `${PROVISIONING_REFUSAL_PREFIX}waitlist_absent)` })).toBe(true)
    expect(isProvisioningRefusal(null)).toBe(false)
    expect(isProvisioningRefusal('a string')).toBe(false)
  })

  it('the reason is extractable for the log and absent from the member message', () => {
    expect(provisioningRefusalReason(TRIGGER_REFUSAL)).toBe('waitlist_not_invited')
    expect(provisioningRefusalReason({ code: '23514', message: 'unrelated' })).toBeNull()
    expect(PROVISIONING_REFUSED_MESSAGE).not.toContain('waitlist')
  })

  it('the approved copy, exactly', () => {
    expect(PROVISIONING_REFUSED_MESSAGE).toBe(
      'We couldn’t complete your account setup. Your invitation may have expired or been changed. ' +
      'Please request a new invitation, or contact support if you think this is a mistake.')
  })
})
