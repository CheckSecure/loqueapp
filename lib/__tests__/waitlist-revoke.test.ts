import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { isBlockedTransition, canTransition } from '@/lib/referrals/statusTransitions'

// ── Hoisted in-memory backend for the revoke route ────────────────────────────
const h = vi.hoisted(() => ({
  user: { id: 'admin', email: 'bizdev91@gmail.com' } as any,
  waitlist: [] as any[],
  profiles: [] as any[],     // { id, email, profile_complete }
  authUsers: [] as any[],    // { id, email, last_sign_in_at }
  deleted: [] as string[],
  referralUpdates: [] as any[],
  missingRevokedAt: false,
  raceFlip: false,           // simulate onboarding completing DURING the revoke
  ledger: [] as any[],       // deletion events the route wrote (migration 075)
  ledgerFails: false,        // simulate the ledger being unwritable — the revoke must refuse
}))

vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }),
}))

vi.mock('@supabase/supabase-js', () => {
  function from(table: string) {
    let op: 'select' | 'update' | 'delete' = 'select'
    let payload: any = null
    const filters: ((r: any) => boolean)[] = []
    const b: any = {
      select() { return b }, // no-op — op is set by delete()/update(); default is select
      update(v: any) { op = 'update'; payload = v; return b },
      delete() { op = 'delete'; return b },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b },
      ilike(k: string, v: any) { filters.push((r) => String(r[k] ?? '').toLowerCase() === String(v ?? '').toLowerCase()); return b },
      maybeSingle() { return run().then((x: any) => ({ data: x.data[0] ?? null, error: x.error })) },
      then(res: any, rej: any) { return run().then(res, rej) },
    }
    const match = (r: any) => filters.every((f) => f(r))
    async function run() {
      const store = (h as any)[table] as any[] || []
      if (op === 'update') {
        if (table === 'referrals') { h.referralUpdates.push(payload); return { data: [], error: null } }
        if ('revoked_at' in payload && h.missingRevokedAt) {
          return { data: [], error: { code: 'PGRST204', message: "Could not find the 'revoked_at' column" } }
        }
        const upd = store.filter(match)
        for (const r of upd) Object.assign(r, payload)
        return { data: upd, error: null }
      }
      if (op === 'delete') {
        if (table === 'profiles' && h.raceFlip) {
          for (const r of store) r.profile_complete = true // onboarding just completed
        }
        const removed = store.filter(match)
        for (let i = store.length - 1; i >= 0; i--) if (match(store[i])) store.splice(i, 1)
        return { data: removed.map((r) => ({ ...r })), error: null }
      }
      return { data: store.filter(match).map((r) => ({ ...r })), error: null }
    }
    return b
  }
  return {
    createClient: () => ({
      from,
      // The revoke path now writes an immutable deletion record (migration 075) BEFORE it destroys
      // anything, and refuses the revoke if that write fails. The mock must therefore model the RPC.
      rpc: async (name: string, params: any) => {
        if (name !== 'record_account_deletion_event') return { data: null, error: null }
        if (h.ledgerFails) return { data: null, error: { code: '42501', message: 'denied' } }
        h.ledger.push({ stage: params.p_stage, actor: params.p_actor_category,
                        path: params.p_deletion_path, user: params.p_deleted_user_id,
                        errorClass: params.p_error_class, deletionId: params.p_deletion_id })
        return { data: 'evt', error: null }
      },
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
  h.raceFlip = false
  h.ledger = []
  h.ledgerFails = false
})

const wl = (id = 'e1') => h.waitlist.find((r) => r.id === id)
const prof = (id = 'u1') => h.profiles.find((p) => p.id === id)

// ==============================================================================
// Canonical rule: revocable UNLESS the person is a fully active member
// (profile_complete = true — the exact signal the Invited tab uses to exclude).
// ==============================================================================
describe('revoke API — Invited-vs-Member classification', () => {
  it('never signed in (no auth, no profile) → revocable', async () => {
    h.authUsers = []; h.profiles = []
    const res = await post('e1')
    expect(res.status).toBe(200)
    expect(wl().status).toBe('revoked')
  })

  it('signed in but NO profile → revocable (sign-in alone is NOT activation)', async () => {
    h.authUsers = [{ id: 'u1', email: 'a@x.com', last_sign_in_at: '2026-01-01T00:00:00Z' }]
    h.profiles = []
    const res = await post('e1')
    expect(res.status).toBe(200)
    expect(wl().status).toBe('revoked')
    expect(h.deleted).toContain('u1')
  })

  it('PARTIAL profile (profile_complete=false) → revocable, and the partial profile is cleaned up', async () => {
    h.authUsers = [{ id: 'u1', email: 'a@x.com', last_sign_in_at: '2026-01-01T00:00:00Z' }]
    h.profiles = [{ id: 'u1', email: 'a@x.com', profile_complete: false }]
    const res = await post('e1')
    expect(res.status).toBe(200)
    expect(wl().status).toBe('revoked')
    expect(prof('u1')).toBeUndefined() // partial profile removed — no orphan
    expect(h.deleted).toContain('u1')  // auth account removed
  })

  it('onboarding incomplete (partial profile, different case email) → revocable', async () => {
    h.authUsers = [{ id: 'u1', email: 'A@X.com', last_sign_in_at: '2026-02-02T00:00:00Z' }]
    h.profiles = [{ id: 'u1', email: 'A@X.com', profile_complete: false }]
    const res = await post('e1')
    expect(res.status).toBe(200)
    expect(wl().status).toBe('revoked')
  })

  it('FULLY ACTIVE member (profile_complete=true) → BLOCKED, nothing changed', async () => {
    h.authUsers = [{ id: 'u1', email: 'a@x.com', last_sign_in_at: '2026-01-01T00:00:00Z' }]
    h.profiles = [{ id: 'u1', email: 'a@x.com', profile_complete: true }]
    const res = await post('e1')
    const data = await res.json()
    expect(res.status).toBe(409)
    expect(data.activated).toBe(true)
    expect(data.error).toMatch(/already been activated/i)
    expect(data.error).toMatch(/Members section/i)
    expect(wl().status).toBe('invited')     // unchanged
    expect(prof('u1')).toBeTruthy()          // member profile NOT deleted
    expect(h.deleted).toHaveLength(0)        // auth NOT deleted
  })

  it('RACE: onboarding completes between the check and cleanup → aborts, no revoke', async () => {
    h.authUsers = [{ id: 'u1', email: 'a@x.com', last_sign_in_at: '2026-01-01T00:00:00Z' }]
    h.profiles = [{ id: 'u1', email: 'a@x.com', profile_complete: false }] // partial at check time
    h.raceFlip = true // flips to complete during the conditional delete
    const res = await post('e1')
    const data = await res.json()
    expect(res.status).toBe(409)
    expect(data.activated).toBe(true)
    expect(wl().status).toBe('invited')     // NOT revoked
    expect(h.deleted).toHaveLength(0)        // auth NOT deleted
    expect(prof('u1')).toBeTruthy()          // now-complete member profile preserved
  })
})

// ==============================================================================
describe('revoke API — safety & edges', () => {
  it('is idempotent — a second revoke returns success without re-deleting', async () => {
    await post('e1')
    expect(h.deleted).toEqual(['u1'])
    const res = await post('e1')
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.alreadyRevoked).toBe(true)
    expect(h.deleted).toEqual(['u1'])
  })

  it('succeeds when the auth user is missing (nothing to delete)', async () => {
    h.authUsers = []
    const res = await post('e1')
    expect(res.status).toBe(200)
    expect(wl().status).toBe('revoked')
    expect(h.deleted).toHaveLength(0)
  })

  it('falls back to status-only when revoked_at is not migrated yet', async () => {
    h.missingRevokedAt = true
    const res = await post('e1')
    expect(res.status).toBe(200)
    expect(wl().status).toBe('revoked')
  })

  it('404 for a missing waitlist record', async () => {
    expect((await post('nope')).status).toBe(404)
  })

  it('409 when not in an invited state (e.g. approved)', async () => {
    h.waitlist = [{ id: 'e1', email: 'a@x.com', status: 'approved' }]
    expect((await post('e1')).status).toBe(409)
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
  it('does NOT gate on last_sign_in_at or mere profile existence; uses profile_complete', () => {
    const route = readFileSync('app/api/admin/waitlist/revoke/route.ts', 'utf8')
    expect(route).toMatch(/profile_complete/)
    expect(route).not.toMatch(/\.last_sign_in_at/) // no sign-in property gate; canonical signal is profile_complete
  })

  it('transition map allows invited → revoked and makes revoked terminal', () => {
    expect(canTransition('invited', 'revoked')).toBe(true)
    expect(isBlockedTransition('approved', 'revoked')).toBe(true)
    expect(isBlockedTransition('revoked', 'invited')).toBe(true)
  })

  it('reminder emails only target status=invited → revoked rows are excluded', () => {
    expect(readFileSync('app/api/cron/activation-reminders/route.ts', 'utf8')).toMatch(/\.eq\('status',\s*'invited'\)/)
    expect(readFileSync('app/api/admin/first-matching-reminder/send/route.ts', 'utf8')).toMatch(/\.eq\('status',\s*'invited'\)/)
  })
})

// ==============================================================================
describe('revoke — admin UI', () => {
  const client = readFileSync('components/AdminWaitlistClient.tsx', 'utf8')
  it('shows a Revoke Invite action on invited rows', () => {
    expect(client).toContain('Revoke Invite')
    expect(client).toContain('openRevoke(entry)')
  })
  it('has a confirmation dialog with the required title, body, and emphasized button', () => {
    expect(client).toContain('Revoke Invitation?')
    expect(client).toMatch(/prevent[\s\S]*from activating their account using the existing invite/)
    expect(client).toMatch(/mistaken invitations, duplicate records, or members who requested removal/)
    expect(client).toMatch(/bg-red-600[\s\S]*Revoke Invite/)
  })
  it('refreshes the table on success', () => {
    expect(client).toMatch(/doRevoke[\s\S]*router\.refresh\(\)/)
  })
})

// ==============================================================================
// The deletion ledger (migration 075). A member disappeared once and nothing in the
// database could say who removed them or how. These pin the record that now makes
// that impossible — and the refusal that keeps it from being skipped.
// ==============================================================================

describe('revoke leaves an immutable deletion record', () => {
  it('records requested → data_deleted → auth_deleted for a real deletion', async () => {
    const res = await post('e1')
    expect(res.status).toBe(200)
    expect(h.ledger.map((e: any) => e.stage)).toEqual(['requested', 'data_deleted', 'auth_deleted'])
    // one deletion, so one shared id
    expect(new Set(h.ledger.map((e: any) => e.deletionId)).size).toBe(1)
    expect(h.ledger[0].actor).toBe('admin')
    expect(h.ledger[0].path).toBe('admin_invite_revoke')
    expect(h.ledger[0].user).toBe('u1')
  })

  it('writes the record BEFORE the auth user is deleted', async () => {
    await post('e1')
    // the auth deletion happened, and a 'requested' event preceded it
    expect(h.deleted).toEqual(['u1'])
    expect(h.ledger[0].stage).toBe('requested')
  })

  it('FAILS CLOSED: an unwritable ledger refuses the revoke and deletes nothing', async () => {
    h.ledgerFails = true
    const res = await post('e1')
    expect(res.status).toBe(500)
    expect(h.deleted).toEqual([])                 // no auth user removed
    expect(wl()!.status).toBe('invited')          // waitlist untouched
    expect(h.ledger).toEqual([])
  })

  it('records a failure CLASS, never the provider message, when auth deletion fails', async () => {
    h.authUsers = [{ id: 'u1', email: 'a@x.com', last_sign_in_at: null }]
    const mod = await import('@supabase/supabase-js')
    const orig = (mod as any).createClient
    ;(mod as any).createClient = () => {
      const c = orig()
      c.auth.admin.deleteUser = async () => ({ error: { message: 'a@x.com could not be deleted' } })
      return c
    }
    const res = await post('e1')
    ;(mod as any).createClient = orig
    expect(res.status).toBe(200)
    const terminal = h.ledger[h.ledger.length - 1]
    expect(terminal.stage).toBe('failed')
    expect(terminal.errorClass).toBe('auth_api_error')
    expect(JSON.stringify(h.ledger)).not.toContain('a@x.com')
  })

  it('writes NOTHING when the revoke destroys nothing (status change only)', async () => {
    h.authUsers = []
    h.profiles = []
    const res = await post('e1')
    expect(res.status).toBe(200)
    expect(wl()!.status).toBe('revoked')
    expect(h.ledger).toEqual([])   // a status change is not a deletion and must not be logged as one
  })
})
