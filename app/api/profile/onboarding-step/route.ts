import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'

export async function POST(req: NextRequest) {
  const crossOrigin = assertSameOrigin(req)
  if (crossOrigin) return crossOrigin

  const { step } = await req.json().catch(() => ({}))
  // Validate: onboarding_step is a small non-negative integer, not arbitrary client data.
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 0 || step > 10) {
    return NextResponse.json({ error: 'Invalid step' }, { status: 400 })
  }

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // service_role write, scoped to the caller's own row (browser UPDATE on profiles revoked, migration 055).
  const { error } = await createAdminClient()
    .from('profiles')
    .update({ onboarding_step: step })
    .eq('id', user.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
