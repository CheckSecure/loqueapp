/**
 * intro_preferences → role_type matching.
 *
 * THE DEFECT THIS EXISTS TO FIX. Every scorer compared a member's `intro_preferences`
 * directly against a candidate's `role_type` by string equality or substring. Those two
 * columns hold DIFFERENT VOCABULARIES:
 *
 *   intro_preferences : 'Legal', 'Executive / C-Suite', 'Investor / VC', 'Founders',
 *                       'Collaborators', 'Government / Policy', …   (categories/relationships)
 *   role_type         : 'General Counsel', 'Law Firm Partner', 'In-House Counsel',
 *                       'Associate General Counsel', 'CISO', …       (job titles)
 *
 * 'Legal' is not a substring of 'General Counsel', so the +30/+20 preference bonus in
 * batch-scoring.ts fired for essentially nobody. On production, exactly ONE member held a
 * role_type ('Executive / C-Suite') that literally equalled a preference value.
 *
 * THREE VOCABULARIES, NOT TWO — they drifted, they were not designed apart:
 *   components/OnboardingForm.tsx MEET_ROLE_TYPES : role CATEGORIES  (6 values)
 *   components/OnboardingStep2.tsx INTRO_PREFS    : RELATIONSHIPS    (6 values)
 *   components/ProfileForm.tsx     INTRO_PREFS    : RELATIONSHIPS    (same 6)
 * All three write the same column. Nothing reconciles them.
 *
 * WHY SOME PREFERENCES MAP TO NOTHING. 'Collaborators', 'Potential hires' and 'Customers'
 * describe a RELATIONSHIP the member wants, not a role the counterpart holds — no role_type
 * can satisfy them, and inventing one would be a category error that silently boosts
 * unrelated pairs. 'Mentors' is already modelled by mentorship_role (+25 in scoreMatch); a
 * second path here would double-count it. These are listed in UNMAPPED_PREFERENCES so the
 * gap is explicit and reviewable rather than an unnoticed silent miss.
 */
import { ROLE_CATEGORIES, titleToCategory, type Category } from '@/lib/role-taxonomy'

export type PreferenceTarget = {
  /** Satisfied when the candidate's role_type belongs to ANY of these taxonomy categories. */
  categories?: readonly Category[]
  /** Satisfied only by these exact role_type titles — narrower than a whole category. */
  titles?: readonly string[]
  /** Why this mapping was chosen; shown in review, kept next to the decision. */
  note?: string
}

export const PREFERENCE_TARGETS: Record<string, PreferenceTarget> = {
  // ── Vocabulary 1 — OnboardingForm MEET_ROLE_TYPES. These ARE categories; two match a
  //    taxonomy key exactly, two are near-misses that need the alias.
  'Legal':                { categories: ['Legal'] },
  'Executive / C-Suite':  { categories: ['Executive / C-Suite'],
                            titles: ['Chief Legal Officer', 'CISO'],
                            note: 'OPERATOR DECISION: Chief Legal Officer and CISO also satisfy this. '
                                + 'The taxonomy files CLO under "Legal" and CISO under '
                                + '"Technology / Cybersecurity", and both stay there — a CLO still '
                                + 'satisfies a "Legal" preference. Added as TITLES rather than by '
                                + 'moving them in ROLE_CATEGORIES, so every edit surface and picker '
                                + 'that reads the taxonomy is unaffected. A CLO is genuinely C-suite '
                                + 'and 61 members ask for this category.' },
  'Finance':              { categories: ['Finance'] },
  'Healthcare':           { categories: ['Healthcare'] },
  'Investor / VC':        { categories: ['Investor / Private Equity'],
                            note: 'Taxonomy key is "Investor / Private Equity"; the picker says "Investor / VC".' },
  'Government / Policy':  { categories: ['Government Affairs / Policy'],
                            note: 'Taxonomy key is "Government Affairs / Policy"; the picker drops "Affairs".' },

  // ── Vocabulary 2 — OnboardingStep2 / ProfileForm INTRO_PREFS. Relationship words.
  'Investors':            { categories: ['Investor / Private Equity'],
                            note: 'Same target as "Investor / VC" from the other picker.' },
  'Founders':             { titles: ['Founder'],
                            note: 'JUDGMENT: title-level, NOT the whole "Executive / C-Suite" category — '
                                + 'mapping to the category would let every CEO, COO and President satisfy '
                                + 'a preference for founders.' },
}

/**
 * Preferences with NO role_type that can satisfy them. Deliberate, not an oversight.
 * Listed so a reviewer sees the decision instead of discovering a silent non-match later.
 */
export const UNMAPPED_PREFERENCES: Record<string, string> = {
  'Collaborators':  'A relationship, not a role. No role_type implies it.',
  'Potential hires':'A relationship, and role-agnostic — any role could be a hire.',
  'Customers':      'Depends on what the member sells, which role_type does not encode.',
  'Mentors':        'Already modelled by mentorship_role (+25 in scoreMatch). Mapping it here would double-count.',
}

/** Lowercased index, so a stored preference that differs only in case still resolves. */
const PREF_KEY_BY_LOWER: Record<string, string> = Object.fromEntries(
  Object.keys(PREFERENCE_TARGETS).map((k) => [k.toLowerCase(), k]),
)

/** True when `roleType` satisfies the stated `pref`. Unknown preferences never match. */
export function preferenceMatchesRole(pref: string | null | undefined, roleType: string | null | undefined): boolean {
  const p = String(pref ?? '').trim()
  const r = String(roleType ?? '').trim()
  if (!p || !r) return false

  const target = PREFERENCE_TARGETS[p] ?? PREFERENCE_TARGETS[PREF_KEY_BY_LOWER[p.toLowerCase()]]
  if (!target) {
    // Legacy exact match, preserved so any value that DID work before still works.
    return p.toLowerCase() === r.toLowerCase()
  }
  if (target.titles?.some((t) => t.toLowerCase() === r.toLowerCase())) return true
  if (!target.categories?.length) return false

  const cat = titleToCategory(r)                       // handles canonical AND legacy titles
  return cat !== null && cat !== 'Other' && target.categories.includes(cat as Category)
}

/** Every role_type a preference would accept — for review and for tests. */
export function rolesSatisfying(pref: string): string[] {
  const t = PREFERENCE_TARGETS[pref]
  if (!t) return []
  const out = [...(t.titles ?? [])]
  for (const c of t.categories ?? []) out.push(...(ROLE_CATEGORIES[c] as readonly string[]))
  return Array.from(new Set(out)).sort()
}
