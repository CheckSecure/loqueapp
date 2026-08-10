// Pure decision for where an authenticated /dashboard visitor should be sent, given their
// profile state. Extracted from middleware so the routing rules are unit-testable.
//
// Rules, in order:
//   1. LEGACY temporary-password enforcement: a profile still flagged `password_reset_required`
//      MUST set a real password before using the app. We keep this gate — the pre-secure-invitation
//      cohort may still hold temp passwords, and the flag cannot be assumed vestigial. The target
//      (/dashboard/reset-password) both accepts a new password AND clears the flag, and every path
//      that sets a password (the secure /auth/reset-password flow, and completeOnboarding) clears
//      the flag too — so this enforces without ever looping a user who has actually set a password.
//   2. Onboarding: NO profile row (a mid-onboarding invitee — the only way to hold a session
//      without a profile, since accounts are created solely by admin invite) OR a verified-but-
//      incomplete profile → onboarding.
//   3. Otherwise → no redirect.

export interface DashboardProfileState {
  password_reset_required?: boolean | null
  email_verified?: boolean | null
  profile_complete?: boolean | null
}

export function dashboardRedirect(profile: DashboardProfileState | null | undefined, pathname: string): string | null {
  // 1) Legacy temp-password gate. A no-profile visitor has no flag, so this only fires for an
  //    existing profile that is still flagged — genuine legacy accounts, or a not-yet-cleared one.
  if (profile?.password_reset_required) {
    return pathname.startsWith('/dashboard/reset-password') ? null : '/dashboard/reset-password'
  }
  // 2) Onboarding (flag is false/absent here).
  const needsOnboarding = !profile || (!!profile.email_verified && !profile.profile_complete)
  if (needsOnboarding && !pathname.startsWith('/dashboard/onboarding')) {
    return '/dashboard/onboarding'
  }
  return null
}
