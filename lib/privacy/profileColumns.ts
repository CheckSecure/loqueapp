// Safe, member-facing profile column projection.
//
// When ONE member views ANOTHER member's profile, only these display columns may
// be returned. Never expose account-sensitive fields (email, stripe_customer_id,
// subscription/payment data, is_admin, trust_score, verification_metadata, legal/
// password fields, deactivation metadata, internal scores). Use this list instead
// of select('*') on every member-facing server read so the private columns can
// never drift back in.

/** Columns safe to return to another member for profile display. */
export const PUBLIC_PROFILE_COLUMNS = [
  'id',
  'full_name',
  'avatar_url',
  'title',
  'exact_job_title',
  'company',
  'company_id', // canonical FK — enables the (later) company-page link; not sensitive
  'role_type',
  'seniority',
  'location',
  'bio',
  'expertise',
  'interests',
  'purposes',
  'intro_preferences',
  'mentorship_role',
  'open_to_mentorship',
  'open_to_business_solutions',
  'current_focus_areas',
  'previous_roles',
  'account_status',
] as const

/** Comma-joined form for `.select(...)`. */
export const PUBLIC_PROFILE_SELECT = PUBLIC_PROFILE_COLUMNS.join(', ')

/** Slimmer projection for compact member lists (company page named members). */
export const PUBLIC_PROFILE_LIST_COLUMNS = [
  'id', 'full_name', 'company', 'title', 'exact_job_title', 'role_type', 'avatar_url', 'location', 'account_status',
] as const
export const PUBLIC_PROFILE_LIST_SELECT = PUBLIC_PROFILE_LIST_COLUMNS.join(', ')
