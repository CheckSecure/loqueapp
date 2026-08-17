// Onboarding wizard step model + the FAIL-CLOSED gate that decides whether the legacy first
// "Set your password" step is shown.
//
// The password step appears ONLY when a password is genuinely still required — a real legacy
// temporary-password account whose server-confirmed `password_reset_required` flag is still true
// AND whose password was not already set in a server-confirmed way. A member who set their password
// via the secure flow (flag cleared server-side), a fresh secure invitee (no profile row → no flag),
// or someone who just completed the onboarding password step (server-issued continuation cookie)
// starts at the profile step and NEVER sees a second password form.

export type OnboardingStep = 'password' | 'profile' | 'preferences'

export function onboardingStepList(needsPassword: boolean): OnboardingStep[] {
  return needsPassword ? ['password', 'profile', 'preferences'] : ['profile', 'preferences']
}

export function initialOnboardingStep(needsPassword: boolean): OnboardingStep {
  return needsPassword ? 'password' : 'profile'
}

export interface OnboardingProfileLite {
  profile_complete?: boolean | null
  password_reset_required?: boolean | null
  full_name?: string | null
}

/**
 * get_my_profile() (the A3 self-read RPC) RETURNS TABLE → PostgREST returns a SETOF, i.e. an ARRAY of
 * 0 or 1 self row. Extract the single row, treating ZERO rows as a CONFIRMED-absent profile (null) —
 * the expected pre-onboarding invitee state — NOT an error. This is the explicit RPC result contract:
 * callers MUST NOT use .single() on the RPC (which turns "no rows" into a PGRST116 error and would
 * misclassify a confirmed no-profile invitee as a load failure). Never throws.
 */
export function selfProfileFromRpc<T>(rows: T[] | T | null | undefined): T | null {
  if (Array.isArray(rows)) return rows[0] ?? null
  return (rows as T | null | undefined) ?? null
}

export type OnboardingGate =
  | { kind: 'error' }                              // lookup failed/ambiguous → FAIL CLOSED
  | { kind: 'complete' }                           // profile already complete → dashboard
  | { kind: 'onboard'; needsPassword: boolean }    // proceed to onboarding

/**
 * Decide the onboarding gate from the profile read. FAILS CLOSED:
 *  - a lookup error (DB/permission/ambiguous) → 'error' (never rendered as password-complete);
 *  - profile_complete → 'complete';
 *  - confirmed no profile (null, no error) → onboard, needsPassword=false;
 *  - confirmed profile → onboard, needsPassword = (password_reset_required === true) AND the
 *    password was NOT already server-confirmed set (`passwordAlreadySet`, e.g. a valid continuation
 *    cookie after the onboarding password step) — so a refresh cannot re-show the password form.
 */
export function resolveOnboardingGate(args: {
  profile: OnboardingProfileLite | null | undefined
  error: unknown
  passwordAlreadySet?: boolean
}): OnboardingGate {
  if (args.error) return { kind: 'error' }
  const p = args.profile
  if (p?.profile_complete) return { kind: 'complete' }
  const flagged = p?.password_reset_required === true
  return { kind: 'onboard', needsPassword: flagged && !args.passwordAlreadySet }
}
