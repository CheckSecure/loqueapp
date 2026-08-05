import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { reorderRoles } from '@/lib/profileRoles'

export const dynamic = 'force-dynamic'

/** POST { orderedIds: string[] } — reorder the current member's roles. */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const orderedIds: string[] = Array.isArray(body?.orderedIds) ? body.orderedIds.filter((x: unknown) => typeof x === 'string') : []
  const result = await reorderRoles(createAdminClient(), user.id, orderedIds)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ success: true })
}
