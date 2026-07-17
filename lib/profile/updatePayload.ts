import { parseMultiSelectField } from '@/lib/profile/multiSelect'

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

export function buildProfileUpdate(formData: FormData): ProfileUpdateResult {
  const has = (k: string) => formData.has(k)
  const raw = (k: string) => formData.get(k) as string | null
  const trimmed = (k: string) => (raw(k) ?? '').trim()

  const payload: Record<string, unknown> = {}

  // --- Present-only free-text fields (explicit empty clears; omitted preserved) ---
  if (has('full_name')) payload.full_name = raw('full_name')
  if (has('title')) payload.title = raw('title')
  if (has('company')) payload.company = raw('company')
  if (has('bio')) payload.bio = raw('bio')
  if (has('meeting_format_preference')) payload.meeting_format_preference = raw('meeting_format_preference')
  if (has('geographic_scope')) payload.geographic_scope = raw('geographic_scope')
  if (has('current_status')) payload.current_status = trimmed('current_status') || null

  // --- Location precedence (present-only, never touches an omitted field) ---
  //   1. explicit `location` submitted  → write it (empty → null clears)
  //   2. else `city`/`state` submitted  → derive location from submitted values
  //   3. else                           → leave location untouched
  // city/state are each written only when submitted, independent of location.
  const hasLocation = has('location'), hasCity = has('city'), hasState = has('state')
  const cityVal = trimmed('city'), stateVal = trimmed('state'), locationVal = trimmed('location')
  if (hasCity) payload.city = cityVal || null
  if (hasState) payload.state = stateVal || null
  if (hasLocation) {
    payload.location = locationVal || null
  } else if (hasCity || hasState) {
    payload.location = cityVal && stateVal ? `${cityVal}, ${stateVal}` : cityVal || stateVal || null
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

  return { payload }
}
