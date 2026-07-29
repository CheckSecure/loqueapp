import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { isBlockedTransition, canTransition } from '@/lib/referrals/statusTransitions'

// ── Hoisted in-memory backend for the revoke route ────────────────────────────
const h = vi.hoisted(() => ({
  user: { id: 'admin', email: 'bizdev91@gmail.com' } as any,
  waitlist: [] as any[],
  profiles: [] as any[],
  authUsers: [] as any[],
  deleted: [] as string[],
  referralUpdates: [] as any[],
  missingRevokedAt: false,
}))

vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}))

vi.mock('@supabase/supabase-js', () => {
  function from(table: string) {
    let op: 'select' | 'update' = 'select'
    let payload: any = null
    const filters: ((r: any) => boolean)[] = []
    const b: any = {
      select() { op = 'select'; return b },
      update(v: any) { op = 'update'; payload = v; return b },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b },
      maybeSingle() { return run().then((x: any) => ({ data: x.data[0] ?? null, error: x.error })) },
      then(res: any, rej: any) { return run().then(res, rej) },
    }
    const match = (r: any) => filters.every((f) => f(r))
    async function run() {
      const store = (h as any)[table] || []
      if (op === 'update') {
        if (table === 'referrals') { h.referralUpdates.push(payload); return { data: [], error: null } }
        if ('revoked_at' in payload && h.missingRevokedAt) {
          return { data: [], error: { code: 'PGRST204', message: "Could not find the 'revoked_at' column" } }
        }
        const upd = store.filter(match)
        for (const r of upd) Object.assign(r, payload)
        return { data: upd, error: null }
      }
      return { data: store.filter(match), error: null }
    }
    return b
  }
  return {
    createClient: () => ({
      from,
      auth: {
        admin: {
          listUsers: async () => ({ data: { users: h.authUsers }, error: null }),
          deleteUser: async (id: string) => {
            h.deleted.push(id)
            const i = h.authUsers.findIndex((u) => u.id === id)
            if (i >= 0) h.authUsers.splice(i, 1)
            return { error: null }
          },
        },
      },
    }),
  }
})

import { POST } from '@/app/api/admin/waitlist/revoke/route'

const post = (entryId: any) =>
  POST(new Request('http://x/api/admin/waitlist/revoke', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entryId }),
  }))

beforeEach(() => {
  h.user = { id: 'admin', email: 'bizdev91@gmail.com' }
  h.waitlist = [{ id: 'e1', email: 'a@x.com', full_name: 'Alice', status: 'invited' }]
  h.profiles = []
  h.authUsers = [{ id: 'u1', email: 'a@x.com', last_sign_in_at: null }]
  h.deleted = []
  h.referralUpdates = []
  h.missingRevokedAt = false
})

const wl = (id = 'e1') => h.waitlist.find((r) => r.id === id)

// ==============================================================================
describe('revoke API — business rules', () => {
  it('revokes an invited, not-activated invitation (status → revoked, auth deleted)', async () => {
    const res = await post('e1')
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(wl().status).toBe('revoked')
    expect(wl().revoked_at).toBeTruthy()
    expect(h.deleted).toContain('u1') // auth account removed → cannot sign in
    expect(h.referralUpdates[0]).toMatchObject({ status: 'rejected' }) // referral synced
  })

  it('REJECTS revoke when already activated (signed in) — never changes status or deletes auth', async () => {
    h.authUsers = [{ id: 'u1', email: 'a@x.com', last_sign_in_at: '2026-01-01T00:00:00Z' }]
    const res = await post('e1')
    const data = await res.json()
    expect(res.status).toBe(409)
    expect(data.activated).toBe(true)
    expect(data.error).toMatch(/already been activated/i)
    expect(data.error).toMatch(/Members section/i)
    expect(wl().status).toBe('invited') // unchanged
    expect(h.deleted).toHaveLength(0)   // auth NOT deleted
  })

  it('REJECTS revoke when a profile exists (activated via onboarding)', async () => {
    h.profiles = [{ id: 'u1' }]
    const res = await post('e1')
    expect(res.status).toBe(409)
    expect(wl().status).toBe('invited')
    expect(h.deleted).toHaveLength(0)
  })

  it('is idempotent — revoking an already-revoked entry returns success, no re-deletion', async () => {
    await post('e1')                    // first revoke
    expect(h.deleted).toEqual(['u1'])
    const res = await post('e1')        // duplicate / retry
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.alreadyRevoked).toBe(true)
    expect(h.deleted).toEqual(['u1'])   // not deleted twice
  })

  it('succeeds even if the auth user is missing (nothing to delete)', async () => {
    h.authUsers = []
    const res = await post('e1')
    expect(res.status).toBe(200)
    expect(wl().status).toBe('revoked')
    expect(h.deleted).toHaveLength(0)
  })

  it('falls back to status-only when the revoked_at column is not migrated yet', async () => {
    h.missingRevokedAt = true
    const res = await post('e1')
    expect(res.status).toBe(200)
    expect(wl().status).toBe('revoked') // still revoked; timestamp simply not stored
  })

  it('404 for a missing waitlist record', async () => {
    const res = await post('nope')
    expect(res.status).toBe(404)
  })

  it('409 when the entry is not in an invited state (e.g. approved)', async () => {
    h.waitlist = [{ id: 'e1', email: 'a@x.com', status: 'approved' }]
    const res = await post('e1')
    expect(res.status).toBe(409)
    expect(wl().status).toBe('approved')
  })

  it('401 for a non-admin caller', async () => {
    h.user = { id: 'x', email: 'someone@else.com' }
    expect((await post('e1')).status).toBe(401)
    h.user = null
    expect((await post('e1')).status).toBe(401)
  })
})

// ==============================================================================
describe('revoke — lifecycle + email exclusion (source invariants)', () => {
  it('the transition map allows invited → revoked and makes revoked terminal', () => {
    expect(canTransition('invited', 'revoked')).toBe(true)
    expect(isBlockedTransition('invited', 'revoked')).toBe(false)
    expect(isBlockedTransition('approved', 'revoked')).toBe(true)
    expect(isBlockedTransition('declined', 'revoked')).toBe(true)
    // terminal — cannot be re-invited or re-declined
    expect(isBlockedTransition('revoked', 'invited')).toBe(true)
    expect(isBlockedTransition('revoked', 'declined')).toBe(true)
  })

  it('a revoked row leaves the Invited tab (status !== invited)', () => {
    const client = readFileSync('components/AdminWaitlistClient.tsx', 'utf8')
    expect(client).toMatch(/entry\.status === activeTab/) // rows are filtered by status
  })

  it('reminder emails only target status=invited → revoked rows are excluded', () => {
    const act = readFileSync('app/api/cron/activation-reminders/route.ts', 'utf8')
    const fmr = readFileSync('app/api/admin/first-matching-reminder/send/route.ts', 'utf8')
    expect(act).toMatch(/\.eq\('status',\s*'invited'\)/)
    expect(fmr).toMatch(/\.eq\('status',\s*'invited'\)/)
  })
})

// ==============================================================================
describe('revoke — admin UI', () => {
  const client = readFileSync('components/AdminWaitlistClient.tsx', 'utf8')

  it('shows a Revoke Invite action on invited rows', () => {
    expect(client).toContain('Revoke Invite')
    expect(client).toContain('openRevoke(entry)')
  })

  it('has a confirmation dialog with the required title, body, and buttons', () => {
    expect(client).toContain('Revoke Invitation?')
    expect(client).toMatch(/prevent[\s\S]*from activating their account using the existing invite/)
    expect(client).toMatch(/mistaken invitations, duplicate records, or members who requested removal/)
    expect(client).toMatch(/Cancel/)
    expect(client).toMatch(/bg-red-600[\s\S]*Revoke Invite/) // emphasized destructive button
  })

  it('refreshes the table on success (row disappears without manual reload)', () => {
    expect(client).toMatch(/doRevoke[\s\S]*router\.refresh\(\)/)
  })
})
