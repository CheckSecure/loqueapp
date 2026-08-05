import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { listRoles, createRole } from '@/lib/profileRoles'

export const dynamic = 'force-dynamic'

/** GET — list the current member's additional roles (fail-open → []). */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const roles = await listRoles(createAdminClient(), user.id)
  return NextResponse.json({ roles })
}

/** POST — create an additional role for the current member. */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const result = await createRole(createAdminClient(), user.id, body)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ role: result.role })
}
