import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STEP 0b — completeOnboarding conflicts on the PRIMARY KEY, and both profile writers store the
 * canonical identity form.
 *
 * ─── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────
 * completeOnboarding upserted with `{ onConflict: 'email' }` while sending `user.email` RAW, and
 * /api/profile/initialize stores `lower(trim(email))`. profiles_email_key is a plain
 * `UNIQUE (email)` btree — CASE-SENSITIVE — so the two disagreed about identity in two directions:
 *
 *   1. Same person, different case → the email target MISSED, PostgreSQL fell through to a plain
 *      INSERT, and that INSERT hit profiles_pkey. Onboarding failed with a 23505.
 *   2. Different person, same address → the email target RESOLVED ONTO THAT ROW and wrote
 *      id = EXCLUDED.id, rewriting a live primary key and orphaning every FK referencing it.
 *
 * ─── WHY THE CONSTRAINTS ARE MODELLED HERE ────────────────────────────────────────────────────
 * These are DATABASE behaviours, so a source-text assertion cannot show them. The model below
 * implements exactly the two constraints the production catalog reports, and exactly one rule of
 * PostgreSQL's ON CONFLICT semantics: the conflict is resolved against the NAMED target only, and
 * every other unique constraint still polices the INSERT that follows a miss. That asymmetry is the
 * entire subject of this file.
 *
 * It is a model, not the database — so each behavioural test is paired with a negative test that
 * drives the SAME model with the OLD target and shows it producing the old failure. If the model
 * were vacuous, those pairs could not diverge.
 */

// ── The two production constraints, verified against the live catalog ─────────────────────────
//   profiles_pkey       PRIMARY KEY (id)
//   profiles_email_key  UNIQUE (email)   ← plain btree; NOT lower(email), unlike waitlist (009)
type Row = Record<string, any> & { id: string; email?: string | null }

const db: { profiles: Row[] } = { profiles: [] }
const upserts: { table: string; target?: string; payload: Row }[] = []

function applyUpsert(payload: Row, target?: string): { error: any } {
  // ON CONFLICT resolves against the NAMED target only. No target ⇒ PostgREST uses the primary key.
  const conflict =
    target === 'email'
      ? (payload.email == null ? undefined : db.profiles.find((r) => r.email === payload.email))
      : db.profiles.find((r) => r.id === payload.id)

  if (conflict) {
    Object.assign(conflict, payload) // DO UPDATE SET <every supplied column>, id included
    return { error: null }
  }

  // Target missed ⇒ plain INSERT. The OTHER unique constraints still apply.
  if (db.profiles.some((r) => r.id === payload.id)) {
    return { error: { code: '23505', message: 'duplicate key value violates unique constraint "profiles_pkey"' } }
  }
  if (payload.email != null && db.profiles.some((r) => r.email === payload.email)) {
    return { error: { code: '23505', message: 'duplicate key value violates unique constraint "profiles_email_key"' } }
  }
  db.profiles.push({ ...payload })
  return { error: null }
}

const cfg: { user: any } = { user: null }

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: cfg.user } }) } }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    // Added in J1. completeOnboarding now asks may_provision_profile whether a GENUINELY FIRST
    // profile may be created, so the service-role client this file models has to answer. It always
    // authorizes here: this file is about the conflict target and address normalisation, and a
    // refusal would change which behaviour is under test rather than adding to it. The pre-check's
    // own outcomes are covered in j1-onboarding-provisioning-ux.test.ts.
    rpc: async () => ({ data: { outcome: 'authorized' }, error: null }),
    from: (table: string) => {
      const b: any = {
        _res: { data: null, error: null },
        upsert: (payload: any, opts?: any) => {
          upserts.push({ table, target: opts?.onConflict, payload })
          if (table === 'profiles') b._res = applyUpsert(payload, opts?.onConflict)
          return b
        },
        insert: () => b,
        update: () => b,
        delete: () => b,
        select: () => b,
        eq: () => b,
        in: () => b,
        limit: () => b,
        order: () => b,
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (res: any, rej: any) => Promise.resolve(b._res).then(res, rej),
      }
      return b
    },
  }),
}))

// Post-upsert side effects. Every one of these is already fire-and-forget or try/caught in the
// action, so neutralising them changes nothing this file is asserting.
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

const form = (over: Record<string, string> = {}) => {
  const fd = new FormData()
  const base: Record<string, string> = {
    full_name: 'Test Member',
    title: 'General Counsel',
    company: 'Apex Corporation',
    // completeOnboarding derives its location from city+state (it sets profile_complete, so
    // migration 061's CHECK applies); updateProfile reads `location` directly. Both are supplied
    // so one builder drives both actions.
    city: 'New York',
    state: 'NY',
    location: 'New York, NY',
    role_type: 'In-house attorney',
    seniority: 'Senior',
    expertise: 'M&A',
    bio: 'A bio.',
    looking_for: 'Peers',
    intro_preferences: 'In-house attorney',
    purposes: 'Business development',
    interests: 'privacy',
    meeting_format_preference: 'both',
    geographic_scope: 'us-wide',
    current_status: 'Employed',
  }
  for (const [k, v] of Object.entries({ ...base, ...over })) fd.append(k, v)
  return fd
}

const profileRow = (over: Partial<Row> = {}): Row => ({
  id: 'u1',
  email: 'member@example.com',
  full_name: 'Test Member',
  member_type: 'professional',
  profile_complete: false,
  ...over,
})

beforeEach(() => {
  db.profiles = []
  upserts.length = 0
  cfg.user = { id: 'u1', email: 'member@example.com' }
})

// ═══ 1. The ordinary Professional path is unchanged ══════════════════════════════════════════
describe('1. an existing Professional completing onboarding updates their own row', () => {
  it('updates the SAME id, creates no second row, and targets the primary key', async () => {
    db.profiles.push(profileRow())

    const result = await completeOnboarding(form())

    expect(result).toEqual({ success: true })
    expect(db.profiles).toHaveLength(1)
    expect(db.profiles[0].id).toBe('u1')
    expect(db.profiles[0].profile_complete).toBe(true)

    const profileUpsert = upserts.find((u) => u.table === 'profiles')!
    expect(profileUpsert.target).toBe('id')
  })

  it('still writes the completion fields in the SAME statement', async () => {
    db.profiles.push(profileRow())
    await completeOnboarding(form())

    expect(db.profiles[0]).toMatchObject({
      profile_complete: true,
      onboarding_step: 2,
      password_reset_required: false,
      email_verified: true,
    })
  })
})

// ═══ 2. A mixed-case / whitespace auth email can no longer miss ══════════════════════════════
describe('2. a non-normalised auth email cannot cause a conflict miss', () => {
  it('completes successfully and stores the canonical form', async () => {
    db.profiles.push(profileRow({ email: 'member@example.com' })) // as initialize stores it
    cfg.user = { id: 'u1', email: '  Member@Example.COM ' }       // as auth may hand it back

    const result = await completeOnboarding(form())

    expect(result).toEqual({ success: true })
    expect(db.profiles).toHaveLength(1)
    expect(db.profiles[0].email).toBe('member@example.com')
    expect(db.profiles[0].profile_complete).toBe(true)
  })

  it('NEGATIVE: the OLD email target fails the identical case with 23505 on profiles_pkey', () => {
    db.profiles.push(profileRow({ email: 'member@example.com' }))

    // Same seed, same person, the raw address the old code sent, resolved on the OLD target.
    const { error } = applyUpsert({ id: 'u1', email: '  Member@Example.COM ' }, 'email')

    expect(error?.code).toBe('23505')
    expect(error?.message).toContain('profiles_pkey')
    expect(db.profiles).toHaveLength(1) // nothing written
  })
})

// ═══ 3. The id is authoritative ══════════════════════════════════════════════════════════════
describe('3. the id decides which row is written, even when the address changed', () => {
  it('re-mirrors a changed auth email onto the same row instead of creating a second', async () => {
    db.profiles.push(profileRow({ email: 'old@example.com' }))
    cfg.user = { id: 'u1', email: 'new@example.com' }

    const result = await completeOnboarding(form())

    expect(result).toEqual({ success: true })
    expect(db.profiles).toHaveLength(1)
    expect(db.profiles[0].id).toBe('u1')
    expect(db.profiles[0].email).toBe('new@example.com')
  })

  it('NEGATIVE: the OLD email target could not write this row at all', () => {
    db.profiles.push(profileRow({ email: 'old@example.com' }))

    const { error } = applyUpsert({ id: 'u1', email: 'new@example.com' }, 'email')

    expect(error?.code).toBe('23505')
    expect(error?.message).toContain('profiles_pkey')
  })
})

// ═══ 4. Another member's row can never be adopted ════════════════════════════════════════════
describe('4. an address held by a DIFFERENT id fails safely instead of being adopted', () => {
  it('refuses with 23505 on profiles_email_key and mutates nothing', async () => {
    db.profiles.push(profileRow({ id: 'someone-else', email: 'shared@example.com', full_name: 'Someone Else' }))
    cfg.user = { id: 'u1', email: 'shared@example.com' } // no row of their own

    const result = await completeOnboarding(form())

    expect(result).toHaveProperty('error')
    expect((result as any).error).toContain('profiles_email_key')

    // The other member is untouched: same id, same name, and no second row appeared.
    expect(db.profiles).toHaveLength(1)
    expect(db.profiles[0].id).toBe('someone-else')
    expect(db.profiles[0].full_name).toBe('Someone Else')
  })

  it('NEGATIVE: the OLD email target ADOPTED that row and rewrote its primary key', () => {
    db.profiles.push(profileRow({ id: 'someone-else', email: 'shared@example.com', full_name: 'Someone Else' }))

    const { error } = applyUpsert(
      { id: 'u1', email: 'shared@example.com', full_name: 'Test Member' }, 'email',
    )

    expect(error).toBeNull()               // silently "succeeded"
    expect(db.profiles).toHaveLength(1)
    expect(db.profiles[0].id).toBe('u1')   // ← the other member's primary key, rewritten
    expect(db.profiles[0].full_name).toBe('Test Member')
  })
})

// ═══ 5. member_type is untouched ═════════════════════════════════════════════════════════════
describe('5. no profile writer touches member_type', () => {
  it('completeOnboarding never sends the column, and an existing value survives', async () => {
    db.profiles.push(profileRow({ member_type: 'professional' }))
    await completeOnboarding(form())

    for (const u of upserts) expect(Object.keys(u.payload)).not.toContain('member_type')
    expect(db.profiles[0].member_type).toBe('professional')
  })

  it('updateProfile never sends the column either', async () => {
    db.profiles.push(profileRow({ member_type: 'professional' }))
    await updateProfile(form())

    for (const u of upserts) expect(Object.keys(u.payload)).not.toContain('member_type')
    expect(db.profiles[0].member_type).toBe('professional')
  })
})

// ═══ 6. Everything else about the Professional path is unchanged ═════════════════════════════
describe('6. updateProfile keeps its existing semantics', () => {
  it('still conflicts on the primary key and still never writes onboarding_step', async () => {
    db.profiles.push(profileRow())
    await updateProfile(form())

    const u = upserts.find((x) => x.table === 'profiles')!
    expect(u.target).toBeUndefined()                       // PostgREST default = primary key
    expect(Object.keys(u.payload)).not.toContain('onboarding_step')
    expect(Object.keys(u.payload)).not.toContain('profile_complete')
  })

  it('normalises the address it stores', async () => {
    db.profiles.push(profileRow({ email: 'member@example.com' }))
    cfg.user = { id: 'u1', email: '  Member@Example.COM ' }

    await updateProfile(form())

    expect(db.profiles).toHaveLength(1)
    expect(db.profiles[0].email).toBe('member@example.com')
  })

  it('omits the email key entirely when the session carries no address — never writes empty string', async () => {
    db.profiles.push(profileRow())
    cfg.user = { id: 'u1', email: undefined }

    await updateProfile(form())

    const u = upserts.find((x) => x.table === 'profiles')!
    expect(Object.keys(u.payload)).not.toContain('email')   // '' is a real value to a UNIQUE index
    expect(db.profiles[0].email).toBe('member@example.com') // pre-existing value left intact
  })
})

// ═══ Source guards ═══════════════════════════════════════════════════════════════════════════
describe('source: one normalisation rule, and no raw address reaches a profile write', () => {
  it('neither profile upsert sends user.email raw', () => {
    expect(ACTIONS).not.toMatch(/\.from\('profiles'\)\.upsert\(\{[\s\S]{0,120}email: user\.email/)
  })

  it('both use the canonical helper — there is no second implementation of the rule', () => {
    expect(ACTIONS).toMatch(/import \{[^}]*normalizeEmail[^}]*\} from '@\/lib\/invitations'/)
    // No ad-hoc inline re-implementation of trim+lowercase for an address.
    expect(ACTIONS).not.toMatch(/email:\s*\(?user\.email[^\n]*\.toLowerCase\(\)/)
  })

  it('completeOnboarding names the primary key as its conflict target', () => {
    const body = ACTIONS.slice(
      ACTIONS.indexOf('export async function completeOnboarding'),
      ACTIONS.indexOf('export async function saveAvatarUrl'),
    )
    expect(body).toMatch(/\}, \{ onConflict: 'id' \}\)/)

    // Comments are stripped first: the rationale above the upsert quotes the old `onConflict:
    // 'email'` to explain what was wrong with it, and that prose must not be mistaken for code.
    const executable = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(executable).not.toMatch(/onConflict: 'email'/)
  })
})
