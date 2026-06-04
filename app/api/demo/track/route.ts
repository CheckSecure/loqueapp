import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const runtime = 'nodejs'

const ALLOWED_EVENTS = new Set(['page_view', 'video_start', 'video_complete'])
const REF_CODE_PATTERN = /[^A-Za-z0-9_-]/g

function sanitizeRefCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const cleaned = input.replace(REF_CODE_PATTERN, '').slice(0, 64)
  return cleaned.length > 0 ? cleaned : null
}

export async function POST(request: Request) {
  let payload: { event_type?: unknown; session_id?: unknown; ref_code?: unknown } = {}
  try {
    payload = await request.json()
  } catch {
    return new NextResponse(null, { status: 400 })
  }

  const eventType = typeof payload.event_type === 'string' ? payload.event_type : ''
  if (!ALLOWED_EVENTS.has(eventType)) {
    return new NextResponse(null, { status: 400 })
  }

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
  if (sessionId.length === 0 || sessionId.length > 64) {
    return new NextResponse(null, { status: 400 })
  }

  const refCode = sanitizeRefCode(payload.ref_code)

  const rawUserAgent = request.headers.get('user-agent')
  const userAgent = rawUserAgent ? rawUserAgent.slice(0, 512) : null

  try {
    const supabase = createAdminClient()
    const { error } = await supabase.from('demo_views').insert({
      event_type: eventType,
      session_id: sessionId,
      ref_code: refCode,
      user_agent: userAgent,
    })
    if (error) {
      console.error('[demo-track] insert failed:', error.code, error.message)
    }
  } catch (err) {
    console.error('[demo-track] insert threw:', err instanceof Error ? err.message : 'unknown')
  }

  return new NextResponse(null, { status: 204 })
}

export function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } })
}
