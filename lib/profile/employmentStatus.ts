/**
 * THE employment-status vocabulary. One definition, shared by onboarding, profile editing and the
 * admin panel, so a member cannot be shown one set of choices and validated against another.
 *
 * The three values already exist in production (`profiles.current_status`, free text with no
 * constraint). Nothing here adds a value, renames one, or needs a migration.
 *
 * WHY STATUS IS ASKED DIRECTLY. Before this, status was inferred from placeholder company text —
 * a member typed "Independent" or "Between roles" into the company box and the profile read it
 * back. That made the profile's meaning depend on free text nobody validated, and it is how
 * "General Counsel at Independent" became possible. Asking the question is shorter, clearer, and
 * gives the compatibility rule something real to check.
 */
import { checkRoleEmploymentCompatibility, type CompatibilityVerdict } from '@/lib/profile/roleEmploymentCompatibility'

export const EMPLOYMENT_STATUSES = ['employed', 'between_roles', 'consulting_advisory'] as const
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number]

export function isEmploymentStatus(v: unknown): v is EmploymentStatus {
  return typeof v === 'string' && (EMPLOYMENT_STATUSES as readonly string[]).includes(v)
}

export interface EmploymentStatusOption {
  value: EmploymentStatus
  /** The label every surface shows. Identical wording in onboarding, profile edit and admin. */
  label: string
  /** One line under the label, so the member picks correctly the first time. */
  description: string
  /** Whether an organisation/practice name is required, optional, or asked for differently. */
  company: 'required' | 'optional'
  /** The field label to show for company under this status. */
  companyLabel: string
  companyHint: string
}

export const EMPLOYMENT_STATUS_OPTIONS: readonly EmploymentStatusOption[] = [
  {
    value: 'employed',
    label: 'Currently employed',
    description: 'You work for an organisation right now.',
    company: 'required',
    companyLabel: 'Organisation',
    companyHint: 'The organisation you work for. Not “Independent”, “Self-employed” or “N/A”.',
  },
  {
    value: 'between_roles',
    label: 'Between roles',
    description: 'You are not in a position right now. Your profile will not name a current employer.',
    company: 'optional',
    companyLabel: 'Most recent organisation (optional)',
    companyHint: 'Shown as previous, never as somewhere you currently work.',
  },
  {
    value: 'consulting_advisory',
    label: 'Consulting / advisory',
    description: 'You advise, consult, or run your own practice — including fractional work.',
    company: 'optional',
    companyLabel: 'Practice or firm name (optional)',
    companyHint: 'The name of your practice or firm, if it has one.',
  },
] as const

export function employmentStatusOption(v: string | null | undefined): EmploymentStatusOption | null {
  return EMPLOYMENT_STATUS_OPTIONS.find((o) => o.value === String(v ?? '').trim()) ?? null
}

export function employmentStatusLabel(v: string | null | undefined): string {
  return employmentStatusOption(v)?.label ?? ''
}

/**
 * THE SAME verdict the server will reach, for showing beside the fields before submit.
 *
 * It is a thin re-export on purpose: a second client-side copy of the rules is a second thing to
 * keep in step, and the two would drift. The server remains the authority — this only means the
 * member finds out at the field rather than at the submit button.
 */
export function previewCompatibility(input: {
  role_type?: string | null
  current_status?: string | null
  company?: string | null
}): CompatibilityVerdict {
  return checkRoleEmploymentCompatibility(input)
}

/**
 * Switching to "Between roles" while a company is populated is NOT an error and must NOT silently
 * clear the field — it is the member's own data. But it must not be shown as a current employer
 * either, so the member is asked to confirm which it is. The value stays in the company field; it
 * is not copied into any separate record.
 *
 * Returns the confirmation prompt when one is needed, or null.
 */
export function betweenRolesCompanyPrompt(args: {
  nextStatus: string | null | undefined
  company: string | null | undefined
}): string | null {
  if (String(args.nextStatus ?? '').trim() !== 'between_roles') return null
  const c = String(args.company ?? '').trim()
  if (!c) return null
  return `You have “${c}” as your organisation. Between roles means it will be shown as where you ` +
         `worked previously, not where you work now. Keep it as your most recent organisation, or ` +
         `clear it.`
}
