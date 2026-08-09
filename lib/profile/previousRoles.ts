// Authoritative rule for a member's "previous roles" (the profiles.previous_roles JSON).
//
// A previous role is REAL career history ONLY when it has BOTH a non-blank company and a
// non-blank title. Blank/partial rows — e.g. an unsaved "Add role" row, or a stray empty
// entry left in the JSON — are NOT career history and must never render as a saved entry:
// their input placeholders ("General Counsel", "Acme Corp") would otherwise read as fake
// data like "Counsel at Acme". This single helper is shared by the editor (load + save) and
// every read-only surface (public profile, admin) so they agree EXACTLY. Pure + unit-tested.

export interface PreviousRole {
  company: string
  title: string
  start_date: string
  end_date: string
}

export function usablePreviousRoles(input: unknown): PreviousRole[] {
  if (!Array.isArray(input)) return []
  const out: PreviousRole[] = []
  for (const r of input) {
    const company = String((r as any)?.company ?? '').trim()
    const title = String((r as any)?.title ?? '').trim()
    if (!company || !title) continue // blank/partial → not career history
    out.push({
      company,
      title,
      start_date: String((r as any)?.start_date ?? '').trim(),
      end_date: String((r as any)?.end_date ?? '').trim(),
    })
  }
  return out
}
