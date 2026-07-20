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

type Situation = 'employed' | 'independent' | 'between_roles' | 'retired' | 'confidential' | 'stealth'

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
function companySituation(company: string | null | undefined): Situation | 'employed' | null {
  const n = norm(company)
  if (!n) return null
  if (INDEPENDENT_EXACT.has(n) || /^(independent|freelance|self employed|selfemployed|fractional)\b/.test(n)) return 'independent'
  if (STEALTH_EXACT.has(n) || /^stealth\b/.test(n)) return 'stealth'
  if (BETWEEN_EXACT.has(n) || /^between (roles|jobs)\b/.test(n)) return 'between_roles'
  if (RETIRED_EXACT.has(n)) return 'retired'
  if (CONFIDENTIAL_EXACT.has(n)) return 'confidential'
  return 'employed'
}

/** Map the current_status enum onto a situation, when it carries signal. */
function statusSituation(current_status: string | null | undefined): Situation | null {
  switch ((current_status || '').toLowerCase()) {
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

  // Decide the situation: a placeholder/real company wins; else fall back to
  // current_status; else it's a plain (possibly title-only) employed line.
  let situation: Situation
  const fromCompany = companySituation(company)
  if (fromCompany && fromCompany !== 'employed') {
    situation = fromCompany
  } else if (fromCompany === 'employed') {
    situation = 'employed'
  } else {
    situation = statusSituation(p.current_status) ?? 'employed'
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
    case 'between_roles':
      return { primary: title || 'Professional', secondary: prevAt('Most recently at') ?? 'Currently between roles' }
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
