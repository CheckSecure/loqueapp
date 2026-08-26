/**
 * Recruiter-specific onboarding guidance.
 *
 * WHAT THIS IS NOT. It is not a new form, and it stores nothing. Onboarding already collects
 * expertise, desired connections, purposes and industry from every member, and those four fields
 * are exactly what a recruiter needs to be matched well. Adding recruiter copies of them would
 * duplicate questions the member has already answered, add fields to persist, and create the
 * "switching roles erased my answers" problem.
 *
 * So this module CONTEXTUALISES the existing fields instead: when a recruiter role is selected, the
 * form shows a short optional panel explaining what to put in each of those shared fields, in
 * recruiter language. Because it owns no state:
 *   • it can never block profile completion (completion needs title, company, location — unchanged);
 *   • switching away from a recruiter role hides the framing and deletes nothing, because there is
 *     nothing of its own to delete — the shared answers stay exactly as the member left them;
 *   • no database column is added, and exact_job_title is never touched.
 */

/** The two canonical recruiter role_type values. Matched EXACTLY — never by substring. */
export const RECRUITER_ROLE_TYPES = ['Executive Recruiter', 'In-House Talent Leader'] as const
export type RecruiterRoleType = (typeof RECRUITER_ROLE_TYPES)[number]

/** True only for the two recruiter values. 'Head of Talent' and every other role return false. */
export function isRecruiterRoleType(roleType: string | null | undefined): boolean {
  return (RECRUITER_ROLE_TYPES as readonly string[]).includes(String(roleType ?? '').trim())
}

/** True for the EXTERNAL recruiter only — the value that is throttled as a service provider. */
export function isExternalRecruiterRoleType(roleType: string | null | undefined): boolean {
  return String(roleType ?? '').trim() === 'Executive Recruiter'
}

export interface RecruiterGuidance {
  heading: string
  intro: string
  /** One line per shared field the member has already been asked for, in recruiter language. */
  points: { field: string; label: string; hint: string }[]
  footnote: string
}

/**
 * The copy, keyed to which recruiter the member is. Every `field` names an EXISTING onboarding
 * field — nothing here introduces a new one.
 *
 * The footnote states plainly that Andrel membership is not consent to be recruited. That is a
 * product boundary, said once, where a recruiter is reading.
 */
export function recruiterGuidance(roleType: string | null | undefined): RecruiterGuidance | null {
  if (!isRecruiterRoleType(roleType)) return null
  const external = isExternalRecruiterRoleType(roleType)
  return {
    heading: external ? 'Tell us what you search for' : 'Tell us what you hire for',
    intro: external
      ? 'Optional — it helps us introduce you to the right people. Use the questions you have already answered above; there is nothing extra to fill in here.'
      : 'Optional — it helps us introduce you to the right people. Use the questions you have already answered above; there is nothing extra to fill in here.',
    points: [
      {
        field: 'expertise',
        label: 'Areas of expertise',
        hint: external
          ? 'The industries and functions you run searches in — for example “legal”, “private equity”, “cybersecurity”.'
          : 'The industries and functions you hire for — for example “legal”, “engineering”, “commercial”.',
      },
      {
        field: 'desired_connections',
        label: 'Who you want to meet',
        hint: external
          ? 'The roles you most want to know — often the people who hire, and the people you place.'
          : 'The roles you most want to know — peers in talent, and leaders in the functions you hire for.',
      },
      {
        field: 'purposes',
        label: 'What you are here for',
        hint: 'Why you want introductions — hiring, referrals, market insight, peer conversation.',
      },
    ],
    footnote:
      'Andrel is a peer network. Membership is not consent to be recruited, and member details are not for sourcing outside Andrel.',
  }
}
