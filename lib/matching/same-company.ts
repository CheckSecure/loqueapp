/**
 * Same-company detection for matching/recommendation filters.
 *
 * V1 scope:
 *   - lowercase + trim
 *   - strip common corporate suffixes
 *   - empty/null on either side → not same-company (permissive)
 *   - no fuzzy matching, no subsidiary detection, no domain comparison
 *
 * NOTE: "co" is intentionally excluded from the suffix list.
 * Including it would silently corrupt names ending in those letters
 * (e.g. "Cisco" → "cis", "Costco" → "costc", "Pepsico" → "pepsi").
 * The false-negative on "ABC Co" is acceptable for V1.
 */

const SUFFIX_REGEX =
  /[,.]?\s*(llc|inc|corp|ltd|p\.c\.|llp|s\.a\.|gmbh|ag|limited|incorporated|corporation|company)\.?\s*$/i;

export function normalizeCompany(name: string | null | undefined): string {
  if (!name?.trim()) return '';
  return name.trim().toLowerCase().replace(SUFFIX_REGEX, '').trim();
}

export function isSameCompany(
  a: { company?: string | null },
  b: { company?: string | null }
): boolean {
  const normA = normalizeCompany(a.company);
  const normB = normalizeCompany(b.company);
  if (!normA || !normB) return false; // permissive: missing company → not same
  return normA === normB;
}
