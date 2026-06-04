import { NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const expected = process.env.ANDREL_DEMO_PASSWORD
  if (!expected) {
    return NextResponse.json({ ok: false }, { status: 500 })
  }

  let payload: { password?: unknown } = {}
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const provided = typeof payload.password === 'string' ? payload.password : ''

  // SHA-256 normalizes both inputs to a fixed 32-byte buffer so timingSafeEqual
  // never short-circuits on length differences and the comparison is constant-time.
  const providedHash = createHash('sha256').update(provided).digest()
  const expectedHash = createHash('sha256').update(expected).digest()

  if (!timingSafeEqual(providedHash, expectedHash)) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }
  return NextResponse.json({ ok: true })
}
