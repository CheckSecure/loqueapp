/**
 * A3 profile-read contracts. Two least-privilege paths replace direct authenticated SELECT on the base
 * public.profiles table (which is revoked in the A3 contract migration):
 *
 *  - PUBLIC_PROFILE_COLUMNS / public_profiles view — member-facing DISCOVERY reads. The `public_profiles`
 *    view (definer, discovery-scoped in SQL via can_discover_profile) exposes ONLY these safe columns and
 *    ONLY rows the viewer may discover. No email/phone/tier/billing/scores/moderation/private timestamps.
 *
 *  - get_my_profile() RPC — SELF reads. Returns the caller's OWN full row (auth.uid()-bound); used by
 *    edit/settings/onboarding/billing-display/middleware gates that need private self fields.
 *
 * Admin/matching/internal reads stay server-side via service_role (createAdminClient) and are unaffected.
 */

/** Exact safe column allowlist exposed by the public_profiles view (mirror of migration 057). NOTE:
 *  account_status is deliberately EXCLUDED — it is an internal account-control field; deactivation
 *  checks run server-side via service_role, never through this member-facing view. */
export const PUBLIC_PROFILE_COLUMNS = [
  'id', 'full_name', 'avatar_url', 'title', 'exact_job_title', 'company', 'company_id',
  'role_type', 'seniority', 'location', 'bio', 'expertise', 'interests', 'purposes',
  'intro_preferences', 'mentorship_role', 'open_to_mentorship',
  'open_to_business_solutions', 'current_focus_areas', 'previous_roles',
  // Andrel Connector: the BOOLEAN only. awarded_at and awarded_by are private and are deliberately
  // absent from the view, so no member-facing read can reach them (migration 082).
  'is_andrel_connector',
] as const

/** Comma-joined column list for a `.select(...)` on the public_profiles view. */
export const PUBLIC_PROFILE_SELECT = PUBLIC_PROFILE_COLUMNS.join(', ')

/** Fields that must NEVER be exposed through a member-facing profile read (used by tests + review). */
export const FORBIDDEN_PUBLIC_PROFILE_FIELDS = [
  'account_status', 'email', 'phone', 'account_status_reason', 'subscription_tier', 'current_period_end',
  'founding_member_expires_at', 'is_founding_member', 'stripe_customer_id', 'is_admin',
  'is_priority', 'boost_score', 'trust_score', 'verification_status', 'verification_metadata',
  'password_reset_required', 'email_verified', 'last_active_at', 'is_test_account',
  'referral_campaign_sent_at', 'launch_cohort',
] as const

/**
 * Fetch member-facing profile fields for a set of ids through the discovery-scoped public_profiles view.
 * Rows the caller may NOT discover are simply absent (enforced in SQL, not in app code). Works with a
 * user-scoped (authenticated) client — the view is granted to authenticated and needs no base SELECT.
 * Returns a Map keyed by id for easy join-back.
 */
export async function fetchPublicProfilesByIds(
  client: any,
  ids: Array<string | null | undefined>,
): Promise<Map<string, any>> {
  const uniq = Array.from(new Set(ids.filter((x): x is string => !!x)))
  if (uniq.length === 0) return new Map()
  const { data } = await client.from('public_profiles').select(PUBLIC_PROFILE_SELECT).in('id', uniq)
  const map = new Map<string, any>()
  for (const row of (data ?? []) as any[]) if (row?.id) map.set(row.id, row)
  return map
}

/** Read the caller's OWN full profile row via the self-only get_my_profile() RPC (auth.uid()-bound). */
export async function getMyProfile(client: any): Promise<any | null> {
  const { data, error } = await client.rpc('get_my_profile')
  if (error) return null
  return Array.isArray(data) ? (data[0] ?? null) : (data ?? null)
}
