import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  EMPLOYMENT_STATUSES, EMPLOYMENT_STATUS_OPTIONS, isEmploymentStatus,
  employmentStatusOption, previewCompatibility, betweenRolesCompanyPrompt,
} from '@/lib/profile/employmentStatus'
import { checkRoleEmploymentCompatibility, effectiveSituation, hasGenuineCompany } from '@/lib/profile/roleEmploymentCompatibility'
import { professionalIdentity, companySituation, isPlaceholderCompany } from '@/lib/professionalIdentity'

const FORM = readFileSync('components/OnboardingForm.tsx', 'utf8')
const STEP1 = readFileSync('components/OnboardingStep1.tsx', 'utf8')
const FIELD = readFileSync('components/profile/EmploymentStatusField.tsx', 'utf8')
const EDIT = readFileSync('components/ProfileEditForm.tsx', 'utf8')
const ADMIN = readFileSync('components/AdminMembersClient.tsx', 'utf8')
const ACTIONS = readFileSync('app/actions.ts', 'utf8')
const ok = (i: any) => checkRoleEmploymentCompatibility(i).ok

// ── 1. STATUS PRECEDENCE — the canonical rule ────────────────────────────────────────
describe('status precedence', () => {
  it('stored status is the authority whenever present', () => {
    expect(effectiveSituation({ current_status: 'employed', company: 'Acme' })).toBe('employed')
    expect(effectiveSituation({ current_status: 'between_roles', company: 'Acme' })).toBe('between_roles')
    expect(effectiveSituation({ current_status: 'consulting_advisory', company: 'Acme' })).toBe('independent')
  })

  it('a GENUINE company never converts between_roles into employed', () => {
    expect(effectiveSituation({ current_status: 'between_roles', company: 'Armedia' })).toBe('between_roles')
    // and the profile must not render them as currently working there
    const id = professionalIdentity({ title: 'Counsel', company: 'Armedia', current_status: 'between_roles' })
    expect(id.primary).not.toMatch(/ at Armedia/)
  })

  it('a placeholder company does not silently reinterpret employed — it INVALIDATES it', () => {
    // the situation stays 'employed' (status is the authority) …
    expect(effectiveSituation({ current_status: 'employed', company: 'Independent' })).toBe('employed')
    // … and the combination is rejected rather than concealed
    const v = checkRoleEmploymentCompatibility({ role_type: 'CEO', current_status: 'employed', company: 'Independent' })
    expect(v.ok).toBe(false)
    expect(v.code).toBe('employed_requires_genuine_company')
  })

  it('company text is a fallback ONLY when current_status is null (legacy rows)', () => {
    expect(effectiveSituation({ current_status: null, company: 'Independent' })).toBe('independent')
    expect(effectiveSituation({ current_status: null, company: 'Between roles' })).toBe('between_roles')
    expect(effectiveSituation({ current_status: null, company: 'Armedia' })).toBe('employed')
    expect(effectiveSituation({ current_status: null, company: '' })).toBe('unknown')
  })

  it('legacy rows keep working: null status is never itself an error', () => {
    expect(ok({ role_type: 'CEO', current_status: null, company: '' })).toBe(true)
    expect(ok({ role_type: 'Advisor', current_status: null, company: 'Independent' })).toBe(true)
    expect(ok({ role_type: 'General Counsel', current_status: null, company: 'Armedia' })).toBe(true)
  })

  it('rendering and validation read the SAME interpretation', () => {
    const src = readFileSync('lib/profile/roleEmploymentCompatibility.ts', 'utf8')
    expect(src).toContain("import { companySituation, isPlaceholderCompany } from '@/lib/professionalIdentity'")
    expect(src).toContain('STORED current_status IS THE AUTHORITY')
  })

  it('an unrecognised stored value is unknown, not silently employed', () => {
    expect(effectiveSituation({ current_status: 'retired', company: 'Acme' })).toBe('unknown')
  })
})

// ── 2. THE THREE RULES ───────────────────────────────────────────────────────────────
describe('employed', () => {
  it('requires a genuine company', () => {
    expect(ok({ role_type: 'CEO', current_status: 'employed', company: 'Armedia' })).toBe(true)
    expect(ok({ role_type: 'CEO', current_status: 'employed', company: '' })).toBe(false)
  })

  it('rejects every placeholder company', () => {
    for (const c of ['Independent', 'Self-employed', 'N/A', 'None', 'Between roles', 'Freelance', 'Consultant']) {
      expect(ok({ role_type: 'CEO', current_status: 'employed', company: c }), c).toBe(false)
    }
  })

  it('is the only status compatible with an in-house role', () => {
    expect(ok({ role_type: 'General Counsel', current_status: 'employed', company: 'Armedia' })).toBe(true)
    for (const st of ['between_roles', 'consulting_advisory']) {
      expect(ok({ role_type: 'General Counsel', current_status: st, company: 'Armedia' }), st).toBe(false)
    }
  })
})

describe('between roles', () => {
  it('company is optional', () => {
    expect(ok({ role_type: 'Advisor', current_status: 'between_roles', company: '' })).toBe(true)
    expect(ok({ role_type: 'Advisor', current_status: 'between_roles', company: 'Armedia' })).toBe(true)
  })

  it('cannot present an in-house OR law-firm role as current', () => {
    expect(ok({ role_type: 'General Counsel', current_status: 'between_roles', company: 'Armedia' })).toBe(false)
    expect(ok({ role_type: 'Law Firm Partner', current_status: 'between_roles', company: 'Cravath' })).toBe(false)
  })

  it('guides toward a non-current identity WITHOUT promising a history record', () => {
    const m = checkRoleEmploymentCompatibility({ role_type: 'Law Firm Partner', current_status: 'between_roles', company: 'Cravath' }).message
    expect(m).toMatch(/Advisor, Consultant, or Other/)
    // The truthful explanation: the profile carries ONE role and presents it as current.
    expect(m).toMatch(/carries one role and presents it as a position you hold/)
    expect(m).toMatch(/cannot show a law-firm role while you are between roles/)
  })

  // ── NO UNBACKED PROMISE OF EMPLOYMENT HISTORY ───────────────────────────────────────────────
  // profiles.previous_roles exists, but it is member-typed in the profile editor only: it is
  // absent from both onboarding paths, and NOTHING in this flow writes to it or copies a role or
  // employer into it. Changing role_type preserves the old value nowhere. So no copy on this path
  // may tell a member their prior role is kept, saved, or stays in their history.
  it('no user-visible copy on this path promises that a prior role is preserved', () => {
    const claim = /(stay|stays|stayed|kept|keep it in|preserv|retain|remains in|saved in|is stored)[^.]{0,40}\b(history|record)\b|\bhistory\b[^.]{0,30}\b(stays|is kept|is saved|is preserved)/i
    const messages = [
      checkRoleEmploymentCompatibility({ role_type: 'General Counsel', current_status: 'between_roles', company: 'Armedia' }).message,
      checkRoleEmploymentCompatibility({ role_type: 'Law Firm Partner', current_status: 'between_roles', company: 'Cravath' }).message,
      checkRoleEmploymentCompatibility({ role_type: 'General Counsel', current_status: 'consulting_advisory', company: 'Acme' }).message,
      checkRoleEmploymentCompatibility({ role_type: 'General Counsel', current_status: 'employed', company: 'Independent' }).message,
      betweenRolesCompanyPrompt({ nextStatus: 'between_roles', company: 'Armedia' }) ?? '',
      ...EMPLOYMENT_STATUS_OPTIONS.flatMap(o => [o.label, o.description, o.companyLabel, o.companyHint]),
    ]
    for (const m of messages) expect(m, m).not.toMatch(claim)
    // and no rendered string anywhere in the two client copy sources
    for (const [n, s] of [['field', FIELD], ['options', readFileSync('lib/profile/employmentStatus.ts', 'utf8')]] as const) {
      expect(s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''), n).not.toMatch(/\bhistory\b/i)
    }
  })

  it('the between-roles option describes the display, not a saved record', () => {
    const o = EMPLOYMENT_STATUS_OPTIONS.find(x => x.value === 'between_roles')!
    expect(o.description).toBe('You are not in a position right now. Your profile will not name a current employer.')
    expect(o.companyHint).toBe('Shown as previous, never as somewhere you currently work.')
  })

  it('never silently erases a populated company — it asks', () => {
    const p = betweenRolesCompanyPrompt({ nextStatus: 'between_roles', company: 'Armedia' })
    expect(p).toContain('Armedia')
    expect(p).toMatch(/worked previously, not where you work now/)
    expect(p).toMatch(/Keep it[\s\S]*or\s+clear it/)
    expect(betweenRolesCompanyPrompt({ nextStatus: 'between_roles', company: '' })).toBeNull()
    expect(betweenRolesCompanyPrompt({ nextStatus: 'employed', company: 'Armedia' })).toBeNull()
    // and no client or server path clears it
    for (const [n, s] of [['field', FIELD], ['form', FORM], ['step1', STEP1], ['edit', EDIT]] as const) {
      expect(s, n).not.toMatch(/setCompany\(''\)|setCompanyValue\(''\)|company:\s*null/)
    }
  })
})

describe('consulting / advisory', () => {
  it('accepts advisor, consultant, fractional and other', () => {
    for (const r of ['Advisor', 'Consultant', 'Professional Services Executive', 'Other']) {
      expect(ok({ role_type: r, current_status: 'consulting_advisory', company: '' }), r).toBe(true)
      expect(ok({ role_type: r, current_status: 'consulting_advisory', company: 'Fractional' }), r).toBe(true)
    }
  })

  it('still rejects an in-house role', () => {
    expect(ok({ role_type: 'In-House Counsel', current_status: 'consulting_advisory', company: 'Armedia' })).toBe(false)
  })

  it('allows a law-firm role ONLY with a genuinely named practice', () => {
    expect(ok({ role_type: 'Law Firm Partner', current_status: 'consulting_advisory', company: 'Wittenberg Law' })).toBe(true)
    expect(ok({ role_type: 'Law Firm Partner', current_status: 'consulting_advisory', company: 'Independent' })).toBe(false)
    expect(ok({ role_type: 'Law Firm Partner', current_status: 'consulting_advisory', company: '' })).toBe(false)
  })

  it('does not imply every independent legal professional is a law-firm lawyer', () => {
    const m = checkRoleEmploymentCompatibility({ role_type: 'Law Firm Partner', current_status: 'consulting_advisory', company: 'Independent' }).message
    expect(m).toMatch(/Independent legal work does not have to be filed as a law-firm role/)
  })
})

// ── 3. ONE VOCABULARY ────────────────────────────────────────────────────────────────
describe('one shared vocabulary', () => {
  it('is exactly the three values already stored', () => {
    expect(EMPLOYMENT_STATUSES).toEqual(['employed', 'between_roles', 'consulting_advisory'])
    expect(EMPLOYMENT_STATUS_OPTIONS.map(o => o.value)).toEqual([...EMPLOYMENT_STATUSES])
    for (const v of EMPLOYMENT_STATUSES) expect(isEmploymentStatus(v)).toBe(true)
    for (const v of ['independent', 'self_employed', 'retired', '', null]) expect(isEmploymentStatus(v)).toBe(false)
  })

  it('every option carries a label, description and company requirement', () => {
    for (const o of EMPLOYMENT_STATUS_OPTIONS) {
      expect(o.label.length, o.value).toBeGreaterThan(3)
      expect(o.description.length, o.value).toBeGreaterThan(10)
      expect(['required', 'optional']).toContain(o.company)
      expect(o.companyLabel.length, o.value).toBeGreaterThan(3)
    }
    expect(employmentStatusOption('employed')!.company).toBe('required')
    expect(employmentStatusOption('between_roles')!.company).toBe('optional')
    expect(employmentStatusOption('consulting_advisory')!.company).toBe('optional')
  })

  it('no surface defines a second option list', () => {
    for (const [n, s] of [['field', FIELD], ['edit', EDIT], ['admin', ADMIN]] as const) {
      expect(s, n).toContain('EMPLOYMENT_STATUS_OPTIONS')
      expect(s, n).not.toMatch(/<option value="between_roles"|<option value="consulting_advisory"/)
    }
  })

  it('the client preview is the SAME function the server validates with', () => {
    const mod = readFileSync('lib/profile/employmentStatus.ts', 'utf8')
    expect(mod).toContain('return checkRoleEmploymentCompatibility(input)')
    for (const bad of ['Independent', '']) {
      const a = previewCompatibility({ role_type: 'General Counsel', current_status: 'employed', company: bad })
      const b = checkRoleEmploymentCompatibility({ role_type: 'General Counsel', current_status: 'employed', company: bad })
      expect(a).toEqual(b)
    }
  })
})

// ── 4. ONBOARDING ────────────────────────────────────────────────────────────────────
describe('onboarding collects status on both live paths', () => {
  it('renders the field and submits the value', () => {
    for (const [n, s] of [['OnboardingForm', FORM], ['OnboardingStep1', STEP1]] as const) {
      expect(s, n).toContain('<EmploymentStatusField')
      expect(s, n).toMatch(/current_status/)
    }
    expect(FORM).toContain("fd.append('current_status', currentStatus)")
    expect(STEP1).toContain("formData.set('current_status', currentStatus)")
  })

  it('requires a choice before advancing, and checks the same verdict client-side', () => {
    expect(FORM).toContain("if (!isEmploymentStatus(currentStatus)) { setError('Please choose your employment status'); return }")
    expect(FORM).toContain('const v = previewCompatibility({ role_type: roleType, current_status: currentStatus, company: company.trim() })')
    expect(FORM).toMatch(/if \(!v\.ok\) \{ setError\(v\.message\); return \}/)
  })

  it('requires a company ONLY when employed', () => {
    expect(FORM).toContain("if (currentStatus === 'employed' && company.trim().length < 2)")
    expect(FORM).not.toMatch(/if \(company\.trim\(\)\.length < 2\) \{ setError\('Please enter your company/)
    expect(STEP1).toContain("required={currentStatus === 'employed'}")
  })

  it('the company label follows the status, and no longer invites placeholder text', () => {
    for (const [n, s] of [['OnboardingForm', FORM], ['OnboardingStep1', STEP1]] as const) {
      expect(s, n).toContain('employmentStatusOption(currentStatus)?.companyLabel')
      expect(s, n).not.toMatch(/Independent, Self-employed, Retired, or Between roles/)
    }
  })

  it('the server persists it present-only, so an older client cannot clear it', () => {
    expect(ACTIONS).toMatch(/\.\.\.\(formData\.has\('current_status'\) && \{/)
  })

  it('the server validates the SUBMITTED status, not a null placeholder', () => {
    const onb = ACTIONS.slice(ACTIONS.indexOf('export async function completeOnboarding'))
    expect(onb).toMatch(/current_status: \(\(formData\.get\('current_status'\) as string\) \|\| ''\)\.trim\(\) \|\| null/)
  })

  it('a partially-completed profile resumes with what it already stored', () => {
    expect(STEP1).toContain("useState<string>(profile?.current_status || '')")
    expect(STEP1).toContain("useState<string>(profile?.company || '')")
  })
})

// ── 5. THE FIELD ─────────────────────────────────────────────────────────────────────
describe('the employment-status field', () => {
  it('is keyboard-native radios with visible focus, not clickable divs', () => {
    expect(FIELD).toContain('type="radio"')
    expect(FIELD).toContain('<fieldset>')
    expect(FIELD).toContain('<legend')
    expect(FIELD).toContain('focus-within:ring-2')
    expect(FIELD).not.toMatch(/<div[^>]*onClick/)
  })

  it('explains the conflict beside the field, with the right roles', () => {
    expect(FIELD).toContain('role="alert"')
    expect(FIELD).toContain('verdict.message')
    expect(FIELD).toContain('betweenPrompt')
  })

  it('cannot overflow a 320px phone', () => {
    expect((FIELD.match(/min-w-0/g) || []).length).toBeGreaterThanOrEqual(4)
    expect((FIELD.match(/break-words/g) || []).length).toBeGreaterThanOrEqual(4)
    expect(FIELD).toContain('flex flex-col')
    expect(FIELD).not.toMatch(/whitespace-nowrap|overflow-x-auto|w-\[\d{3,}px\]/)
  })
})

// ── 6. Editing surfaces + server authority ───────────────────────────────────────────
describe('editing surfaces', () => {
  it('profile edit shows the same verdict and prompt', () => {
    expect(EDIT).toContain('previewCompatibility')
    expect(EDIT).toContain('betweenRolesCompanyPrompt')
  })

  it('admin edit reuses the vocabulary and is still validated server-side', () => {
    expect(ADMIN).toContain('EMPLOYMENT_STATUS_OPTIONS')
    const adm = ACTIONS.slice(ACTIONS.indexOf('export async function adminUpdateUser'))
    expect(adm).toContain('checkRoleEmploymentCompatibility')
  })

  it('the server remains the authority on every path', () => {
    expect(readFileSync('lib/profile/updatePayload.ts', 'utf8')).toContain('checkRoleEmploymentCompatibility')
    expect(ACTIONS.match(/checkRoleEmploymentCompatibility/g)!.length).toBeGreaterThanOrEqual(3)
  })

  it('viewing the app never triggers the rule — only writes do', () => {
    // the checker is imported by write paths only; no page or layout reads it
    for (const f of ['app/dashboard/network/page.tsx', 'app/dashboard/introductions/page.tsx']) {
      expect(readFileSync(f, 'utf8'), f).not.toContain('checkRoleEmploymentCompatibility')
    }
  })
})

// ── 6a. "Self" — the production incident ──────────────────────────────────────────────
// A member stored company = "Self" with an employed status. The validator rejected it correctly,
// but the Nicholas audit kept its OWN short placeholder list that lacked 'self', so it reported
// company_is_genuine: true. There is now one vocabulary and one precedence, shared by rendering,
// validation and both SQL artifacts.
describe('"Self" is a placeholder, not an employer', () => {
  const genuine = (c: string) => hasGenuineCompany(c)

  it('catches the standalone placeholder, case-insensitively and whitespace-normalised', () => {
    for (const c of ['Self', 'self', 'SELF', 'SeLf', ' Self ', '  self  ', '\tSelf\n', 'Self.']) {
      expect(companySituation(c), c).toBe('independent')
      expect(isPlaceholderCompany(c), c).toBe(true)
      expect(genuine(c), c).toBe(false)
    }
  })

  it('catches Self-employed in every spelling', () => {
    // norm() strips ASCII punctuation including the hyphen; an EN/EM dash is not stripped, so
    // "Self — Employed" is out of scope here. Widening norm() would change matching for every
    // company string, and this change is scoped to the standalone "Self" placeholder.
    for (const c of ['Self-employed', 'self employed', 'Selfemployed', 'SELF-EMPLOYED', 'Self_employed']) {
      expect(companySituation(c), c).toBe('independent')
      expect(genuine(c), c).toBe(false)
    }
  })

  it('PRESERVES genuine companies whose real name contains the word', () => {
    for (const c of ['Self Financial', 'Self Financial, Inc.', 'Selfridges', 'Self Esteem Brands',
                     'Myself', 'Self Storage Group', 'Self Help Federal Credit Union']) {
      expect(companySituation(c), c).toBe('employed')
      expect(isPlaceholderCompany(c), c).toBe(false)
      expect(genuine(c), c).toBe(true)
    }
  })

  it('rejects employed + Self', () => {
    const v = checkRoleEmploymentCompatibility({ role_type: 'Other', current_status: 'employed', company: 'Self' })
    expect(v.ok).toBe(false)
    expect(v.code).toBe('employed_requires_genuine_company')
    expect(v.message).toMatch(/working arrangement rather than an employer/)
  })

  it('rejects an in-house role + Self', () => {
    for (const r of ['General Counsel', 'Corporate Counsel', 'Chief Legal Officer']) {
      const v = checkRoleEmploymentCompatibility({ role_type: r, current_status: 'employed', company: 'Self' })
      expect(v.ok, r).toBe(false)
      expect(v.code, r).toBe('in_house_requires_company')
    }
  })

  it('resolves a LEGACY null-status row with company Self as independent', () => {
    expect(effectiveSituation({ role_type: 'Other', current_status: null, company: 'Self' })).toBe('independent')
    expect(effectiveSituation({ role_type: 'Other', company: 'Self' })).toBe('independent')
    // and an in-house role on such a row is refused as independent, not as "no employer"
    const v = checkRoleEmploymentCompatibility({ role_type: 'General Counsel', current_status: null, company: 'Self' })
    expect(v.code).toBe('in_house_requires_employment')
  })

  it('the vocabulary entry itself is present and standalone-only', () => {
    const src = readFileSync('lib/professionalIdentity.ts', 'utf8')
    const set = src.slice(src.indexOf('INDEPENDENT_EXACT'), src.indexOf('BETWEEN_EXACT'))
    expect(set).toContain("'self'")
    // NOT added to the prefix regex — that would swallow "Self Financial"
    expect(src).toMatch(/\^\(independent\|freelance\|self employed\|selfemployed\|fractional\)/)
    expect(src).not.toMatch(/\^\([^)]*\|self\|[^)]*\)/)
  })
})

// ── 6a-ii. Nicholas: incompatible before, compatible after ────────────────────────────
describe("Nicholas Wittenberg's row, before and after the repair", () => {
  // Exactly the values the production audit returned.
  const before = { role_type: 'Other', exact_job_title: 'Corporate Counsel', title: 'Corporate Counsel',
                   company: 'Self', current_status: 'employed' }
  const after  = { role_type: 'In-House Counsel', exact_job_title: 'Corporate Counsel', title: 'Corporate Counsel',
                   company: 'Armedia', current_status: 'employed' }

  it('the CURRENT values are incompatible', () => {
    const v = checkRoleEmploymentCompatibility(before)
    expect(v.ok).toBe(false)
    expect(v.code).toBe('employed_requires_genuine_company')
  })

  it('the TARGET values are compatible', () => {
    expect(checkRoleEmploymentCompatibility(after).ok).toBe(true)
  })

  it('the target renders exactly "Corporate Counsel at Armedia"', () => {
    expect(professionalIdentity(after).primary).toBe('Corporate Counsel at Armedia')
  })

  it('and the current row never renders a placeholder as an employer', () => {
    const id = professionalIdentity(before)
    expect(id.primary).not.toMatch(/ at Self/)
    expect(id.primary).toBe('Corporate Counsel')
  })

  // The stored status is the authority in RENDERING too — this is the row that used to expose the
  // divergence, rendering "Independent Corporate Counsel" while validation said 'employed'.
  it('rendering and validation agree on the situation', () => {
    expect(effectiveSituation(before)).toBe('employed')
    expect(readFileSync('lib/professionalIdentity.ts', 'utf8'))
      .toMatch(/case 'employed': return 'employed'/)
  })
})

// ── 6b. The census SQL must mirror the TypeScript, or it reports the wrong thing ──────
describe('compatibility census ↔ code parity', () => {
  const CENSUS = readFileSync('supabase/audits/role_employment_compatibility_census.sql', 'utf8')
  const NAUDIT = readFileSync('supabase/audits/nicholas_wittenberg_profile_audit.sql', 'utf8')
  const IDENT = readFileSync('lib/professionalIdentity.ts', 'utf8')
  const COMPAT = readFileSync('lib/profile/roleEmploymentCompatibility.ts', 'utf8')

  // A plain exec loop: spreading matchAll needs downlevelIteration in this tsconfig.
  const quoted = (src: string): string[] => {
    const re = /'([^']*)'/g
    const out: string[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) out.push(m[1])
    return out
  }

  const tsSet = (name: string) => {
    const m = IDENT.match(new RegExp(`${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`))!
    return quoted(m[1]).sort()
  }
  const arrayIn = (src: string, label: string) => {
    const i = src.indexOf(`AS ${label}`)
    expect(i, label).toBeGreaterThan(-1)
    const start = src.lastIndexOf('ARRAY[', i)
    return quoted(src.slice(start, i)).map(x => x.replace(/''/g, "'")).sort()
  }
  const sqlArray = (label: string) => arrayIn(CENSUS, label)

  // BOTH SQL artifacts, not just the census. The Nicholas audit used to keep its own short list,
  // which lacked 'self' among 25 other values, and so reported a company of "Self" as genuine.
  const SQL_FILES: ReadonlyArray<readonly [string, string]> =
    [['census', CENSUS], ['nicholas audit', NAUDIT]]

  it('BOTH SQL artifacts carry the SAME placeholder vocabulary as professionalIdentity', () => {
    for (const [name, src] of SQL_FILES) {
      expect(arrayIn(src, 'ph_independent'), name).toEqual(tsSet('INDEPENDENT_EXACT'))
      expect(arrayIn(src, 'ph_between'), name).toEqual(tsSet('BETWEEN_EXACT'))
      expect(arrayIn(src, 'ph_retired'), name).toEqual(tsSet('RETIRED_EXACT'))
      expect(arrayIn(src, 'ph_confidential'), name).toEqual(tsSet('CONFIDENTIAL_EXACT'))
      expect(arrayIn(src, 'ph_stealth'), name).toEqual(tsSet('STEALTH_EXACT'))
    }
  })

  it("neither SQL artifact keeps a private ad-hoc placeholder list", () => {
    for (const [name, src] of SQL_FILES) {
      // the old shape: an inline NOT IN (...) list of placeholder company strings. Matched by a
      // pair only that list contained — 'independent' followed by a self-employment spelling.
      // (`NOT IN ('independent','between_roles')` is the effective_situation filter, not a list.)
      expect(src, name).not.toMatch(/NOT IN\s*\(\s*'independent'\s*,\s*'self[ -]?employed'/i)
      expect(arrayIn(src, 'ph_independent'), name).toContain('self')
    }
  })

  it('BOTH carry the SAME role families as the compatibility module', () => {
    const tsRoles = (name: string) => {
      const m = COMPAT.match(new RegExp(`${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`))!
      return quoted(m[1]).sort()
    }
    for (const [name, src] of SQL_FILES) {
      expect(arrayIn(src, 'in_house'), name).toEqual(tsRoles('IN_HOUSE_LEGAL_ROLES'))
      expect(arrayIn(src, 'law_firm'), name).toEqual(tsRoles('LAW_FIRM_ROLES'))
    }
  })

  it('BOTH apply the stored-status-wins precedence', () => {
    for (const [name, src] of SQL_FILES) {
      const sit = src.slice(src.indexOf('AS effective_situation') - 900, src.indexOf('AS effective_situation'))
      expect(sit, name).toMatch(/WHEN 'employed'\s+THEN 'employed'/)
      expect(sit, name).toMatch(/WHEN 'consulting_advisory' THEN 'independent'/)
      expect(sit, name).toMatch(/WHEN '' THEN CASE c\.company_situation/)
    }
  })

  it('applies the SAME precedence: stored status wins, company is the legacy fallback', () => {
    const sit = CENSUS.slice(CENSUS.indexOf('AS has_genuine_company'), CENSUS.indexOf('AS effective_situation'))
    expect(sit).toMatch(/WHEN 'employed'\s+THEN 'employed'/)
    expect(sit).toMatch(/WHEN 'between_roles'\s+THEN 'between_roles'/)
    expect(sit).toMatch(/WHEN 'consulting_advisory' THEN 'independent'/)
    expect(sit).toMatch(/WHEN '' THEN CASE c\.company_situation/)   // company only when unset
    expect(sit).toMatch(/ELSE 'unknown'/)
  })

  it('has one bucket per enforced rule, and counts a blank role as OK', () => {
    for (const b of ['in_house_role_but_presents_independent', 'in_house_role_but_between_roles',
                     'in_house_role_without_a_named_employer', 'law_firm_role_but_between_roles',
                     'law_firm_role_without_a_firm_name',
                     'any_other_role_employed_without_a_genuine_employer']) {
      expect(CENSUS, b).toContain(`'${b}'`)
    }
    // the code returns OK immediately for a blank role; the census must not count those
    expect(CENSUS).toMatch(/FILTER \(WHERE role <> ''/)
    expect(COMPAT).toMatch(/if \(!role\) return OK/)
    // NULL-safety: an empty company yields a NULL situation, and a NULL would drop the row
    expect(CENSUS).toContain("company_situation IS NOT DISTINCT FROM 'employed'")
  })

  it('is aggregate-only and read-only', () => {
    expect(CENSUS).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE)\b/im)
    // strip comments AND string literals — the reading_notes legitimately say the words "email"
    // and "bio" while promising not to emit them
    const out = CENSUS.slice(CENSUS.indexOf('SELECT jsonb_pretty'))
      .replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''")
    for (const w of ['p.id', 'email', 'full_name', 'bio', 'avatar_url']) {
      expect(out, w).not.toContain(w)
    }
  })
})

// ── 7. Nicholas artifacts ────────────────────────────────────────────────────────────
describe('Nicholas audit and repair', () => {
  const AUDIT = readFileSync('supabase/audits/nicholas_wittenberg_profile_audit.sql', 'utf8')
  const REPAIR = readFileSync('supabase/repairs/nicholas_wittenberg_profile.PROPOSED.sql', 'utf8')

  it('the audit is read-only and emits no unrelated personal data', () => {
    expect(AUDIT).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT)\b/im)
    const out = AUDIT.slice(AUDIT.indexOf('SELECT jsonb_pretty')).replace(/'(?:[^']|'')*'/g, "''").replace(/--.*$/gm, '')
    for (const w of ['bio', 'avatar_url', 'location', 'phone', 'linkedin_url', 'city', 'state']) {
      expect(out, w).not.toMatch(new RegExp(`\\b${w}\\b`))
    }
  })

  it('it masks the email and makes duplicates obvious', () => {
    expect(AUDIT).toMatch(/left\(p\.email, 1\) \|\| '\*\*\*@' \|\| split_part/)
    expect(AUDIT).toContain("'match_count'")
    expect(AUDIT).toContain("'exactly_one_match'")
  })

  it('the repair ships gated false with exactly one gate', () => {
    expect((REPAIR.match(/^ {2}v_apply constant boolean := (false|true);$/gm) || []).length).toBe(1)
    expect(REPAIR).toMatch(/^ {2}v_apply constant boolean := false;$/m)
    expect(REPAIR).toContain('DRY RUN COMPLETE — NOTHING WAS KEPT')
    expect((REPAIR.match(/^COMMIT;$/gm) || []).length).toBe(1)
  })

  it('it refuses without a reviewed, pinned id and unless exactly one profile matches', () => {
    expect(REPAIR).toMatch(/c_expect_id constant uuid := NULL;/)
    expect(REPAIR).toContain('REPAIR REFUSED: c_expect_id is not set')
    expect(REPAIR).toMatch(/the audit search matches % profiles, not 1/)
    expect(REPAIR).toContain('FOR UPDATE')
  })

  it('it pins expected pre-repair values before writing', () => {
    expect(REPAIR).toContain('c_expect_full_name')
    expect(REPAIR).toContain('c_expect_email_domain')
    expect(REPAIR).toContain('The row changed since the audit')
  })

  // ── THE ROLE CORRECTION IS UNCONDITIONAL ────────────────────────────────────────────────────
  // role_type -> 'In-House Counsel' is the operator-authorized correction. A row storing Advisor
  // with employed status and a genuine company is perfectly COMPATIBLE and still wrong, so the
  // write must not be gated on compatibility (or on the old value at all).
  it('it sets role_type unconditionally, not only when the old value is incompatible', () => {
    const code = REPAIR.replace(/--[^\n]*/g, ' ')
    const set = code.slice(code.indexOf('UPDATE public.profiles'), code.indexOf('GET DIAGNOSTICS'))
    expect(set).toMatch(/role_type\s*=\s*c_role\s*,/)      // a plain assignment …
    expect(set).not.toMatch(/role_type\s*=\s*CASE/i)         // … not a conditional one
    expect(REPAIR).toMatch(/c_role\s+constant text := 'In-House Counsel';/)
  })

  it('it pins and verifies the audited PRE-REPAIR role_type, refusing on drift', () => {
    for (const c of ['c_expect_role_type', 'c_expect_company', 'c_expect_job_title', 'c_expect_status']) {
      expect(REPAIR, c).toMatch(new RegExp(`${c}\\s+constant text := '<PASTE FROM AUDIT>';`))
    }
    expect(REPAIR).toContain('the expected PRE-REPAIR values are not pasted')
    expect(REPAIR).toMatch(/role_type is "%" but the audit reported "%"/)
    // idempotency: the pin accepts EITHER the audited value OR the already-applied target
    expect(REPAIR).toMatch(/v_seen <> c_expect_role_type AND v_seen <> c_role/)
    // and the audit hands the operator those exact literals
    expect(AUDIT).toContain("'pins_to_paste'")
    expect(AUDIT).toContain("'c_expect_role_type'")
  })

  it('it preserves title — exact_job_title is the display authority', () => {
    const code = REPAIR.replace(/--[^\n]*/g, ' ')
    const set = code.slice(code.indexOf('UPDATE public.profiles'), code.indexOf('GET DIAGNOSTICS'))
    expect(set).not.toMatch(/\btitle\s*=/)                    // exact_job_title only
    expect(set).toMatch(/exact_job_title\s*=\s*c_title/)
    expect(REPAIR).toContain('title was modified')             // explicit abort
    expect(REPAIR).toMatch(/c_allowed[^;]*'exact_job_title'/)  // and title is not allowed to move
    expect(REPAIR).not.toMatch(/c_allowed[^;]*'title',/)
    // the app agrees: exact_job_title outranks title
    expect(readFileSync('lib/professionalIdentity.ts', 'utf8'))
      .toContain("(p.exact_job_title || p.title || p.role_type || '').trim()")
  })

  it('it verifies the canonical classification, not just the display string', () => {
    expect(REPAIR).toContain('the row is not exactly the authorized target')
    expect(REPAIR).toMatch(/btrim\(COALESCE\(v_row\.role_type,''\)\)\s+<> c_role/)
  })

  it('it changes only the four fields, and proves nothing else moved', () => {
    expect(REPAIR).toMatch(/c_allowed\s+constant text\[\] := ARRAY\['company','exact_job_title','role_type','current_status','updated_at'\]/)
    expect(REPAIR).toContain('fields outside the allowed set changed')
    for (const f of ['account_status', 'profile_complete', 'credits', 'matches', 'intro_requests']) {
      const code = REPAIR.replace(/--.*$/gm, ' ')
      expect(code, f).not.toMatch(new RegExp(`SET[^;]*${f}\\s*=`))
    }
  })

  it('it verifies the exact target display', () => {
    expect(REPAIR).toContain("v_display <> 'Corporate Counsel at Armedia'")
  })

  it('and the target display is what those values actually render', () => {
    const id = professionalIdentity({
      exact_job_title: 'Corporate Counsel', role_type: 'In-House Counsel',
      company: 'Armedia', current_status: 'employed',
    })
    expect(id.primary).toBe('Corporate Counsel at Armedia')
    expect(ok({ role_type: 'In-House Counsel', current_status: 'employed', company: 'Armedia' })).toBe(true)
  })
})

// ── 8. Unrelated behaviour ───────────────────────────────────────────────────────────
describe('unrelated behaviour unchanged', () => {
  it('profile completion still requires title, company and location only', () => {
    const route = readFileSync('app/api/profile/complete/route.ts', 'utf8')
    expect(route).toContain('Professional title is required.')
    expect(route).not.toMatch(/current_status/)
  })

  it('matching eligibility reads neither status nor role', () => {
    const el = readFileSync('lib/matching/eligibility.ts', 'utf8')
    expect(el).not.toMatch(/current_status|role_type/)
  })

  it('no migration was added', () => {
    expect(readFileSync('lib/profile/employmentStatus.ts', 'utf8')).not.toMatch(/ALTER TABLE|CREATE TABLE/)
  })
})
