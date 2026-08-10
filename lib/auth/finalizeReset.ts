// Stage 2 of the secure password reset, run SERVER-SIDE for a specific user id: clear the legacy
// `password_reset_required` flag and choose the destination. It never touches the password, so a
// finalization retry can never re-change it. Zero-row ambiguity is handled carefully — a zero-row
// UPDATE on a confirmed-existing profile is NOT treated as "no profile":
//   - profile SELECT returns null WITHOUT error → CONFIRMED no-profile invitee → onboarding;
//   - profile SELECT errors                     → ambiguous → error (safe retry);
//   - existing profile updated (row returned)   → destination by profile_complete;
//   - existing profile but UPDATE null/errors   → permission/race/ambiguous → error (safe retry).

export type FinalizeOutcome = 'onboarding' | 'introductions' | 'error'

export async function finalizeResetForUser(db: any, userId: string): Promise<FinalizeOutcome> {
  if (!userId) return 'error'

  const sel = await db.from('profiles').select('id, profile_complete').eq('id', userId).maybeSingle()
  if (sel?.error) return 'error'
  if (!sel?.data) return 'onboarding' // confirmed no-profile invitee

  const upd = await db.from('profiles')
    .update({ password_reset_required: false })
    .eq('id', userId)
    .select('id, profile_complete')
    .maybeSingle()
  if (upd?.error || !upd?.data) return 'error'
  return upd.data.profile_complete ? 'introductions' : 'onboarding'
}

export function destForOutcome(outcome: Exclude<FinalizeOutcome, 'error'>): string {
  return outcome === 'introductions' ? '/dashboard/introductions' : '/dashboard/onboarding'
}
