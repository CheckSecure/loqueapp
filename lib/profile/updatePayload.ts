import { parseMultiSelectField } from '@/lib/profile/multiSelect'
import { checkRoleEmploymentCompatibility } from '@/lib/profile/roleEmploymentCompatibility'
import { validateFullName } from '@/lib/validation/fullName'
import { resolveLocationUpdate } from '@/lib/validation/location'

/**
 * Builds the /api/profile/update write payload from submitted FormData as a
 * TRUE PARTIAL UPDATE: a field is written ONLY when the form submitted it, so a
 * partial form can never erase fields it didn't include. An explicitly submitted
 * (possibly empty) value IS written — that is the intended "clear" behavior.
 *
 * Returns `{ error }` for a validation failure (400) or `{ payload }` to write.
 * Kept pure (FormData in → object out) so every present-only / location rule is
 * unit-testable without Supabase.
 */
export type ProfileUpdateResult = { error: string } | { payload: Record<string, unknown> }

/**
 * Caller-supplied context the pure builder cannot read for itself.
 * `profileComplete` is the CURRENT stored value for the row being updated; it
 * decides whether a submitted-but-blank location is an allowed draft state or an
 * illegal clear of a complete profile. Defaults to false so an omitted context is
 * the permissive draft case, never a silent bypass of a real completed profile —
 * routes must pass the real value.
 */
export interface ProfileUpdateContext {
  profileComplete?: boolean
  /**
   * The row's CURRENT role_type / current_status / company. Required only to evaluate the
   * role↔employment compatibility rule, which is about a COMBINATION: a partial update may submit
   * a new role without a company, and the contradiction only exists once the submitted fields are
   * merged over what is already stored. The caller supplies this exactly when the request touches
   * one of the three (same pattern the location rule already uses).
   */
  current?: { role_type?: string | null; current_status?: string | null; company?: string | null }
}

export function buildProfileUpdate(
  formData: FormData,
  ctx: ProfileUpdateContext = {},
): ProfileUpdateResult {
  const has = (k: string) => formData.has(k)
  const raw = (k: string) => formData.get(k) as string | null
  const trimmed = (k: string) => (raw(k) ?? '').trim()

  const payload: Record<string, unknown> = {}

  // --- Present-only free-text fields (explicit empty clears; omitted preserved) ---
  // full_name is the one exception to "explicit empty clears": when submitted it
  // must be a real first + last name (shared authority), so a one-word or blank
  // value is rejected rather than written. Normalized value persisted.
  if (has('full_name')) {
    const nameCheck = validateFullName(raw('full_name'))
    if (!nameCheck.ok) return { error: nameCheck.error }
    payload.full_name = nameCheck.value
  }
  if (has('title')) payload.title = raw('title')
  if (has('company')) payload.company = raw('company')
  if (has('bio')) payload.bio = raw('bio')
  if (has('meeting_format_preference')) payload.meeting_format_preference = raw('meeting_format_preference')
  if (has('geographic_scope')) payload.geographic_scope = raw('geographic_scope')
  if (has('current_status')) payload.current_status = trimmed('current_status') || null

  // --- Location precedence (present-only, never touches an omitted field) ---
  //   1. explicit `location` submitted  → write it
  //   2. else `city`/`state` submitted  → derive location from submitted values
  //   3. else                           → leave location untouched
  // city/state are each written only when submitted, independent of location.
  //
  // Whatever value this produces is then run through the shared physical-location
  // authority (lib/validation/location): a placeholder such as "Remote" or "N/A" is
  // rejected outright, and a blank is allowed ONLY while the profile is still a
  // draft — a complete profile can never have its location cleared through an edit.
  // Normalization is trim + whitespace-collapse only; nothing is geocoded.
  const hasLocation = has('location'), hasCity = has('city'), hasState = has('state')
  const cityVal = trimmed('city'), stateVal = trimmed('state'), locationVal = trimmed('location')
  if (hasCity) payload.city = cityVal || null
  if (hasState) payload.state = stateVal || null
  if (hasLocation || hasCity || hasState) {
    const submitted = hasLocation
      ? locationVal
      : cityVal && stateVal ? `${cityVal}, ${stateVal}` : cityVal || stateVal || ''
    const resolved = resolveLocationUpdate(submitted, { profileComplete: ctx.profileComplete === true })
    if (!resolved.ok) return { error: resolved.error }
    payload.location = resolved.value
  }

  // --- Present-only multi-selects (shared normalizer) ---
  if (has('intro_preferences')) payload.intro_preferences = parseMultiSelectField(raw('intro_preferences'))
  if (has('purposes')) payload.purposes = parseMultiSelectField(raw('purposes'))
  if (has('interests')) payload.interests = parseMultiSelectField(raw('interests'))

  // --- Present-only fields that stay non-empty when submitted (matcher inputs) ---
  if (has('role_type')) {
    const v = trimmed('role_type')
    if (!v) return { error: 'Please select your professional role' }
    payload.role_type = v
  }
  if (has('seniority')) {
    const v = trimmed('seniority')
    if (!v) return { error: 'Please select your seniority level' }
    payload.seniority = v
  }
  if (has('expertise')) {
    const v = parseMultiSelectField(raw('expertise'))
    if (v.length === 0) return { error: 'Please select at least one area of expertise' }
    payload.expertise = v
  }
  if (has('exact_job_title')) {
    payload.exact_job_title = trimmed('exact_job_title') || null
  }
  if (has('open_to_business_solutions')) {
    payload.open_to_business_solutions = raw('open_to_business_solutions') === 'true'
  }

  // --- Present-only previous_roles (parsed/capped) ---
  if (has('previous_roles')) {
    let parsed: Array<Record<string, unknown>> = []
    try {
      const j = JSON.parse(raw('previous_roles') || '')
      if (Array.isArray(j)) {
        parsed = j
          .filter((r: any) => r.company?.trim() && r.title?.trim())
          .slice(0, 5)
          .map((r: any) => ({
            company: r.company.trim(),
            title: r.title.trim(),
            start_date: r.start_date?.trim() || null,
            end_date: r.end_date?.trim() || null,
          }))
      }
    } catch { /* malformed JSON — ignore */ }
    payload.previous_roles = parsed
  }

  // --- ROLE ↔ EMPLOYMENT COMPATIBILITY (rejects; never rewrites) ---------------------------
  // Evaluated on the EFFECTIVE row: submitted values merged over what is stored, because the
  // contradiction is a property of the combination, not of any one field. When the caller did not
  // supply `current` (a request touching none of the three) there is nothing new to check.
  if (ctx.current !== undefined) {
    const effective = {
      role_type: 'role_type' in payload ? (payload.role_type as string | null) : ctx.current.role_type,
      current_status: 'current_status' in payload ? (payload.current_status as string | null) : ctx.current.current_status,
      company: 'company' in payload ? (payload.company as string | null) : ctx.current.company,
    }
    const verdict = checkRoleEmploymentCompatibility(effective)
    // The member's selected role is returned untouched: we refuse the write and say which of the
    // two things to change. Silently rewriting the role would assert an employment relationship
    // they never claimed.
    if (!verdict.ok) return { error: verdict.message }
  }

  return { payload }
}
