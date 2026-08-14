import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'
import { sendMessageCore } from '@/lib/messages/sendMessageCore'
import { NextResponse } from 'next/server'

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * POST /api/messages/send — same-origin, authenticated, strict JSON. All authorization + the message
 * INSERT run server-side (service_role) inside sendMessageCore, which rejects inactive senders, removed/
 * closed matches, and blocked pairs with a single generic 403 and NO side effects. Browser INSERT on
 * messages is revoked (migration 055), so this route is the only member send path for this UI.
 */
export async function POST(request: Request) {
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })

  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 400, headers: NO_STORE })
  }
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE }) }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400, headers: NO_STORE })
  }
  if (Object.keys(body).some((k) => k !== 'conversationId' && k !== 'content')) {
    return NextResponse.json({ error: 'Only { conversationId, content } are accepted' }, { status: 400, headers: NO_STORE })
  }
  if (typeof body.conversationId !== 'string' || typeof body.content !== 'string') {
    return NextResponse.json({ error: 'conversationId and content must be strings' }, { status: 400, headers: NO_STORE })
  }

  const admin = createAdminClient()
  const result = await sendMessageCore(admin, { senderId: user.id, conversationId: body.conversationId, content: body.content })
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE })
  }
  return NextResponse.json({ success: true, message: result.message, isFirstMessage: result.isFirstMessage }, { headers: NO_STORE })
}
