import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isMissingColumnError } from '@/lib/db/isMissingColumn'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Persist the member's dismissal of the Introductions "Improve your recommendations"
 * prompt. UI preference only — writes profiles.intro_profile_prompt_dismissed_at for
 * the authenticated member and nothing else. Never touches matching, eligibility, or
 * profile data. Fails open if migration 039 isn't applied yet (the card still hides
 * for the session client-side; it just won't persist across visits).
 */
export async function POST() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error } = await supabase
    .from('profiles')
    .update({ intro_profile_prompt_dismissed_at: new Date().toISOString() })
    .eq('id', user.id)

  if (error) {
    if (isMissingColumnError(error)) {
      // Migration 039 not applied — treat as a best-effort no-op (fail open).
      return NextResponse.json({ ok: true, persisted: false })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, persisted: true })
}
