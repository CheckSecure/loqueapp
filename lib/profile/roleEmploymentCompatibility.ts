/**
 * Role ↔ employment-status compatibility.
 *
 * THE RULE THIS ENFORCES. "In-house" is itself an employment relationship. A member cannot hold an
 * in-house legal role and simultaneously present as independent, consulting, or between roles —
 * those describe not having the employer the role asserts. The profile would say two contradictory
 * things at once, and the one people act on ("General Counsel at …") would be the false one.
 *
 * ─── THE STATUS PRECEDENCE RULE, STATED ONCE ──────────────────────────────────────────────────
 * There is NO stored `independent` or `self_employed` value. The vocabulary is exactly
 *   employed | between_roles | consulting_advisory
 * and 'consulting_advisory' is what "independent" means in storage.
 *
 * THE RULE:
 *   1. STORED current_status IS THE AUTHORITY whenever it is present. Company text never
 *      reinterprets it.
 *   2. Company text is a LEGACY FALLBACK, used only when current_status is null — for rows that
 *      predate the field being collected.
 *   3. A placeholder company does not SILENTLY change an 'employed' status into independent; it
 *      makes that combination INVALID, and the member is told. Concealing the contradiction by
 *      reinterpreting it is what let "General Counsel at Independent" exist in the first place.
 *   4. A genuine company NEVER converts 'between_roles' into 'employed'. Somebody between roles
 *      with a former employer still populated is between roles; that company text is rendered as
 *      a past employer, not as a current position.
 *
 * Rendering and validation read this same function, so a profile can never display a situation the
 * validator would not accept.
 *
 * ─── WHAT IT NEVER DOES ───────────────────────────────────────────────────────────────────────
 * It never rewrites a role, a status, or a company. It returns a verdict and the member decides
 * which of the two to change. Silently "fixing" a role would assert an employment relationship the
 * member did not claim — the exact failure this file exists to prevent, inverted.
 */
import { companySituation, isPlaceholderCompany } from '@/lib/professionalIdentity'

/**
 * Roles that ASSERT a current employer. Listed exactly — never by substring, because "counsel"
 * also appears in 'Of Counsel' and in law-firm titles, which are a different relationship.
 *
 * NOT included, deliberately: 'Legal Operations' (frequently a consulting engagement) and
 * 'Legal services professional' (a vendor category). Adding either is a product decision, not an
 * inference this module should make on its own.
 */
export const IN_HOUSE_LEGAL_ROLES: readonly string[] = [
  'General Counsel',
  'Chief Legal Officer',
  'In-House Counsel',
  'In-house Counsel',        // legacy stored variant, still held by members
  'Deputy General Counsel',
  'Associate General Counsel',
  'Corporate Counsel',       // alias target; included so a direct store is covered too
]

/** Roles that assert a FIRM (or a named solo practice), not an employer. */
export const LAW_FIRM_ROLES: readonly string[] = [
  'Law Firm Partner',
  'Law Firm Attorney',
  'Law firm attorney',
]

/** The employment situation a profile effectively presents. */
export type EmploymentSituation = 'employed' | 'independent' | 'between_roles' | 'unknown'

export interface CompatibilityInput {
  role_type?: string | null
  current_status?: string | null
  company?: string | null
}

export type CompatibilityCode =
  | 'ok'
  | 'in_house_requires_employment'
  | 'in_house_requires_company'
  | 'law_firm_requires_firm_name'
  | 'employed_requires_genuine_company'
  | 'between_roles_conflicts_with_company'

export interface CompatibilityVerdict {
  ok: boolean
  code: CompatibilityCode
  /** User-facing. Names BOTH ways out, so the member chooses rather than being cornered. */
  message: string
}

const OK: CompatibilityVerdict = { ok: true, code: 'ok', message: '' }

export function isInHouseLegalRole(roleType: string | null | undefined): boolean {
  return IN_HOUSE_LEGAL_ROLES.includes(String(roleType ?? '').trim())
}
export function isLawFirmRole(roleType: string | null | undefined): boolean {
  return LAW_FIRM_ROLES.includes(String(roleType ?? '').trim())
}

/**
 * The situation a profile presents. STORED STATUS WINS; company text is a legacy fallback only.
 *
 * A placeholder company does NOT flip a stored 'employed' to independent here — that combination
 * is a contradiction the member must resolve, and checkRoleEmploymentCompatibility reports it. If
 * this function quietly reinterpreted it, the contradiction would be invisible and permanent.
 */
export function effectiveSituation(input: CompatibilityInput): EmploymentSituation {
  const stored = String(input.current_status ?? '').trim()
  if (stored) {
    switch (stored) {
      case 'employed': return 'employed'                 // even against a placeholder company:
                                                          // that is invalid, not "independent"
      case 'between_roles': return 'between_roles'        // a populated company does not undo this
      case 'consulting_advisory': return 'independent'
      default: return 'unknown'                           // an unrecognised stored value
    }
  }

  // LEGACY FALLBACK — status was never collected for this row. Read the company, exactly as the
  // display layer does, so old profiles keep behaving as they always have.
  const fromCompany = companySituation(input.company)
  if (fromCompany === 'independent') return 'independent'
  if (fromCompany === 'between_roles') return 'between_roles'
  return fromCompany === 'employed' ? 'employed' : 'unknown'
}

/** True when the company names a real organisation (not blank, not a placeholder). */
export function hasGenuineCompany(company: string | null | undefined): boolean {
  const c = String(company ?? '').trim()
  return c.length > 0 && !isPlaceholderCompany(c)
}

/**
 * Evaluate a role/status/company combination. Returns ok for everything it does not have an
 * explicit rule about — this refuses contradictions, it does not police profiles.
 */
export function checkRoleEmploymentCompatibility(input: CompatibilityInput): CompatibilityVerdict {
  const role = String(input.role_type ?? '').trim()
  if (!role) return OK

  const stored = String(input.current_status ?? '').trim()

  if (isInHouseLegalRole(role)) {
    const situation = effectiveSituation(input)
    if (situation === 'independent') {
      return {
        ok: false,
        code: 'in_house_requires_employment',
        message:
          `“${role}” is an in-house role, so it means you are employed by the organisation. ` +
          `Your profile currently presents you as independent or consulting. ` +
          `Either set your employment status to “Currently employed” and name your employer, or ` +
          `choose a role that matches independent work — Advisor, Consultant, or Other.`,
      }
    }
    if (situation === 'between_roles') {
      return {
        ok: false,
        code: 'in_house_requires_employment',
        message:
          `“${role}” is an in-house role, so your profile would show you as currently holding it. ` +
          `Your employment status says you are between roles. Your profile carries one role and ` +
          `presents it as a position you hold now, so it cannot show an in-house role while you ` +
          `are between roles. Either set your status to “Currently employed” and name your ` +
          `employer, or choose a role that reflects where you are now — Advisor, Consultant, or Other.`,
      }
    }
    if (!hasGenuineCompany(input.company)) {
      // Includes a placeholder company: 'employed' + "Independent" keeps the employed situation
      // (status is the authority) but still does not name an employer.
      return {
        ok: false,
        code: 'in_house_requires_company',
        message:
          `“${role}” is an in-house role, so it needs the organisation you work for. ` +
          `Add your employer, or choose a role that does not imply one — Advisor, Consultant, ` +
          `or Other.`,
      }
    }
    return OK
  }

  if (isLawFirmRole(role)) {
    // A law-firm role is a CURRENT position, so 'between roles' contradicts it the same way an
    // in-house role does.
    if (effectiveSituation(input) === 'between_roles') {
      return {
        ok: false,
        code: 'in_house_requires_employment',
        message:
          `“${role}” would show as a position you currently hold, but your status says you are ` +
          'between roles. Your profile carries one role and presents it as a position you hold ' +
          'now, so it cannot show a law-firm role while you are between roles. Choose a role that ' +
          'reflects where you are now — Advisor, Consultant, or Other.',
      }
    }
    // Otherwise: a firm name, or a named solo practice. Independent STATUS is fine — a genuine solo
    // practitioner is independent — but the practice still has to be named. A placeholder like
    // "Independent" is a working arrangement, not the name of a practice.
    const c = String(input.company ?? '').trim()
    if (c.length === 0 || !hasGenuineCompany(c)) {
      return {
        ok: false,
        code: 'law_firm_requires_firm_name',
        message:
          `“${role}” needs the name of your firm or solo practice — “${String(input.company ?? '').trim() || 'nothing'}” ` +
          'does not name one. Add it, or choose Advisor, Consultant or Other if you are not ' +
          'currently practising at a firm. Independent legal work does not have to be filed as a ' +
          'law-firm role.',
      }
    }
    return OK
  }

  // ── STATUS ↔ COMPANY, for every role with no family rule of its own ──────────────────────
  // 'employed' asserts an employer, so a placeholder company contradicts it outright. Reported
  // rather than silently reinterpreted (see the precedence rule above). This runs AFTER the role
  // families so an in-house or law-firm member gets the more specific message.
  if (stored === 'employed' && !hasGenuineCompany(input.company)) {
    return {
      ok: false,
      code: 'employed_requires_genuine_company',
      message:
        String(input.company ?? '').trim().length === 0
          ? 'You selected “Currently employed”, so please name the organisation you work for — or ' +
            'change your status to “Between roles” or “Consulting / advisory”.'
          : `“${String(input.company).trim()}” describes a working arrangement rather than an ` +
            'employer. Either name the organisation you work for, or change your status to ' +
            '“Consulting / advisory” or “Between roles”.',
    }
  }

  return OK
}
