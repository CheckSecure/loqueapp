import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { canTransition, isBlockedTransition, WAITLIST_TRANSITIONS } from '@/lib/referrals/statusTransitions'

// ── Route behavioral tests (mocked Supabase — no real DB, no email) ────────────
let serverClient: any
let adminClient: any
vi.mock('@/lib/supabase/server', () => ({ createClient: () => serverClient }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminClient }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

import { POST } from '@/app/api/admin/waitlist/reinstate/route'

const ADMIN = { email: 'bizdev91@gmail.com', id: 'admin-1' }
const UUID = '11111111-1111-1111-1111-111111111111'
const req = (body: any) => new Request('https://x.test/api/admin/waitlist/reinstate', { method: 'POST', body: JSON.stringify(body) })
const authAs = (user: any) => ({ auth: { getUser: async () => ({ data: { user } }) } })

/** Fake service-role client: one `waitlist` select (read) + one guarded update().select(). */
function makeAdmin({ row, updateRows, updateError }: { row: any; updateRows?: any[]; updateError?: any }) {
  const cap: any = { updateVals: null, updateEqs: {} }
  return {
    _cap: cap,
    from() {
      let mode: 'read' | 'update' = 'read'
      const b: any = {
        select() { return b },
        update(vals: any) { mode = 'update'; cap.updateVals = vals; return b },
        eq(c: string, v: any) { if (mode === 'update') cap.updateEqs[c] = v; return b },
        maybeSingle() { return Promise.resolve({ data: row, error: null }) },
        then(resolve: any, reject: any) {
          const data = updateError ? null
            : updateRows !== undefined ? updateRows
            : (cap.updateEqs.status === 'declined' && row?.status === 'declined' ? [{ id: row.id, status: 'invited' }] : [])
          return Promise.resolve({ data, error: updateError ?? null }).then(resolve, reject)
        },
      }
      return b
    },
  }
}

describe('POST /api/admin/waitlist/reinstate — admin-only, guarded declined → invited', () => {
  it('rejects a non-admin caller (401) and never mutates', async () => {
    serverClient = authAs({ email: 'someone@else.com', id: 'u' })
    adminClient = makeAdmin({ row: { id: UUID, status: 'declined' } })
    const res = await POST(req({ entryId: UUID }))
    expect(res.status).toBe(401)
    expect(adminClient._cap.updateVals).toBeNull()
  })
  it('rejects an unauthenticated caller (401)', async () => {
    serverClient = authAs(null)
    adminClient = makeAdmin({ row: null })
    expect((await POST(req({ entryId: UUID }))).status).toBe(401)
  })
  it('rejects an EMAIL as the target (400)', async () => {
    serverClient = authAs(ADMIN)
    adminClient = makeAdmin({ row: null })
    expect((await POST(req({ entryId: 'person@example.com' }))).status).toBe(400)
    expect(adminClient._cap.updateVals).toBeNull()
  })
  it('rejects a malformed id (400)', async () => {
    serverClient = authAs(ADMIN)
    adminClient = makeAdmin({ row: null })
    expect((await POST(req({ entryId: 'not-a-uuid' }))).status).toBe(400)
    expect((await POST(req({}))).status).toBe(400)
  })
  it('404 when the row does not exist', async () => {
    serverClient = authAs(ADMIN)
    adminClient = makeAdmin({ row: null })
    expect((await POST(req({ entryId: UUID }))).status).toBe(404)
  })
  it('409 and NO update when the row is not declined (requires current status = declined)', async () => {
    serverClient = authAs(ADMIN)
    adminClient = makeAdmin({ row: { id: UUID, status: 'invited' } })
    const res = await POST(req({ entryId: UUID }))
    expect(res.status).toBe(409)
    expect(adminClient._cap.updateVals).toBeNull()
  })
  it('reinstates declined → invited: guarded on (id + status=declined), only status flips, no invited_at', async () => {
    serverClient = authAs(ADMIN)
    adminClient = makeAdmin({ row: { id: UUID, status: 'declined' } })
    const res = await POST(req({ entryId: UUID }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, success: true, state: 'invited' })
    expect(adminClient._cap.updateVals.status).toBe('invited')        // exactly one status change
    expect(adminClient._cap.updateEqs).toMatchObject({ id: UUID, status: 'declined' }) // atomic guard
    expect(adminClient._cap.updateVals).not.toHaveProperty('invited_at') // never re-arms reminder cron
  })
  it('neutral conflict (409) when the row is no longer declined (0 rows updated) → UI refreshes', async () => {
    serverClient = authAs(ADMIN)
    adminClient = makeAdmin({ row: { id: UUID, status: 'declined' }, updateRows: [] })
    const res = await POST(req({ entryId: UUID }))
    expect(res.status).toBe(409)
    expect((await res.json()).conflict).toBe(true)
  })
})

describe('waitlist transition matrix — reinstate added, everything else unchanged', () => {
  it('declined → invited is now allowed (reinstate)', () => {
    expect(canTransition('declined', 'invited')).toBe(true)
    expect(isBlockedTransition('declined', 'invited')).toBe(false)
  })
  it('declined → anything else stays blocked', () => {
    for (const to of ['approved', 'contacted', 'declined', 'revoked']) {
      expect(isBlockedTransition('declined', to)).toBe(true)
    }
  })
  it('existing transitions are unchanged', () => {
    expect(isBlockedTransition('invited', 'declined')).toBe(true) // can't decline an invited row
    expect(WAITLIST_TRANSITIONS.revoked).toEqual([])              // revoked terminal
    expect(canTransition('pending', 'approved')).toBe(true)
    expect(canTransition('pending', 'invited')).toBe(false)
    expect(canTransition('approved', 'invited')).toBe(true)
  })
})

describe('reinstate route sends NO email and does NOT provision (structural)', () => {
  const route = readFileSync('app/api/admin/waitlist/reinstate/route.ts', 'utf8')
  it('imports/calls no email, provisioning, or password-reset helper', () => {
    expect(route).not.toMatch(/from '@\/lib\/email'/)
    expect(route).not.toMatch(/resend\.emails|\.emails\.send/)
    expect(route).not.toMatch(/inviteUserByEmail|generateLink|resetPasswordForEmail|admin\.createUser/)
  })
  it('does not create/modify auth users, profiles, or referrals — only waitlist.status', () => {
    expect(route).not.toMatch(/auth\.admin\./)
    expect(route).not.toMatch(/\.from\('profiles'\)/)
    expect(route).not.toMatch(/\.from\('referrals'\)/)
    expect(route).not.toMatch(/update\(\{[^}]*invited_at/) // never sets invited_at
  })
  it('admin auth is server-side; targets by immutable id (never email); guarded atomic update', () => {
    expect(route).toContain('user.email !== ADMIN_EMAIL')
    expect(route).toContain('UUID_RE.test(entryId)')
    expect(route).toMatch(/\.eq\('id', entryId\)[\s\S]{0,80}\.eq\('status', 'declined'\)/)
  })
})

describe('Reinstate UI — declined tab only, confirm required, no-email copy (structural)', () => {
  const client = readFileSync('components/AdminWaitlistClient.tsx', 'utf8')
  it('the Reinstate button renders ONLY in the declined tab', () => {
    expect(client).toMatch(/activeTab === 'declined' &&[\s\S]{0,400}openReinstate/)
    expect(client).not.toMatch(/activeTab === 'pending' &&[\s\S]{0,400}openReinstate/)
    expect(client).not.toMatch(/activeTab === 'invited' &&[\s\S]{0,400}openReinstate/)
    expect(client).not.toMatch(/activeTab === 'approved' &&[\s\S]{0,400}openReinstate/)
  })
  it('requires a confirmation dialog with the exact copy + no-email note', () => {
    expect(client).toContain('Reinstate this person and move them back to Invited?')
    expect(client).toContain('This will not send a new invitation email.')
  })
  it('posts the immutable row id to the reinstate route (never email) + disables while in flight', () => {
    expect(client).toContain("fetch('/api/admin/waitlist/reinstate'")
    expect(client).toContain('entryId: reinstateEntry.id')
    expect(client).toContain('Reinstating…')
    expect(client).toMatch(/disabled=\{reinstating\}/)
  })
  it('on success shows the no-email confirmation and refreshes; on failure a neutral retry message', () => {
    expect(client).toContain('Reinstated. No invitation email was sent.')
    expect(client).toMatch(/doReinstate = async[\s\S]{0,700}router\.refresh\(\)/)
    expect(client).toContain('Unable to reinstate this person. Refresh and try again.')
  })
})
