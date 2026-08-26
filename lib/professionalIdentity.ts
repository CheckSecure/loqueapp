/**
 * Single source of truth for rendering a member's professional identity line.
 *
 * Many members list their company as a placeholder ("Independent",
 * "Self-employed", "Confidential", "Between roles", …). Rendered naively as
 * "General Counsel at Independent" this makes accomplished people look less
 * established than they are. This helper turns those into dignified,
 * non-awkward phrasings ("Independent General Counsel", "Former General
 * Counsel", …) and NEVER emits "… at Independent / Self-employed / Confidential".
 *
 * Display-only: reads existing columns (title/exact_job_title/role_type,
 * company, current_status, previous_roles). It does NOT touch matching,
 * scoring, or the schema.
 */

export interface ProfessionalIdentityInput {
  title?: string | null
  exact_job_title?: string | null
  role_type?: string | null
  company?: string | null
  current_status?: string | null
  previous_roles?: Array<{ company?: string | null; title?: string | null }> | null
}

export interface ProfessionalIdentity {
  /** Headline line. Never "… at Independent". Empty string only when there is
   *  genuinely nothing to show (no title and no real company). */
  primary: string
  /** Optional support line (e.g. "Previously at Microsoft", "Currently between
   *  roles", "Current organization confidential"). Null when none applies. */
  secondary: string | null
}

export type Situation = 'employed' | 'independent' | 'between_roles' | 'retired' | 'confidential' | 'stealth'

/** Lowercase, strip punctuation, collapse whitespace — for placeholder matching. */
function norm(s: string | null | undefined): string {
  return (s || '')
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Whole-string placeholder matches (kept exact to avoid false positives like a
// real firm named "Advisor Group" or "XYZ Consulting Inc").
//
// 'self' IS ON THIS LIST AND MUST STAY. A member typing "Self" as their company is stating a
// working arrangement, not naming an employer — and because these are WHOLE-STRING matches after
// norm() (lowercase, punctuation to space, whitespace collapsed), it catches "Self", "self",
// "SELF" and "  Self  " while leaving real companies whose name merely contains the word —
// "Self Financial, Inc.", "Selfridges", "Self Esteem Brands" — untouched. Only the standalone
// placeholder is caught. "Self-employed" is caught by its own entry, via the same normalisation.
const INDEPENDENT_EXACT = new Set([
  'independent', 'self employed', 'selfemployed', 'self', 'freelance', 'freelancer',
  'fractional', 'consultant', 'consulting', 'advisor', 'advisory', 'sole proprietor',
  'sole trader', 'owner operator', 'independent contractor', 'contractor',
])
const BETWEEN_EXACT = new Set([
  'between roles', 'between jobs', 'in between roles', 'in transition', 'transitioning',
  'unemployed', 'open to work', 'job seeking', 'career break', 'sabbatical', 'on sabbatical',
])
const RETIRED_EXACT = new Set(['retired', 'retiree'])
const CONFIDENTIAL_EXACT = new Set([
  'confidential', 'private', 'undisclosed', 'prefer not to say', 'n a', 'na', 'none', 'unlisted',
])
const STEALTH_EXACT = new Set(['stealth', 'stealth startup', 'stealth mode', 'stealth co', 'stealth company'])

/**
 * Classify a company string. Returns:
 *  - a placeholder situation, or
 *  - 'employed' for a real company, or
 *  - null when the company is empty.
 */
export function companySituation(company: string | null | undefined): Situation | 'employed' | null {
  const n = norm(company)
  if (!n) return null
  if (INDEPENDENT_EXACT.has(n) || /^(independent|freelance|self employed|selfemployed|fractional)\b/.test(n)) return 'independent'
  if (STEALTH_EXACT.has(n) || /^stealth\b/.test(n)) return 'stealth'
  if (BETWEEN_EXACT.has(n) || /^between (roles|jobs)\b/.test(n)) return 'between_roles'
  if (RETIRED_EXACT.has(n)) return 'retired'
  if (CONFIDENTIAL_EXACT.has(n)) return 'confidential'
  return 'employed'
}

/**
 * Map the stored current_status onto a situation. ALL THREE stored values carry signal — see
 * effectiveSituation() in lib/profile/roleEmploymentCompatibility, which this must agree with.
 *
 * 'employed' used to return null here, which quietly let a placeholder company outrank an
 * explicit employed status in RENDERING while validation said the opposite. A member who had
 * told us they are employed was rendered "Independent Corporate Counsel". The status is the
 * authority in both places now; the employed branch below still refuses to print a placeholder
 * after "at", so the contradiction is never dressed up as a real employer either.
 */
function statusSituation(current_status: string | null | undefined): Situation | null {
  switch ((current_status || '').toLowerCase()) {
    case 'employed': return 'employed'
    case 'consulting_advisory': return 'independent'
    case 'between_roles': return 'between_roles'
    default: return null
  }
}

/** True if a company string is a placeholder ("Independent", "Confidential",
 *  "Between roles", …) rather than a real employer. Used both internally (to
 *  avoid surfacing a placeholder as a "Previously at" employer) and by the
 *  profile editor to offer an optional "add recent role" hint. */
export function isPlaceholderCompany(company: string | null | undefined): boolean {
  const s = companySituation(company)
  return s !== null && s !== 'employed'
}

export function displayTitle(p: ProfessionalIdentityInput): string {
  return (p.exact_job_title || p.title || p.role_type || '').trim()
}

/** Most recent usable previous role (first entry with both company and title). */
function recentPreviousRole(p: ProfessionalIdentityInput): { company: string; title: string } | null {
  const roles = Array.isArray(p.previous_roles) ? p.previous_roles : []
  for (const r of roles) {
    const company = (r?.company || '').trim()
    const title = (r?.title || '').trim()
    if (company && title && !isPlaceholderCompany(company)) return { company, title }
  }
  return null
}

function startsWithWord(text: string, word: string): boolean {
  return new RegExp(`^${word}\\b`, 'i').test(text.trim())
}

/**
 * Render a member's professional identity into a `{ primary, secondary }` pair.
 * Use `primary` everywhere a single identity line is shown; render `secondary`
 * beneath it where the layout allows.
 */
export function professionalIdentity(input: ProfessionalIdentityInput | null | undefined): ProfessionalIdentity {
  const p = input || {}
  const title = displayTitle(p)
  const company = (p.company || '').trim()

  // ── SITUATION PRECEDENCE — one rule, shared with validation ────────────────────────────────
  // STORED current_status IS THE AUTHORITY whenever it is present. Company text is a LEGACY
  // FALLBACK, read only when the status was never set.
  //
  // WHY THIS ORDER. The company used to win, which meant a member who had told us they were
  // between roles was still rendered "Counsel at <former employer>" — the profile asserting a
  // current position they had explicitly said they no longer hold. A stale company is history;
  // saying "at" it is the one thing this line must not do.
  //
  // 'employed' + a PLACEHOLDER company keeps the employed situation deliberately: that
  // combination is a contradiction the member is asked to fix
  // (lib/profile/roleEmploymentCompatibility), not something to conceal by re-rendering it as
  // independent. The placeholder still never appears after "at" — see the employed branch.
  let situation: Situation
  const fromCompany = companySituation(company)
  const fromStatus = statusSituation(p.current_status)
  if (fromStatus) {
    situation = fromStatus
  } else if (fromCompany && fromCompany !== 'employed') {
    situation = fromCompany
  } else {
    situation = 'employed'
  }

  const prev = recentPreviousRole(p)
  const prevAt = (lead: string) => (prev ? `${lead} ${prev.company}` : null)

  switch (situation) {
    case 'independent': {
      const primary = !title
        ? 'Independent professional'
        : startsWithWord(title, 'independent')
          ? title
          : `Independent ${title}`
      return { primary, secondary: prevAt('Previously at') }
    }
    case 'retired': {
      const primary = !title
        ? 'Retired professional'
        : startsWithWord(title, 'former')
          ? title
          : `Former ${title}`
      return { primary, secondary: prevAt('Previously at') }
    }
    case 'between_roles': {
      // The company is NOT erased and NOT shown as current. A genuine one becomes "Most recently
      // at …" — history, which is what it is — so a member who told us they are between roles is
      // never rendered as working somewhere. previous_roles still takes precedence when present.
      const recent = prevAt('Most recently at')
        ?? (companySituation(company) === 'employed' ? `Most recently at ${company}` : null)
      return { primary: title || 'Professional', secondary: recent ?? 'Currently between roles' }
    }
    case 'confidential':
      return { primary: title || 'Professional', secondary: 'Current organization confidential' }
    case 'stealth':
      return { primary: title || 'Professional', secondary: prevAt('Previously at') ?? 'Currently in stealth' }
    case 'employed':
    default: {
      // Real company (never a placeholder here) or no company at all.
      const realCompany = fromCompany === 'employed' ? company : ''
      const primary = title && realCompany ? `${title} at ${realCompany}` : title || realCompany
      return { primary, secondary: null }
    }
  }
}

/** Convenience: the single-line identity string (primary only). */
export function professionalIdentityLine(p: ProfessionalIdentityInput | null | undefined): string {
  return professionalIdentity(p).primary
}

/**
 * Decide whether the optional "add a recent role" hint should appear in the
 * profile editor. Pure so the rule is unit-testable. Shows only when:
 *  - the company is a placeholder (Independent, Self-employed, …),
 *  - the user has not already added a usable previous role, and
 *  - the user has not dismissed the hint before.
 * Never fires for real companies, and disappears permanently once dismissed.
 */
export function shouldShowRecentRoleHint(args: {
  company: string | null | undefined
  hasUsablePreviousRole: boolean
  dismissed: boolean
}): boolean {
  return isPlaceholderCompany(args.company) && !args.hasUsablePreviousRole && !args.dismissed
}
