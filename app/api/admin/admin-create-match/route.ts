import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { createAdminIntroPair } from '@/lib/introRequests/createAdminIntroPair'

export async function POST(req: Request) {
  const { error, user } = await requireAdmin()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const userIdA = typeof body.userIdA === 'string' ? body.userIdA : ''
  const userIdB = typeof body.userIdB === 'string' ? body.userIdB : ''

  // Behavior-preserving: the reciprocal admin-intro logic now lives in
  // createAdminIntroPair (shared with the Concierge introduce flow). This route
  // maps the helper result to the exact responses it returned previously.
  const result = await createAdminIntroPair(userIdA, userIdB, { adminNotes: 'manual_create' })

  if (!result.ok) {
    const status = result.code === 'invalid_pair' ? 400 : result.code === 'insert_failed' ? 500 : 409
    const payload: any = { error: result.message }
    if (result.matchId) payload.matchId = result.matchId
    return NextResponse.json(payload, { status })
  }

  console.log('[admin/admin-create-match] intro proposed:', {
    by: user?.email,
    userIdA,
    userIdB,
    mode: result.mode,
    introIds: result.introRequests.map((i: any) => i.id),
  })

  return NextResponse.json({
    success: true,
    mode: result.mode,
    introRequests: result.introRequests,
  })
}
