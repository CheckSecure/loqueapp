/**
 * passwordSetupCopy — decides whether the password screen is a member CREATING their
 * first password, an established member RECOVERING a forgotten one, or a genuine
 * LEGACY temporary-password account being forced to set a real one.
 *
 * WHY: a first-time invitee following their invitation link was shown "Set new
 * password" / "Confirm password reset" — recovery language for someone who has never
 * had a password. It reads as though their account already existed and something went
 * wrong, which is exactly the wrong first impression for an invite-only network.
 *
 * TRUST MODEL — this module decides COPY ONLY. It never authorizes anything.
 *   - The input is the caller's OWN profile, read SERVER-SIDE from the authenticated
 *     session (see app/api/auth/password-context/route.ts).
 *   - It must NEVER be fed sessionStorage, a URL `type` parameter, or any other
 *     client-supplied value. The recovery link's `type` (magiclink / recovery /
 *     invite) is attacker-editable text in a URL fragment: fine as a verifyOtp
 *     argument, worthless as an assertion about who the member is.
 *   - Token verification, the server-authorized `password_reset_required` clear, the
 *     continuation cookie, and the legacy gate are all untouched by this module. If the
 *     context lookup fails, callers keep `DEFAULT_MODE` — neutral copy that is true in
 *     all three cases — so a failure never asserts the wrong thing about the member.
 */

export type PasswordSetupMode =
  /** Genuine legacy temporary-password account: still flagged password_reset_required. */
  | 'legacy'
  /** First-time invitee: no profile yet, or a profile that has never completed onboarding. */
  | 'create'
  /** Established member who completed onboarding and is recovering a forgotten password. */
  | 'reset'

/**
 * What the SCREEN may show. 'unknown' is not a derived mode — it is the honest state
 * before (or instead of) a server answer.
 *
 * WHY IT EXISTS: the previous fallback was 'reset', which meant a first-time invitee saw
 * "Reset your password" render first and then flip to "Create your password" once the
 * context arrived — a visible flash of the exact wording this work set out to remove, and
 * the permanently-wrong wording if the lookup failed. 'unknown' renders copy that is true
 * in ALL three cases, so the first paint is never wrong and a failure simply stays neutral.
 */
export type PasswordSetupDisplayMode = PasswordSetupMode | 'unknown'

/** Neutral, always-true copy. Used before the server answers and whenever it cannot. */
export const DEFAULT_MODE: PasswordSetupDisplayMode = 'unknown'

/** The self-profile facts the decision needs. All server-read. */
export interface PasswordSetupFacts {
  /** null = confirmed no profile row (the expected pre-onboarding invitee state). */
  profile: {
    profile_complete?: boolean | null
    password_reset_required?: boolean | null
  } | null | undefined
}

/**
 * Decide the mode. Order matters:
 *   1. The legacy flag wins — such an account may also be "complete", and the app
 *      still forces it through a real password set. Calling that "Create" would be
 *      wrong (they have a password; it is a temporary one).
 *   2. No profile, or an incomplete one → this member has never finished signing up,
 *      so this is their FIRST password.
 *   3. Otherwise → an established member recovering access.
 */
export function resolvePasswordSetupMode(facts: PasswordSetupFacts): PasswordSetupMode {
  const p = facts.profile
  if (p?.password_reset_required === true) return 'legacy'
  if (!p || p.profile_complete !== true) return 'create'
  return 'reset'
}

export interface PasswordSetupCopy {
  /** Main heading on the password form. */
  heading: string
  /** Supporting line beside the form. */
  subheading: string
  /** Heading on the intermediate confirm step (/auth/recover). */
  confirmHeading: string
  /** Label on the confirm button. */
  confirmCta: string
  /** Submit button label on the password form. */
  submitLabel: string
}

const COPY: Record<PasswordSetupDisplayMode, PasswordSetupCopy> = {
  // Accurate whether this member is creating a first password, replacing a temporary one,
  // or recovering a forgotten one — so it can be shown before the mode is known.
  unknown: {
    heading: 'Choose your password',
    subheading: 'Choose a password for your account.',
    confirmHeading: 'Confirm it’s you',
    confirmCta: 'Continue',
    submitLabel: 'Save password',
  },
  create: {
    heading: 'Create your password',
    subheading: 'Choose a password to finish setting up your account.',
    confirmHeading: 'Set up your account',
    confirmCta: 'Create password',
    submitLabel: 'Create password',
  },
  legacy: {
    heading: 'Set your password',
    subheading: 'Choose a permanent password to replace your temporary one.',
    confirmHeading: 'Set your password',
    confirmCta: 'Continue',
    submitLabel: 'Set password',
  },
  reset: {
    heading: 'Reset your password',
    subheading: 'Choose a new password.',
    confirmHeading: 'Confirm password reset',
    confirmCta: 'Reset password',
    submitLabel: 'Reset password',
  },
}

/** Never throws for an unexpected value — an unknown string degrades to neutral copy. */
export function passwordSetupCopy(mode: PasswordSetupDisplayMode): PasswordSetupCopy {
  return COPY[mode] ?? COPY.unknown
}

/** True only for the three server-derived modes; anything else is display-only 'unknown'. */
export function isPasswordSetupMode(v: unknown): v is PasswordSetupMode {
  return v === 'legacy' || v === 'create' || v === 'reset'
}
