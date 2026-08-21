import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

// Mutable state the mocked Supabase clients read.
const state = vi.hoisted(() => ({
  user: { id: 'ref1' } as any,
  referrerProfile: { id: 'ref1', email: 'me@x.com', account_status: 'active' } as any,
  lastReferralInsert: null as any, // captures the referrals insert payload
  lastWaitlistInsert: null as any, // captures the waitlist insert payload
  admin: {
    select: { profiles: { data: null, error: null }, waitlist: { data: null, error: null }, referrals: { data: null, error: null } },
    insert: { waitlist: { data: { id: 'wl1' }, error: null }, referrals: { data: { id: 're1' }, error: null } },
    insertErrorOnce: {} as Record<string, any>, // return this error on the FIRST insert to `table`, then clear
  } as any,
  /** Set to simulate a FAILED nominator read (permission/timeout) — must not read as "not found". */
  referrerProfileError: null as any,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: state.referrerProfile, error: null }) }) }) }),
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const b: any = { table, isInsert: false }
      b.select = () => b
      b.insert = (payload: any) => {
        b.isInsert = true
        if (table === 'referrals') state.lastReferralInsert = payload
        if (table === 'waitlist') state.lastWaitlistInsert = payload
        return b
      }
      // The route now makes TWO admin reads of `profiles`: the NOMINATOR (by id) and the NOMINEE
      // (by email, via .ilike). They used to be distinguishable because the nominator came from the
      // caller-scoped client — migration 058 revoked that, so both are server reads now and the mock
      // has to tell them apart the same way the route does.
      b.eq = () => b; b.neq = () => b; b.in = () => b
      b.ilike = () => { b.byEmail = true; return b }
      b.maybeSingle = async () => {
        if (table === 'profiles' && !b.byEmail) {
          return state.referrerProfileError ?? { data: state.referrerProfile, error: null }
        }
        return state.admin.select[table] ?? { data: null, error: null }
      }
      b.single = async () => {
        if (!b.isInsert) return state.admin.select[table] ?? { data: null, error: null }
        const once = state.admin.insertErrorOnce[table]
        if (once) { state.admin.insertErrorOnce[table] = null; return once } // one-shot insert error
        return state.admin.insert[table] ?? { data: null, error: null }
      }
      return b
    },
  }),
}))

import { POST } from '@/app/api/referrals/submit/route'

const post = (body: any) =>
  POST(new Request('http://localhost/api/referrals/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))
const validBody = (email = 'jane@example.com') => ({ full_name: 'Jane Smith', email, referral_note: 'A great person who belongs here.' })

beforeEach(() => {
  state.user = { id: 'ref1' }
  state.referrerProfile = { id: 'ref1', email: 'me@x.com', account_status: 'active' }
  state.lastReferralInsert = null
  state.lastWaitlistInsert = null
  state.referrerProfileError = null
  state.admin = {
    select: { profiles: { data: null, error: null }, waitlist: { data: null, error: null }, referrals: { data: null, error: null } },
    insert: { waitlist: { data: { id: 'wl1' }, error: null }, referrals: { data: { id: 're1' }, error: null } },
    insertErrorOnce: {},
  }
})

describe('nominations are unlimited (no quantity cap)', () => {
  // 1–5: the route never counts existing nominations, so the 1st, 2nd, 3rd, 4th,
  // and 10th all succeed identically. Existing count is irrelevant by design.
  it('1–5. first, second, third, fourth, and tenth nominations all succeed', async () => {
    for (let n = 1; n <= 10; n++) {
      const res = await post(validBody(`person${n}@example.com`))
      const data = await res.json()
      expect(res.status).toBe(200)
      expect(data.ok).toBe(true)
      expect(data.code).toBeUndefined()
    }
  })

  it('6. a user who already has 3 pending nominations can still submit another', async () => {
    // The route does not query outstanding count at all — a "4th" is just a submit.
    const res = await post(validBody('fourth@example.com'))
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.code).not.toBe('CAP_REACHED')
  })

  it('7. an admin with 3 existing nominations can also submit another (same unlimited rule)', async () => {
    state.referrerProfile = { id: 'admin1', email: 'admin@x.com', account_status: 'active', is_admin: true }
    const res = await post(validBody('admin-nom@example.com'))
    expect((await res.json()).ok).toBe(true)
  })

  it('14. the API never returns a CAP_REACHED / limit error', async () => {
    const res = await post(validBody())
    const data = await res.json()
    expect(data.code).not.toBe('CAP_REACHED')
    expect(JSON.stringify(data)).not.toMatch(/maximum of \d+ (outstanding )?referrals|nomination limit|reached the maximum/i)
  })
})

describe('retained protections still apply', () => {
  it('8. duplicate email already on the waitlist is rejected (case-insensitive dedup)', async () => {
    state.admin.select.waitlist = { data: { id: 'wl_existing' }, error: null }
    const res = await post(validBody('DUP@example.com'))
    const data = await res.json()
    expect(res.status).toBe(409)
    expect(data.code).toBe('EMAIL_ON_WAITLIST')
  })

  it('9. invalid email is rejected', async () => {
    const res = await post(validBody('not-an-email'))
    expect((await res.json()).code).toBe('INVALID_EMAIL')
  })

  it('10. nominating an existing active member is rejected', async () => {
    state.admin.select.profiles = { data: { id: 'member1' }, error: null }
    const res = await post(validBody('member@example.com'))
    const data = await res.json()
    expect(res.status).toBe(409)
    expect(data.code).toBe('EMAIL_ALREADY_MEMBER')
  })

  it('11. unauthenticated nomination is rejected', async () => {
    state.user = null
    const res = await post(validBody())
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('UNAUTHORIZED')
  })

  it('a deactivated referrer is rejected', async () => {
    state.referrerProfile = { id: 'ref1', email: 'me@x.com', account_status: 'deactivated' }
    expect((await post(validBody())).status).toBe(403)
  })

  it('15. unrelated validations remain intact (self-referral, note length)', async () => {
    expect((await post(validBody('me@x.com')).then(r => r.json())).code).toBe('SELF_REFERRAL')
    expect((await post({ ...validBody(), referral_note: 'x'.repeat(2001) }).then(r => r.json())).code).toBe('NOTE_TOO_LONG')
  })

  it('a previously-rejected referral email is still blocked', async () => {
    state.admin.select.waitlist = { data: { id: 'wl_rej' }, error: null }
    state.admin.select.referrals = { data: { id: 'rej1' }, error: null }
    expect((await post(validBody()).then(r => r.json())).code).toBe('REFERRAL_PREVIOUSLY_REJECTED')
  })
})

describe('referral note is REQUIRED (referrals CHECK: length(trim(referral_note)) > 0)', () => {
  it('rejects a BLANK note — before creating any waitlist row (no orphan)', async () => {
    const res = await post({ ...validBody(), referral_note: '' })
    const data = await res.json()
    expect(res.status).toBe(400)
    expect(data.code).toBe('MISSING_FIELDS')
    // Validation 1 runs BEFORE the waitlist insert — nothing is written.
    expect(state.lastWaitlistInsert).toBeNull()
    expect(state.lastReferralInsert).toBeNull()
  })

  it('rejects a WHITESPACE-only note (would violate the non-empty CHECK)', async () => {
    const res = await post({ ...validBody(), referral_note: '   ' })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('MISSING_FIELDS')
    expect(state.lastWaitlistInsert).toBeNull() // no orphaned waitlist row
  })

  it('rejects an OMITTED note', async () => {
    const res = await post({ full_name: 'Jane Smith', email: 'jane@example.com' })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('MISSING_FIELDS')
    expect(state.lastWaitlistInsert).toBeNull()
  })

  it('ACCEPTS a non-empty note and stores it trimmed', async () => {
    const res = await post({ ...validBody(), referral_note: '  Knows them well  ' })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(state.lastReferralInsert.referral_note).toBe('Knows them well') // trimmed, non-empty
  })

  it('the note length cap still applies', async () => {
    const res = await post({ ...validBody(), referral_note: 'x'.repeat(2001) })
    expect((await res.json()).code).toBe('NOTE_TOO_LONG')
  })
})

describe('additive: relationship field (optional) — preserved', () => {
  it('relationship is persisted on the referrals row when provided', async () => {
    const res = await post({ ...validBody(), relationship: 'former colleague' })
    expect(res.status).toBe(200)
    expect(state.lastReferralInsert.relationship).toBe('former colleague')
  })

  it('fails open when referrals.relationship is not migrated yet (42703 → retry without it)', async () => {
    // First insert (with relationship) hits undefined-column; route retries without it.
    state.admin.insertErrorOnce.referrals = { data: null, error: { code: '42703', message: "column referrals.relationship does not exist" } }
    const res = await post({ ...validBody(), relationship: 'client' })
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.ok).toBe(true)
    // The successful (retry) insert carried NO relationship key.
    expect('relationship' in state.lastReferralInsert).toBe(false)
  })
})

describe('LinkedIn profile field (optional, URL-validated, stored on the nominee)', () => {
  it('accepts a valid LinkedIn URL and persists it on the waitlist row', async () => {
    const res = await post({ ...validBody(), linkedin_url: 'https://www.linkedin.com/in/jane' })
    expect(res.status).toBe(200)
    expect(state.lastWaitlistInsert.linkedin_url).toBe('https://www.linkedin.com/in/jane')
  })

  it('rejects a malformed LinkedIn URL', async () => {
    const res = await post({ ...validBody(), linkedin_url: 'not a url' })
    const data = await res.json()
    expect(res.status).toBe(400)
    expect(data.code).toBe('INVALID_LINKEDIN')
  })

  it('rejects a non-http(s) scheme', async () => {
    const res = await post({ ...validBody(), linkedin_url: 'javascript:alert(1)' })
    expect((await res.json()).code).toBe('INVALID_LINKEDIN')
  })

  it('is fully optional — omitting it stores null and still succeeds', async () => {
    const res = await post(validBody())
    expect(res.status).toBe(200)
    expect(state.lastWaitlistInsert.linkedin_url).toBeNull()
  })
})

describe('Referrer consent (privacy)', () => {
  it('stores referrer_consent_to_share=true when the member ticks the box', async () => {
    const res = await post({ ...validBody(), consent: true })
    expect(res.status).toBe(200)
    expect(state.lastReferralInsert.referrer_consent_to_share).toBe(true)
  })

  it('defaults to no consent (false) when the box is unticked / omitted', async () => {
    const res = await post(validBody())
    expect(res.status).toBe(200)
    expect(state.lastReferralInsert.referrer_consent_to_share).toBe(false)
    // Consent is optional — a valid submission still requires a note, but not consent.
  })

  it('fails open when referrals.referrer_consent_to_share is not migrated (037) — retry without it', async () => {
    state.admin.insertErrorOnce.referrals = { data: null, error: { code: 'PGRST204', message: "Could not find the 'referrer_consent_to_share' column of 'referrals' in the schema cache" } }
    const res = await post({ ...validBody(), consent: true })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect('referrer_consent_to_share' in state.lastReferralInsert).toBe(false)
  })
})

describe('no cap remains in source (structural)', () => {
  const route = readFileSync('app/api/referrals/submit/route.ts', 'utf8')
  const page = readFileSync('app/dashboard/referrals/page.tsx', 'utf8')
  const form = readFileSync('app/dashboard/referrals/ReferralForm.tsx', 'utf8')

  it('server route has no count/cap check', () => {
    expect(route).not.toContain('CAP_REACHED')
    expect(route).not.toMatch(/outstandingCount|>=\s*3|maximum of 3/)
    // dedup protection (case-insensitive) preserved
    expect(route).toContain(".ilike('email', targetEmail)")
  })

  it('12/13. page always renders the form, with no SLOTS_TOTAL gating or count message', () => {
    expect(page).not.toContain('SLOTS_TOTAL')
    expect(page).not.toContain('canRefer')
    expect(page).not.toMatch(/up to .* open nominations/i)
    expect(page).toContain('<ReferralForm')
  })

  it('13. the form has no obsolete cap message', () => {
    expect(form).not.toContain('CAP_REACHED')
    expect(form).not.toMatch(/up to 3|nomination limit|reached your/i)
  })
})

/**
 * The A3 regression: migration 058 revoked authenticated SELECT on public.profiles, and this route
 * was reading it with the caller's client. The read failed, only `data` was destructured, and every
 * member who tried to nominate someone was told "Profile not found" — about their OWN profile,
 * which existed. The nominee was never the problem.
 */
describe('nominator resolution after the A3 revoke', () => {
  it('an eligible member can nominate an external person with NO Andrel account', async () => {
    state.admin.select.profiles = { data: null, error: null }   // nominee does not exist — the normal case
    const res = await post(validBody('brand-new@example.com'))
    expect(res.status).toBe(200)
    expect(state.lastWaitlistInsert).toBeTruthy()
    expect(state.lastReferralInsert).toBeTruthy()
  })

  it('a FAILED nominator read is 503 — never "Profile not found"', async () => {
    state.referrerProfileError = { data: null, error: { code: '42501' } }   // permission denied
    const res = await post(validBody())
    const body = await res.json()
    expect(res.status).toBe(503)
    expect(body.code).toBe('PROFILE_UNAVAILABLE')
    expect(JSON.stringify(body)).not.toMatch(/Profile not found/)
    expect(state.lastWaitlistInsert).toBeNull()                             // nothing was written
  })

  it('a genuinely missing nominator profile is 404 and distinct from the failure case', async () => {
    state.referrerProfile = null
    const res = await post(validBody())
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body.code).toBe('PROFILE_NOT_FOUND')
  })

  it('a deactivated nominator is 403 and distinct from both', async () => {
    state.referrerProfile = { id: 'ref1', email: 'me@x.com', account_status: 'deactivated' }
    const res = await post(validBody())
    const body = await res.json()
    expect(res.status).toBe(403)
    expect(body.code).toBe('REFERRER_INACTIVE')
  })

  it('an unauthenticated caller is 401, before any profile read happens', async () => {
    state.user = null
    const res = await post(validBody())
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('UNAUTHORIZED')
  })

  it('no raw database message reaches the member in any failure mode', async () => {
    state.referrerProfileError = { data: null, error: { code: '42501', message: 'permission denied for table profiles' } }
    const body = await (await post(validBody())).json()
    expect(JSON.stringify(body)).not.toMatch(/permission denied|42501|relation|table profiles/)
  })
})
