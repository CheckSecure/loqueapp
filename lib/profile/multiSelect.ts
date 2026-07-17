/**
 * Shared serializer/normalizer for the profile multi-select fields that are
 * submitted as a comma-joined string in FormData (goals = `purposes`, personal
 * `interests`, `intro_preferences`, …). One parse + one serialize used by every
 * onboarding AND profile-edit path, so these fields can never drift or be
 * silently dropped again.
 *
 * Client:  serializeMultiSelectField(array)  → "a,b,c"   (formData value)
 * Server:  parseMultiSelectField(formValue)  → ["a","b","c"] (persisted array)
 */

/** Server: FormData value (comma string) → clean string[] for persistence. */
export function parseMultiSelectField(
  raw: FormDataEntryValue | string | null | undefined,
): string[] {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Client: string[] → comma string for a FormData field. */
export function serializeMultiSelectField(values: readonly string[] | null | undefined): string {
  return (values ?? []).join(',')
}
