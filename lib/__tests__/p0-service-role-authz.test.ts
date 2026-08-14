import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * BLOCKER 3 — prove that every service-role write moved out of a user-scoped client still occurs ONLY
 * after getUser()-based authorization. These are the foreign-object negative tests: a non-admin cannot
 * reach an admin-gated write, and a non-participant cannot reschedule someone else's meeting or
 * accept/decline an introduction they aren't the target of. In every rejection, NO service-role write is
 * attempted.
 */

const cfg: any = { user: { id: 'me', email: 'member@x.com' }, rows: {} }
const adminWrites: any[] = []

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: cfg.user } }) },
    from: (table: string) => {
      const b: any = {
        select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b,
        single: async () => ({ data: cfg.rows[table] ?? null, error: cfg.rows[table] ? null : { message: 'not found' } }),
        maybeSingle: async () => ({ data: cfg.rows[table] ?? null, error: null }),
      }
      return b
    },
  }),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const b: any = {
        update: (p: any) => { adminWrites.push({ table, op: 'update', payload: p }); return b },
        insert: (p: any) => { adminWrites.push({ table, op: 'insert', payload: p }); return b },
        upsert: (p: any) => { adminWrites.push({ table, op: 'upsert', payload: p }); return b },
        delete: () => { adminWrites.push({ table, op: 'delete' }); return b },
        select: () => b, eq: () => b, in: () => b,
        single: async () => ({ data: { id: 'x' }, error: null }),
        maybeSingle: async () => ({ data: cfg.rows[table] ?? null, error: null }),
        then: (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej),
      }
      return b
    },
    rpc: async () => ({ data: [{}], error: null }),
  }),
}))

// Neutralize side-effecting modules that actions.ts imports.
vi.mock('@/lib/email', () => new Proxy({}, { get: () => async () => ({ success: true }) }) as any)
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

import {
  adminAdjustCredits, adminForceMatch, adminUpdateUser, adminSetFoundingMember,
  rescheduleMeeting, updateIntroStatus,
} from '@/app/actions'

const ADMIN = 'bizdev91@gmail.com'
beforeEach(() => { cfg.user = { id: 'me', email: 'member@x.com' }; cfg.rows = {}; adminWrites.length = 0 })

describe('admin-gated service-role writes reject a non-admin actor (no write attempted)', () => {
  it('adminAdjustCredits', async () => {
    expect(await adminAdjustCredits('victim', 999, 'x')).toMatchObject({ error: 'Not authorized' })
    expect(adminWrites).toHaveLength(0)
  })
  it('adminForceMatch', async () => {
    expect(await adminForceMatch('a', 'b')).toMatchObject({ error: 'Not authorized' })
    expect(adminWrites).toHaveLength(0)
  })
  it('adminUpdateUser', async () => {
    expect(await adminUpdateUser('victim', { tier: 'executive', account_status: 'active', credits: 999 } as any)).toMatchObject({ error: 'Not authorized' })
    expect(adminWrites).toHaveLength(0)
  })
  it('adminSetFoundingMember', async () => {
    expect(await adminSetFoundingMember('victim', true)).toMatchObject({ error: 'Not authorized' })
    expect(adminWrites).toHaveLength(0)
  })
})

describe('admin actor is allowed (positive control — a service-role write IS attempted)', () => {
  it('adminAdjustCredits as admin writes credits + a transaction', async () => {
    cfg.user = { id: 'admin', email: ADMIN }
    const r = await adminAdjustCredits('target', 5, 'grant')
    expect((r as any).success).toBe(true)
    expect(adminWrites.some((w) => w.table === 'credit_transactions')).toBe(true)
  })
})

describe('meeting reschedule requires participation (foreign meeting rejected, no write)', () => {
  it('a non-participant cannot reschedule someone else\'s meeting', async () => {
    cfg.rows.meetings = { requester_id: 'alice', recipient_id: 'bob' } // caller "me" is neither
    const fd = new FormData(); fd.set('date', '2026-09-01'); fd.set('time', '10:00')
    expect(await rescheduleMeeting('m1', fd)).toMatchObject({ error: 'Not authorized' })
    expect(adminWrites.filter((w) => w.table === 'meetings')).toHaveLength(0)
  })
  it('a participant CAN reschedule (positive control → meetings write attempted)', async () => {
    cfg.rows.meetings = { requester_id: 'me', recipient_id: 'bob' }
    const fd = new FormData(); fd.set('date', '2026-09-01'); fd.set('time', '10:00')
    const r = await rescheduleMeeting('m1', fd)
    expect((r as any).success).toBe(true)
    expect(adminWrites.some((w) => w.table === 'meetings' && w.op === 'update')).toBe(true)
  })
})

describe('updateIntroStatus accept requires being the target (foreign intro rejected, no write/RPC)', () => {
  it('accepting an intro the caller is not the target of → not found, no service-role write', async () => {
    // The authz fetch scopes to target_user_id = user.id; a non-target sees no row.
    cfg.rows.intro_requests = null
    expect(await updateIntroStatus('ir1', 'accepted')).toMatchObject({ error: 'Introduction not found.' })
    expect(adminWrites).toHaveLength(0)
  })
})
