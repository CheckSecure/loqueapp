import { describe, it, expect, vi } from 'vitest'

// The route resolves the authenticated user + coarse-label RPC through the server client.
let fakeClient: any
vi.mock('@/lib/supabase/server', () => ({ createClient: () => fakeClient }))

import { GET } from '@/app/api/presence/label/route'

const req = (ids: string) => new Request('https://x.test/api/presence/label?ids=' + ids)

describe('GET /api/presence/label — coarse labels only, gated + fail-silent', () => {
  it('returns the coarse label for a discoverable member and NO raw timestamp', async () => {
    fakeClient = {
      auth: { getUser: async () => ({ data: { user: { id: 'viewer' } } }) },
      rpc: async () => ({ data: [{ member_id: 'B', label: 'Online now' }], error: null }),
    }
    const res = await GET(req('B'))
    const json = await res.json()
    expect(json).toEqual({ labels: { B: 'Online now' } })
    expect(JSON.stringify(json)).not.toMatch(/last_active|\d{4}-\d{2}-\d{2}T\d{2}:/) // never a timestamp
  })

  it('an opted-out / undiscoverable member is simply absent (badge disappears)', async () => {
    fakeClient = {
      auth: { getUser: async () => ({ data: { user: { id: 'viewer' } } }) },
      rpc: async () => ({ data: [], error: null }), // RPC returned no row for B
    }
    expect(await (await GET(req('B'))).json()).toEqual({ labels: {} })
  })

  it('unauthenticated → empty map (never calls the RPC)', async () => {
    let called = false
    fakeClient = {
      auth: { getUser: async () => ({ data: { user: null } }) },
      rpc: async () => { called = true; return { data: [], error: null } },
    }
    expect(await (await GET(req('B'))).json()).toEqual({ labels: {} })
    expect(called).toBe(false)
  })

  it('empty ids → empty map, no RPC call', async () => {
    let called = false
    fakeClient = {
      auth: { getUser: async () => ({ data: { user: { id: 'v' } } }) },
      rpc: async () => { called = true; return { data: [], error: null } },
    }
    expect(await (await GET(req(''))).json()).toEqual({ labels: {} })
    expect(called).toBe(false)
  })

  it('an RPC error fails silently to an empty map (does not throw / break the modal)', async () => {
    fakeClient = {
      auth: { getUser: async () => ({ data: { user: { id: 'v' } } }) },
      rpc: async () => ({ data: null, error: { code: '42501', message: 'permission denied' } }),
    }
    expect(await (await GET(req('B'))).json()).toEqual({ labels: {} })
  })

  it('caps the number of ids handed to the RPC at 50 (no unbounded fan-out)', async () => {
    let received: string[] = []
    fakeClient = {
      auth: { getUser: async () => ({ data: { user: { id: 'v' } } }) },
      rpc: async (_fn: string, args: any) => { received = args.target_ids; return { data: [], error: null } },
    }
    await GET(req(Array.from({ length: 120 }, (_, i) => 'id' + i).join(',')))
    expect(received.length).toBe(50)
  })
})
