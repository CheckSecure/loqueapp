/**
 * Searchable title catalog for Phase D.
 *
 * Combines:
 *  - Every structured ROLE_CATEGORIES title (47) → display === role_type
 *  - Every titleToCategory-accepted legacy value (19) → display === role_type
 *  - Human-readable display aliases (e.g. "Chief Financial Officer" →
 *    "CFO") whose role_type is a structured/legacy value
 *
 * THE FIREWALL: every entry's role_type field MUST resolve via
 * titleToCategory() to non-null. This is asserted at module-load below; a
 * single null-mapping aborts the build. role_type can NEVER be set to a
 * human-readable string that isn't already in the structured/legacy set.
 *
 * Resolution rule used by SearchableTitleSelect:
 *  - User picks a STRUCTURED entry (display === role_type):
 *      write role_type=display, exact_job_title=null (unless user typed custom)
 *  - User picks an ALIAS entry (display !== role_type):
 *      write role_type=mapping.role_type, exact_job_title=display
 *  - User types a free-text exact title atop any structured pick:
 *      write role_type=picked, exact_job_title=typed
 */

import { ROLE_CATEGORIES, titleToCategory, type Category } from '@/lib/role-taxonomy'

export interface SearchableTitle {
  display: string
  role_type: string
  category: Category | 'Other'
}

// ─── Structured titles (Phase B ROLE_CATEGORIES) ───────────────────────────
const STRUCTURED_ENTRIES: SearchableTitle[] = (Object.keys(ROLE_CATEGORIES) as Category[])
  .flatMap((cat) =>
    (ROLE_CATEGORIES[cat] as readonly string[]).map((title) => ({
      display: title,
      role_type: title,
      category: cat,
    }))
  )

// ─── Legacy values titleToCategory accepts ─────────────────────────────────
// These are valid role_type strings already in production. Each gets a
// searchable entry so existing users can find/keep their title.
const LEGACY_ENTRIES: SearchableTitle[] = [
  { display: 'In-house Counsel',              role_type: 'In-house Counsel',              category: 'Legal' },
  { display: 'Law Firm Attorney',             role_type: 'Law Firm Attorney',             category: 'Legal' },
  { display: 'Law firm attorney',             role_type: 'Law firm attorney',             category: 'Legal' },
  { display: 'Legal services professional',   role_type: 'Legal services professional',   category: 'Legal' },
  { display: 'Compliance',                    role_type: 'Compliance',                    category: 'Legal' },
  { display: 'Risk',                          role_type: 'Risk',                          category: 'Legal' },
  { display: 'Privacy',                       role_type: 'Privacy',                       category: 'Legal' },
  { display: 'Legal Tech Founder',            role_type: 'Legal Tech Founder',            category: 'Legal' },
  { display: 'Legal',                         role_type: 'Legal',                         category: 'Legal' },
  { display: 'Regulatory Affairs',            role_type: 'Regulatory Affairs',            category: 'Government Affairs / Policy' },
  { display: 'Government Affairs',            role_type: 'Government Affairs',            category: 'Government Affairs / Policy' },
  { display: 'Government / Policy',           role_type: 'Government / Policy',           category: 'Government Affairs / Policy' },
  { display: 'Government / Public Sector',    role_type: 'Government / Public Sector',    category: 'Government Affairs / Policy' },
  { display: 'Executive / C-Suite',           role_type: 'Executive / C-Suite',           category: 'Executive / C-Suite' },
  { display: 'Investor / VC',                 role_type: 'Investor / VC',                 category: 'Investor / Private Equity' },
  { display: 'Finance Professional',          role_type: 'Finance Professional',          category: 'Finance' },
  { display: 'Finance',                       role_type: 'Finance',                       category: 'Finance' },
  { display: 'Healthcare Professional',       role_type: 'Healthcare Professional',       category: 'Healthcare' },
  { display: 'Healthcare',                    role_type: 'Healthcare',                    category: 'Healthcare' },
]

// ─── Display aliases (Phase D spec — closest structured parent) ────────────
// Every role_type below MUST resolve via titleToCategory to non-null. The
// module-load assertion at the bottom of this file guarantees this.
const ALIAS_ENTRIES: SearchableTitle[] = [
  // ─── Executive / C-Suite spell-outs + adjacent ───
  { display: 'Chief Executive Officer',            role_type: 'CEO',                              category: 'Executive / C-Suite' },
  { display: 'Co-Founder',                         role_type: 'Founder',                          category: 'Executive / C-Suite' },
  { display: 'Founder & CEO',                      role_type: 'Founder',                          category: 'Executive / C-Suite' },
  { display: 'Chief Operating Officer',            role_type: 'COO',                              category: 'Executive / C-Suite' },
  { display: 'Chief Administrative Officer',       role_type: 'Operations Executive',             category: 'Operations' },
  { display: 'Chief of Staff',                     role_type: 'COO',                              category: 'Executive / C-Suite' },
  { display: 'Board Member',                       role_type: 'Executive / C-Suite',              category: 'Executive / C-Suite' },

  // ─── Finance spell-outs + adjacent ───
  { display: 'Chief Financial Officer',            role_type: 'CFO',                              category: 'Finance' },
  { display: 'Fractional CFO',                     role_type: 'CFO',                              category: 'Finance' },
  { display: 'Director of Finance',                role_type: 'VP Finance',                       category: 'Finance' },
  { display: 'Chief Accounting Officer',           role_type: 'Controller',                       category: 'Finance' },
  { display: 'Director of Treasury',               role_type: 'Treasurer',                        category: 'Finance' },
  { display: 'Financial Planning Director',        role_type: 'Head of FP&A',                     category: 'Finance' },
  { display: 'Director of FP&A',                   role_type: 'Head of FP&A',                     category: 'Finance' },
  { display: 'Corporate Development Executive',    role_type: 'VP Finance',                       category: 'Finance' },

  // ─── HR / People ───
  { display: 'VP of Human Resources',              role_type: 'HR Executive',                     category: 'HR / People' },
  { display: 'HR Director',                        role_type: 'HR Executive',                     category: 'HR / People' },
  { display: 'Director of People Operations',      role_type: 'HR Executive',                     category: 'HR / People' },
  { display: 'Director of Talent Acquisition',     role_type: 'Head of Talent',                   category: 'HR / People' },
  { display: 'VP of People',                       role_type: 'Chief People Officer',             category: 'HR / People' },

  // ─── Sales / Revenue spell-outs + adjacent ───
  { display: 'Chief Revenue Officer',              role_type: 'CRO',                              category: 'Sales / Revenue' },
  { display: 'Chief Commercial Officer',           role_type: 'CRO',                              category: 'Sales / Revenue' },
  { display: 'Chief Growth Officer',               role_type: 'CRO',                              category: 'Sales / Revenue' },
  { display: 'Sales Director',                     role_type: 'VP Sales',                         category: 'Sales / Revenue' },
  { display: 'Director of Sales',                  role_type: 'VP Sales',                         category: 'Sales / Revenue' },
  { display: 'VP of Sales',                        role_type: 'VP Sales',                         category: 'Sales / Revenue' },
  { display: 'VP of Business Development',         role_type: 'Head of Business Development',     category: 'Sales / Revenue' },
  { display: 'Director of Business Development',   role_type: 'Head of Business Development',     category: 'Sales / Revenue' },
  { display: 'Head of Partnerships',               role_type: 'Partnerships Executive',           category: 'Sales / Revenue' },
  { display: 'VP of Partnerships',                 role_type: 'Partnerships Executive',           category: 'Sales / Revenue' },
  { display: 'Customer Success Executive',         role_type: 'VP Sales',                         category: 'Sales / Revenue' },
  { display: 'Revenue Operations Leader',          role_type: 'VP Sales',                         category: 'Sales / Revenue' },

  // ─── Marketing spell-outs + adjacent ───
  { display: 'Chief Marketing Officer',            role_type: 'CMO',                              category: 'Marketing' },
  { display: 'Marketing Director',                 role_type: 'VP Marketing',                     category: 'Marketing' },
  { display: 'Director of Marketing',              role_type: 'VP Marketing',                     category: 'Marketing' },
  { display: 'Brand Director',                     role_type: 'Brand Executive',                  category: 'Marketing' },
  { display: 'Director of Brand',                  role_type: 'Brand Executive',                  category: 'Marketing' },

  // ─── Operations ───
  { display: 'Director of Operations',             role_type: 'Operations Executive',             category: 'Operations' },
  { display: 'VP of Operations',                   role_type: 'Operations Executive',             category: 'Operations' },
  { display: 'Operations Director',                role_type: 'Operations Executive',             category: 'Operations' },
  { display: 'Head of Operations',                 role_type: 'Operations Executive',             category: 'Operations' },

  // ─── Technology / Cybersecurity spell-outs + adjacent ───
  { display: 'Chief Technology Officer',           role_type: 'CTO',                              category: 'Technology / Cybersecurity' },
  { display: 'Chief Information Officer',          role_type: 'CIO',                              category: 'Technology / Cybersecurity' },
  { display: 'Chief Product Officer',              role_type: 'Technology Executive',             category: 'Technology / Cybersecurity' },
  { display: 'VP of Engineering',                  role_type: 'Technology Executive',             category: 'Technology / Cybersecurity' },
  { display: 'Engineering Director',               role_type: 'Technology Executive',             category: 'Technology / Cybersecurity' },
  { display: 'Director of Engineering',            role_type: 'Technology Executive',             category: 'Technology / Cybersecurity' },
  { display: 'VP of Technology',                   role_type: 'Technology Executive',             category: 'Technology / Cybersecurity' },
  { display: 'VP of IT',                           role_type: 'Technology Executive',             category: 'Technology / Cybersecurity' },
  { display: 'Head of Engineering',                role_type: 'Technology Executive',             category: 'Technology / Cybersecurity' },
  { display: 'Chief Information Security Officer', role_type: 'CISO',                             category: 'Technology / Cybersecurity' },
  { display: 'Director of Cybersecurity',          role_type: 'Cybersecurity Executive',          category: 'Technology / Cybersecurity' },
  { display: 'Information Security Director',      role_type: 'Cybersecurity Executive',          category: 'Technology / Cybersecurity' },

  // ─── Government Affairs / Policy ───
  { display: 'Director of Government Affairs',     role_type: 'Government Affairs Executive',     category: 'Government Affairs / Policy' },
  { display: 'VP of Government Affairs',           role_type: 'Government Affairs Executive',     category: 'Government Affairs / Policy' },
  { display: 'Senior Policy Advisor',              role_type: 'Public Policy Executive',          category: 'Government Affairs / Policy' },
  { display: 'Public Affairs Director',            role_type: 'Public Policy Executive',          category: 'Government Affairs / Policy' },
  { display: 'Director of Regulatory Affairs',     role_type: 'Regulatory Affairs Executive',     category: 'Government Affairs / Policy' },
  { display: 'Lobbyist',                           role_type: 'Government Affairs Executive',     category: 'Government Affairs / Policy' },

  // ─── Investor / Private Equity ───
  { display: 'VP of Investments',                  role_type: 'Investor',                         category: 'Investor / Private Equity' },
  { display: 'Director of Investments',            role_type: 'Investor',                         category: 'Investor / Private Equity' },
  { display: 'Senior Investor',                    role_type: 'Investor',                         category: 'Investor / Private Equity' },
  { display: 'Angel Investor',                     role_type: 'Investor',                         category: 'Investor / Private Equity' },
  { display: 'Family Office Principal',            role_type: 'Investor',                         category: 'Investor / Private Equity' },
  { display: 'Venture Partner',                    role_type: 'General Partner',                  category: 'Investor / Private Equity' },

  // ─── Healthcare ───
  { display: 'Director of Clinical Operations',    role_type: 'Healthcare Executive',             category: 'Healthcare' },
  { display: 'Chief Medical Officer',              role_type: 'Healthcare Executive',             category: 'Healthcare' },
  { display: 'Senior Medical Director',            role_type: 'Healthcare Executive',             category: 'Healthcare' },
  { display: 'Medical Affairs Director',           role_type: 'Healthcare Executive',             category: 'Healthcare' },
  { display: 'Biotech Executive',                  role_type: 'Life Sciences Executive',          category: 'Healthcare' },
  { display: 'Pharma Director',                    role_type: 'Life Sciences Executive',          category: 'Healthcare' },

  // ─── Consulting / Advisory ───
  { display: 'Senior Consultant',                  role_type: 'Consultant',                       category: 'Consulting / Advisory' },
  { display: 'Management Consultant',              role_type: 'Consultant',                       category: 'Consulting / Advisory' },
  { display: 'Strategy Consultant',                role_type: 'Consultant',                       category: 'Consulting / Advisory' },
  { display: 'Principal Consultant',               role_type: 'Professional Services Executive',  category: 'Consulting / Advisory' },
  { display: 'Senior Advisor',                     role_type: 'Advisor',                          category: 'Consulting / Advisory' },
  { display: 'Strategic Advisor',                  role_type: 'Advisor',                          category: 'Consulting / Advisory' },

  // ─── Legal aliases (mapped to legacy values per spec) ───
  { display: 'Chief Compliance Officer',           role_type: 'Compliance',                       category: 'Legal' },
  { display: 'Compliance Officer',                 role_type: 'Compliance',                       category: 'Legal' },
  { display: 'Chief Privacy Officer',              role_type: 'Privacy',                          category: 'Legal' },
  { display: 'Privacy Officer',                    role_type: 'Privacy',                          category: 'Legal' },
  { display: 'Chief Risk Officer',                 role_type: 'Risk',                             category: 'Legal' },
  { display: 'Risk Officer',                       role_type: 'Risk',                             category: 'Legal' },
  { display: 'Counsel',                            role_type: 'In-house Counsel',                 category: 'Legal' },
  { display: 'Staff Attorney',                     role_type: 'In-house Counsel',                 category: 'Legal' },
]

export const TITLE_ALIASES: SearchableTitle[] = [
  ...STRUCTURED_ENTRIES,
  ...LEGACY_ENTRIES,
  ...ALIAS_ENTRIES,
]

// ─── THE FIREWALL — module-load assertion ──────────────────────────────────
// Every TITLE_ALIASES entry's role_type MUST resolve to a non-null category.
// This is the Phase D firewall: no human-readable display string can leak
// into role_type. If this fails, the build aborts.
{
  const violations: string[] = []
  for (const e of TITLE_ALIASES) {
    if (titleToCategory(e.role_type) === null) {
      violations.push(`${e.display} → role_type="${e.role_type}" maps to null`)
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `[searchable-titles] FIREWALL VIOLATION: TITLE_ALIASES contains role_type ` +
      `values that titleToCategory cannot resolve. ` +
      `Every alias must map to a structured-or-legacy role_type.\n` +
      violations.map((v) => `  - ${v}`).join('\n')
    )
  }
}

/**
 * Resolve a free-text picker entry to the (role_type, exact_job_title) pair to
 * persist.
 *
 *  - If the entered string matches a TITLE_ALIASES.display:
 *      structured pick (display===role_type) → { role_type, exact_job_title: null }
 *      alias pick (display!==role_type) → { role_type, exact_job_title: display }
 *  - If no match (free-text exact title typed):
 *      caller MUST supply both fields explicitly; this function returns null
 *
 * Used by SearchableTitleSelect at form-submit time.
 */
export function resolveTitlePick(display: string): { role_type: string; exact_job_title: string | null } | null {
  const match = TITLE_ALIASES.find((e) => e.display === display)
  if (!match) return null
  return {
    role_type: match.role_type,
    exact_job_title: match.display === match.role_type ? null : match.display,
  }
}
