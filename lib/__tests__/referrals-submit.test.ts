import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

// Mutable state the mocked Supabase clients read.
const state = vi.hoisted(() => ({
  user: { id: 'ref1' } as any,
  referrerProfile: { id: 'ref1', email: 'me@x.com', account_status: 'active' } as any,
  admin: {
    select: { profiles: { data: null, error: null }, waitlist: { data: null, error: null }, referrals: { data: null, error: null } },
    insert: { waitlist: { data: { id: 'wl1' }, error: null }, referrals: { data: { id: 're1' }, error: null } },
  } as any,
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
      b.insert = () => { b.isInsert = true; return b }
      b.eq = () => b; b.neq = () => b; b.in = () => b; b.ilike = () => b
      b.maybeSingle = async () => state.admin.select[table] ?? { data: null, error: null }
      b.single = async () => (b.isInsert ? state.admin.insert[table] : state.admin.select[table]) ?? { data: null, error: null }
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
  state.admin = {
    select: { profiles: { data: null, error: null }, waitlist: { data: null, error: null }, referrals: { data: null, error: null } },
    insert: { waitlist: { data: { id: 'wl1' }, error: null }, referrals: { data: { id: 're1' }, error: null } },
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
