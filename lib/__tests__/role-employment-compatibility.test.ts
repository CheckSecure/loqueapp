import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  checkRoleEmploymentCompatibility, effectiveSituation, hasGenuineCompany,
  isInHouseLegalRole, isLawFirmRole, IN_HOUSE_LEGAL_ROLES, LAW_FIRM_ROLES,
} from '@/lib/profile/roleEmploymentCompatibility'
import { professionalIdentity } from '@/lib/professionalIdentity'
import { resolveTitlePick } from '@/lib/searchable-titles'
import { titleToCategory } from '@/lib/role-taxonomy'

/**
 * "In-house" is an employment relationship. A profile cannot assert one and simultaneously present
 * as independent, consulting, or between roles.
 *
 * NOTE ON REPRESENTATION: there is no stored `independent` status. The vocabulary is
 * employed | between_roles | consulting_advisory. "Independent" is derived — from
 * consulting_advisory, or from a placeholder company. Both are tested, because the commonest real
 * case is an in-house title against a placeholder company.
 */
const ok = (i: any) => checkRoleEmploymentCompatibility(i).ok
const code = (i: any) => checkRoleEmploymentCompatibility(i).code
const msg = (i: any) => checkRoleEmploymentCompatibility(i).message

// ── 1. Role families ─────────────────────────────────────────────────────────────────
describe('role families', () => {
  it('recognises every named in-house legal role', () => {
    for (const r of ['General Counsel', 'Chief Legal Officer', 'In-House Counsel', 'In-house Counsel',
                     'Deputy General Counsel', 'Associate General Counsel', 'Corporate Counsel']) {
      expect(isInHouseLegalRole(r), r).toBe(true)
    }
    expect(IN_HOUSE_LEGAL_ROLES).toHaveLength(7)
  })

  it('recognises law-firm roles, and keeps them separate from in-house', () => {
    for (const r of ['Law Firm Partner', 'Law Firm Attorney', 'Law firm attorney']) {
      expect(isLawFirmRole(r), r).toBe(true)
      expect(isInHouseLegalRole(r), r).toBe(false)
    }
    expect(LAW_FIRM_ROLES).toHaveLength(3)
  })

  it('matches EXACTLY — "counsel" as a substring never triggers the rule', () => {
    for (const r of ['Of Counsel', 'Counsel to the Board', 'Legal Operations',
                     'Legal services professional', 'Advisor', 'Consultant', 'CEO', 'Other', '']) {
      expect(isInHouseLegalRole(r), r).toBe(false)
      expect(isLawFirmRole(r), r).toBe(false)
    }
  })
})

// ── 2. Effective situation ───────────────────────────────────────────────────────────
describe('effective employment situation', () => {
  it('reads the stored status vocabulary', () => {
    expect(effectiveSituation({ current_status: 'employed', company: 'Acme' })).toBe('employed')
    expect(effectiveSituation({ current_status: 'between_roles', company: 'Acme' })).toBe('between_roles')
    expect(effectiveSituation({ current_status: 'consulting_advisory', company: 'Acme' })).toBe('independent')
  })

  it('STORED STATUS is the authority — a placeholder company does not reinterpret it', () => {
    // Canonical precedence: the status wins. A placeholder company makes the combination INVALID
    // (reported to the member) rather than silently re-rendering them as independent.
    for (const c of ['Independent', 'Self-employed', 'Freelance', 'Fractional', 'Consultant',
                     'Sole Proprietor', 'Independent Contractor', 'Between roles']) {
      expect(effectiveSituation({ current_status: 'employed', company: c }), c).toBe('employed')
      expect(checkRoleEmploymentCompatibility({ role_type: 'CEO', current_status: 'employed', company: c }).ok, c).toBe(false)
    }
  })

  it('company text is the fallback only when no status is stored', () => {
    expect(effectiveSituation({ current_status: null, company: 'Independent' })).toBe('independent')
    expect(effectiveSituation({ current_status: null, company: 'Between roles' })).toBe('between_roles')
  })

  it('a real company with no status set is employed; nothing at all is unknown', () => {
    expect(effectiveSituation({ company: 'Armedia' })).toBe('employed')
    expect(effectiveSituation({ company: '' })).toBe('unknown')
    expect(effectiveSituation({})).toBe('unknown')
  })

  it('agrees with what the profile actually renders', () => {
    // the display layer and the rule read the same classifier, so they cannot disagree
    const id = professionalIdentity({ title: 'General Counsel', company: 'Independent' })
    expect(id.primary.toLowerCase()).toContain('independent')
    expect(effectiveSituation({ role_type: 'General Counsel', company: 'Independent' })).toBe('independent')
  })
})

// ── 3. In-house requires employment ──────────────────────────────────────────────────
describe('in-house legal roles require employment and an employer', () => {
  it.each(IN_HOUSE_LEGAL_ROLES)('%s + a real employer is fine', (role) => {
    expect(ok({ role_type: role, current_status: 'employed', company: 'Armedia' })).toBe(true)
    expect(ok({ role_type: role, current_status: null, company: 'Armedia' })).toBe(true)
  })

  it.each(IN_HOUSE_LEGAL_ROLES)('%s + consulting/advisory status is REJECTED', (role) => {
    const i = { role_type: role, current_status: 'consulting_advisory', company: 'Armedia' }
    expect(ok(i)).toBe(false)
    expect(code(i)).toBe('in_house_requires_employment')
  })

  it.each(IN_HOUSE_LEGAL_ROLES)('%s + a placeholder company is REJECTED', (role) => {
    const i = { role_type: role, current_status: 'employed', company: 'Independent' }
    expect(ok(i)).toBe(false)
    // status stays 'employed' (it is the authority), so the failure is the missing EMPLOYER
    expect(code(i)).toBe('in_house_requires_company')
  })

  it.each(IN_HOUSE_LEGAL_ROLES)('%s + consulting status + placeholder company is REJECTED', (role) => {
    const i = { role_type: role, current_status: 'consulting_advisory', company: 'Independent' }
    expect(ok(i)).toBe(false)
    expect(code(i)).toBe('in_house_requires_employment')
  })

  it.each(IN_HOUSE_LEGAL_ROLES)('%s + between roles is REJECTED', (role) => {
    const i = { role_type: role, current_status: 'between_roles', company: 'Armedia' }
    expect(ok(i)).toBe(false)
    expect(code(i)).toBe('in_house_requires_employment')
  })

  it.each(IN_HOUSE_LEGAL_ROLES)('%s with no employer at all is REJECTED', (role) => {
    const i = { role_type: role, current_status: 'employed', company: '' }
    expect(ok(i)).toBe(false)
    expect(code(i)).toBe('in_house_requires_company')
  })

  it('a between-roles member may omit company — just not while claiming in-house', () => {
    expect(ok({ role_type: 'Advisor', current_status: 'between_roles', company: '' })).toBe(true)
    expect(ok({ role_type: 'General Counsel', current_status: 'between_roles', company: '' })).toBe(false)
  })
})

// ── 4. Law-firm roles need a firm name; solo practitioners may be independent ────────
describe('law-firm roles require a firm or solo-practice name', () => {
  it('a named firm is fine', () => {
    expect(ok({ role_type: 'Law Firm Partner', current_status: 'employed', company: 'Cravath' })).toBe(true)
  })

  it('a genuine solo practitioner may use independent status, with a named practice', () => {
    expect(ok({ role_type: 'Law Firm Partner', current_status: 'consulting_advisory', company: 'Wittenberg Law' })).toBe(true)
    expect(ok({ role_type: 'Law firm attorney', current_status: 'consulting_advisory', company: 'Solo Practice LLC' })).toBe(true)
  })

  it('but the practice must be NAMED', () => {
    const i = { role_type: 'Law Firm Partner', current_status: 'employed', company: '' }
    expect(ok(i)).toBe(false)
    expect(code(i)).toBe('law_firm_requires_firm_name')
  })
})

// ── 5. Independent legal work belongs to Advisor / Consultant / Other ────────────────
describe('independent legal work has compatible roles', () => {
  it('Advisor, Consultant and Other accept independent presentation', () => {
    for (const r of ['Advisor', 'Consultant', 'Professional Services Executive', 'Other']) {
      expect(ok({ role_type: r, current_status: 'consulting_advisory', company: 'Independent' }), r).toBe(true)
      expect(ok({ role_type: r, current_status: 'consulting_advisory', company: '' }), r).toBe(true)
    }
  })

  it('a fractional GC must not use an in-house role', () => {
    expect(ok({ role_type: 'General Counsel', current_status: 'consulting_advisory', company: 'Fractional' })).toBe(false)
    expect(ok({ role_type: 'Advisor', current_status: 'consulting_advisory', company: 'Fractional' })).toBe(true)
  })
})

// ── 6. The message names BOTH ways out, and nothing is rewritten ─────────────────────
describe('guidance', () => {
  it('names the role, the contradiction, and both fixes', () => {
    const m = msg({ role_type: 'General Counsel', current_status: 'consulting_advisory', company: 'Acme' })
    expect(m).toContain('General Counsel')
    expect(m).toMatch(/in-house/i)
    expect(m).toMatch(/Currently employed/)          // fix A: change the status
    expect(m).toMatch(/Advisor, Consultant, or Other/) // fix B: change the role
  })

  it('the between-roles message explains the display truthfully, promising no history record', () => {
    const m = msg({ role_type: 'Chief Legal Officer', current_status: 'between_roles', company: 'Acme' })
    // TRUTH: the profile carries one role and shows it as current — that is why this combination
    // is refused. Nothing in this flow writes to profiles.previous_roles, so nothing may claim it.
    expect(m).toMatch(/carries one role and presents it as a position you hold now/)
    expect(m).toMatch(/cannot show an in-house role while you are between roles/)
    expect(m).not.toMatch(/history/i)
    expect(m).toMatch(/Currently employed/)
    expect(m).toMatch(/Advisor, Consultant, or Other/)
  })

  it('never rewrites: the verdict carries no corrected value', () => {
    const v = checkRoleEmploymentCompatibility({ role_type: 'General Counsel', current_status: 'consulting_advisory' })
    expect(Object.keys(v).sort()).toEqual(['code', 'message', 'ok'])
    const src = readFileSync('lib/profile/roleEmploymentCompatibility.ts', 'utf8')
    expect(src).not.toMatch(/role_type\s*=|payload\.|\.update\(|\.insert\(/)
  })

  it('says nothing about roles it has no rule for', () => {
    for (const r of ['CEO', 'Investor', 'CTO', 'Executive Recruiter', 'In-House Talent Leader', 'Head of Talent']) {
      expect(ok({ role_type: r, current_status: 'consulting_advisory', company: 'Independent' }), r).toBe(true)
    }
  })
})

// ── 7. Server-side enforcement at every write path ───────────────────────────────────
describe('server-side enforcement', () => {
  const PAYLOAD = readFileSync('lib/profile/updatePayload.ts', 'utf8')
  const ROUTE = readFileSync('app/api/profile/update/route.ts', 'utf8')
  const ACTIONS = readFileSync('app/actions.ts', 'utf8')

  it('the shared payload builder rejects, and returns the guidance verbatim', () => {
    expect(PAYLOAD).toContain('checkRoleEmploymentCompatibility')
    expect(PAYLOAD).toMatch(/if \(!verdict\.ok\) return \{ error: verdict\.message \}/)
  })

  it('it evaluates the MERGED row, not just the submitted fields', () => {
    expect(PAYLOAD).toMatch(/'role_type' in payload \? \(payload\.role_type as string \| null\) : ctx\.current\.role_type/)
    expect(PAYLOAD).toMatch(/'current_status' in payload/)
    expect(PAYLOAD).toMatch(/'company' in payload/)
  })

  it('the profile-update route supplies the stored row only when it is needed', () => {
    expect(ROUTE).toMatch(/formData\.has\('role_type'\) \|\| formData\.has\('current_status'\) \|\| formData\.has\('company'\)/)
    expect(ROUTE).toContain('current: currentIdentity')
    expect(ROUTE).toMatch(/\.select\('role_type, current_status, company'\)/)
  })

  it('onboarding rejects an in-house role against a placeholder or absent employer', () => {
    const onb = ACTIONS.slice(ACTIONS.indexOf('export async function completeOnboarding'))
    expect(onb).toContain('checkRoleEmploymentCompatibility')
    expect(onb).toMatch(/if \(!verdict\.ok\) return \{ error: verdict\.message \}/)
  })

  it('an ADMIN status change cannot create the contradiction either', () => {
    const adm = ACTIONS.slice(ACTIONS.indexOf('export async function adminUpdateUser'))
    expect(adm).toContain('checkRoleEmploymentCompatibility')
    expect(adm).toMatch(/\.select\('role_type, company'\)/)
  })

  it('no write path silently rewrites the role', () => {
    for (const [name, src] of [['payload', PAYLOAD], ['route', ROUTE], ['actions', ACTIONS]] as const) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
      expect(code, name).not.toMatch(/verdict[\s\S]{0,120}role_type\s*=/)
    }
  })
})

// ── 8. Corporate Counsel and the named display ───────────────────────────────────────
describe('Corporate Counsel', () => {
  it('resolves to the canonical in-house role, keeping the label as the shown title', () => {
    const r = resolveTitlePick('Corporate Counsel')
    expect(r).not.toBeNull()
    expect(r!.role_type).toBe('In-House Counsel')
    expect(r!.exact_job_title).toBe('Corporate Counsel')
    expect(titleToCategory(r!.role_type)).toBe('Legal')
  })

  it('is treated as in-house by the compatibility rule', () => {
    expect(isInHouseLegalRole('In-House Counsel')).toBe(true)
    expect(ok({ role_type: 'In-House Counsel', current_status: 'employed', company: 'Armedia' })).toBe(true)
    expect(ok({ role_type: 'In-House Counsel', current_status: 'consulting_advisory', company: 'Armedia' })).toBe(false)
  })

  it('renders as "Corporate Counsel at <employer>" for an employed member', () => {
    const id = professionalIdentity({
      exact_job_title: 'Corporate Counsel', role_type: 'In-House Counsel',
      company: 'Armedia', current_status: 'employed',
    })
    expect(id.primary).toBe('Corporate Counsel at Armedia')
  })
})

// ── 9. The aggregate audit changes nothing ───────────────────────────────────────────
describe('the existing-member audit is read-only and aggregate', () => {
  const SQL = readFileSync('supabase/audits/role_employment_compatibility_census.sql', 'utf8')

  it('writes nothing', () => {
    expect(SQL).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT)\b/im)
    expect(SQL).not.toMatch(/FOR UPDATE|FOR SHARE/i)
  })

  it('emits no identity', () => {
    const out = SQL.slice(SQL.indexOf('SELECT jsonb_pretty')).replace(/'(?:[^']|'')*'/g, "''").replace(/--.*$/gm, '')
    for (const w of ['full_name', 'email', 'bio', 'avatar_url', 'exact_job_title']) {
      expect(out, w).not.toMatch(new RegExp(`\\b${w}\\b`))
    }
  })

  it('reports the four rules the write paths enforce', () => {
    for (const k of ['in_house_role_but_presents_independent', 'in_house_role_but_between_roles',
                     'in_house_role_without_a_named_employer', 'law_firm_role_without_a_firm_name']) {
      expect(SQL, k).toContain(k)
    }
  })

  it('states plainly that it reclassifies nobody', () => {
    expect(SQL).toMatch(/reclassifies nobody|Nothing here reclassifies anyone/)
  })
})
