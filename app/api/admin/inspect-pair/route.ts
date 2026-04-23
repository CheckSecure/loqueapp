import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { inspectPair } from '@/lib/admin/inspectPair'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const { error, user } = await requireAdmin()
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const inputA = typeof body.userA === 'string' ? body.userA : ''
  const inputB = typeof body.userB === 'string' ? body.userB : ''

  if (!inputA || !inputB) {
    return NextResponse.json({ error: 'Both userA and userB are required (email or UUID)' }, { status: 400 })
  }

  try {
    const result = await inspectPair(inputA, inputB)
    console.log('[admin/inspect-pair]', { by: user?.email, a: inputA, b: inputB, matched: !!result.userA && !!result.userB })
    return NextResponse.json(result)
  } catch (e: any) {
    console.error('[admin/inspect-pair] error:', e)
    return NextResponse.json({ error: e?.message || 'Inspection failed' }, { status: 500 })
  }
}
