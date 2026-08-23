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
  //
  // .select() IS LOAD-BEARING. Without it PostgREST reports no error when the filter matches ZERO
  // rows, so an invitee who has no profiles row yet received {success:true} while nothing was
  // written — the client then showed saved progress that did not exist. An invitee holding a
  // session with no profile is the NORMAL pre-onboarding state here (production: 118 auth users
  // with no profile), so this was not an edge case.
  const { data, error } = await createAdminClient()
    .from('profiles')
    .update({ onboarding_step: step })
    .eq('id', user.id)
    .select('id')

  if (error) {
    // Class only — the message can echo input.
    console.error(JSON.stringify({ event: 'onboarding_step_write_failed', code: error.code ?? 'unknown' }))
    return NextResponse.json({ error: 'Could not save your progress. Please try again.' }, { status: 500 })
  }

  // EXACTLY ONE ROW. Zero means there is nothing to write to; more than one would mean the filter
  // was not the primary key, which must fail closed rather than be reported as a save.
  if (data && data.length > 1) {
    console.error(JSON.stringify({ event: 'onboarding_step_multi_row', rows: data.length }))
    return NextResponse.json({ error: 'Could not save your progress. Please try again.' }, { status: 500 })
  }

  if (!data || data.length === 0) {
    // Truthful, and actionable by the client: there is nothing to write to yet.
    // Truthful AND actionable: the client calls /api/profile/initialize (which is bound to the
    // verified session and creates the incomplete row) and retries. Reporting success here was the
    // original defect; reporting failure without a remedy only made it honest.
    return NextResponse.json(
      { error: 'no_profile', initialize: '/api/profile/initialize',
        message: 'Your profile is still being set up. Your progress was not saved yet.' },
      { status: 409 },
    )
  }

  return NextResponse.json({ success: true })
}
