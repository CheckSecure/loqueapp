// Onboarding wizard step model + the FAIL-CLOSED gate that decides whether the legacy first
// "Set your password" step is shown.
//
// The password step appears ONLY when a password is genuinely still required — a real legacy
// temporary-password account whose server-confirmed `password_reset_required` flag is still true
// AND whose password was not already set in a server-confirmed way. A member who set their password
// via the secure flow (flag cleared server-side), a fresh secure invitee (no profile row → no flag),
// or someone who just completed the onboarding password step (server-issued continuation cookie)
// starts at the profile step and NEVER sees a second password form.

import { validateLocation } from '@/lib/validation/location'

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

// ── Legacy /dashboard/onboarding wizard: which step to OPEN on ───────────────────────────────
//
// The wizard has two screens. Step 1 (OnboardingStep1) owns identity + physical location; step 2
// (OnboardingStep2) owns goals / introduction preferences / interests and holds the Complete
// Profile button. Only step 1 has a location input.
//
// The wizard used to open on the stored `onboarding_step` marker alone. That marker records how
// far the member got, NOT whether the data behind it satisfies completion — so a profile parked at
// step 2 whose step-1 data is incomplete opened straight onto step 2, which cannot collect any of
// it. Clicking Complete Profile then failed the server gate on a field the visible screen has no
// input for, and there was no way back: a dead end.
//
// That is exactly how a profile that reached step 2 BEFORE physical location became a completion
// requirement (migration 061 / the shared location authority) behaves today — it carries a title
// and company but no location, and the only screen that could supply one is the screen the marker
// skips.
//
// So the opening step is derived from the DATA, not just the marker: the member is only shown
// step 2 when step 1 actually holds everything POST /api/profile/complete will demand. This
// narrows the marker (it can send you back, never further forward), so it cannot skip a screen or
// let anyone past a check — a member whose step-1 data is already valid is unaffected.

/** The subset of a profile the wizard needs to decide its opening step. */
export interface WizardProfileFields {
  onboarding_step?: number | null
  title?: string | null
  company?: string | null
  location?: string | null
}

/** Step-1-owned fields, in the order they appear on that screen. */
export type Step1CompletionField = 'title' | 'company' | 'location'

/**
 * Which step-1-owned fields would make POST /api/profile/complete reject this profile.
 *
 * Deliberately mirrors that route's gate EXACTLY — trim + at least 2 visible characters for title
 * and company, and the shared physical-location authority for location — so the wizard can never
 * present the Complete Profile button for a profile the server is going to refuse. Pure and
 * null-safe; a profile with nothing filled in reports all three.
 */
export function missingStep1CompletionFields(
  profile: WizardProfileFields | null | undefined,
): Step1CompletionField[] {
  const missing: Step1CompletionField[] = []
  if ((profile?.title ?? '').trim().length < 2) missing.push('title')
  if ((profile?.company ?? '').trim().length < 2) missing.push('company')
  if (!validateLocation(profile?.location ?? null).ok) missing.push('location')
  return missing
}

/**
 * The step the wizard should OPEN on. Step 2 only when the marker says so AND step 1's data
 * actually satisfies the completion gate; otherwise step 1, where the missing fields live.
 * Never returns a step beyond the marker.
 */
export function resolveWizardStartStep(profile: WizardProfileFields | null | undefined): 1 | 2 {
  if (profile?.onboarding_step !== 2) return 1
  return missingStep1CompletionFields(profile).length === 0 ? 2 : 1
}
