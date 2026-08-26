import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ROLE_CATEGORIES, titleToCategory, isStructuredTitle, type Category } from '@/lib/role-taxonomy'
import { TITLE_ALIASES, resolveTitlePick } from '@/lib/searchable-titles'
import { isBusinessSolutionProvider, isLegalProfessional, isLegalNetworkingPair, EXPLICIT_PROVIDER_ROLE_TYPES } from '@/lib/matching/business-solutions'
import { lawFirmRole, legalSameSidePenalty } from '@/lib/matching/legalSameSidePenalty'
import { classifyPair, pairTypeCounts, isRecruiterRole, RECRUITER_ROLE_TYPES } from '@/lib/matching/globalBMatching'
import { isRecruiterRoleType, isExternalRecruiterRoleType, recruiterGuidance } from '@/lib/onboarding/recruiterGuidance'
import { BATCH_CONFIG } from '@/lib/matching/batch-scoring'

/**
 * Recruiter onboarding: two new role_type values, and the exact matching classification each gets.
 *
 * The census that authorised this found ONE probable recruiter in production, stored as 'Advisor',
 * with zero classifier collisions. Nothing here reclassifies that member: 'Advisor' still resolves
 * exactly as it did, and no code path rewrites a stored value.
 */
const EXTERNAL = 'Executive Recruiter'
const IN_HOUSE = 'In-House Talent Leader'
const rt = (v: string) => ({ role_type: v })

// ── 1. Taxonomy ──────────────────────────────────────────────────────────────────────
describe('taxonomy', () => {
  it('adds one category with exactly the two agreed values', () => {
    expect(Object.keys(ROLE_CATEGORIES)).toContain('Recruiting / Talent')
    expect(ROLE_CATEGORIES['Recruiting / Talent' as Category]).toEqual([EXTERNAL, IN_HOUSE])
  })

  it('both are structured titles that resolve to the new category', () => {
    for (const v of [EXTERNAL, IN_HOUSE]) {
      expect(isStructuredTitle(v), v).toBe(true)
      expect(titleToCategory(v), v).toBe('Recruiting / Talent')
    }
  })

  it('Head of Talent stays under HR / People, untouched', () => {
    expect(ROLE_CATEGORIES['HR / People' as Category]).toContain('Head of Talent')
    expect(titleToCategory('Head of Talent')).toBe('HR / People')
    expect(ROLE_CATEGORIES['Recruiting / Talent' as Category]).not.toContain('Head of Talent')
  })

  it('every pre-existing category and title is unchanged', () => {
    const expected: Record<string, number> = {
      'Legal': 7, 'Executive / C-Suite': 5, 'Finance': 5, 'HR / People': 4, 'Sales / Revenue': 4,
      'Marketing': 3, 'Operations': 2, 'Technology / Cybersecurity': 5,
      'Government Affairs / Policy': 3, 'Investor / Private Equity': 5, 'Healthcare': 2,
      'Consulting / Advisory': 3, 'Recruiting / Talent': 2,
    }
    for (const [cat, n] of Object.entries(expected)) {
      expect((ROLE_CATEGORIES[cat as Category] as readonly string[]).length, cat).toBe(n)
    }
    expect(Object.keys(ROLE_CATEGORIES)).toHaveLength(13)   // 12 + the new one
  })

  it('legacy values still resolve exactly as before — nobody is reclassified', () => {
    for (const [legacy, cat] of [
      ['Advisor', 'Consulting / Advisory'],          // the one probable production recruiter
      ['Law firm attorney', 'Legal'], ['In-house Counsel', 'Legal'],
      ['Legal services professional', 'Legal'], ['Investor / VC', 'Investor / Private Equity'],
      ['Executive / C-Suite', 'Executive / C-Suite'], ['Other', 'Other'],
    ] as const) {
      expect(titleToCategory(legacy), legacy).toBe(cat)
    }
    expect(titleToCategory('Sasquatch Wrangler')).toBeNull()   // unknown still round-trips as null
  })
})

// ── 2. Aliases and the module-load firewall ──────────────────────────────────────────
describe('searchable aliases', () => {
  it('the firewall holds: every alias resolves to a known role_type', () => {
    for (const e of TITLE_ALIASES) expect(titleToCategory(e.role_type), e.display).not.toBeNull()
  })

  it('typing "recruit" surfaces recruiter options', () => {
    const hits = TITLE_ALIASES.filter(e => e.display.toLowerCase().includes('recruit'))
    expect(hits.length).toBeGreaterThanOrEqual(4)
    expect(hits.every(e => RECRUITER_ROLE_TYPES.includes(e.role_type))).toBe(true)
  })

  it('typing "search consultant" and "talent" both surface options', () => {
    for (const q of ['search consultant', 'talent']) {
      const hits = TITLE_ALIASES.filter(e => e.display.toLowerCase().includes(q))
      expect(hits.length, q).toBeGreaterThan(0)
    }
  })

  it('the long user-facing label maps to the short canonical value', () => {
    const entry = TITLE_ALIASES.find(e => e.display === 'Executive Recruiter / Search Consultant')
    expect(entry).toBeDefined()
    expect(entry!.role_type).toBe(EXTERNAL)
    expect(entry!.category).toBe('Recruiting / Talent')
  })

  it('picking an alias persists the canonical role_type, with the label as exact_job_title', () => {
    const r = resolveTitlePick('Executive Recruiter / Search Consultant')
    expect(r).not.toBeNull()
    expect(r!.role_type).toBe(EXTERNAL)
    expect(r!.exact_job_title).toBe('Executive Recruiter / Search Consultant')
  })

  it('picking the canonical value directly stores it with no exact_job_title override', () => {
    for (const v of [EXTERNAL, IN_HOUSE]) {
      const r = resolveTitlePick(v)
      expect(r, v).not.toBeNull()
      expect(r!.role_type, v).toBe(v)
      expect(r!.exact_job_title, v).toBeNull()
    }
  })

  it('every recruiter alias resolves to one of exactly two canonical values', () => {
    const recruiterAliases = TITLE_ALIASES.filter(e => e.category === 'Recruiting / Talent')
    expect(recruiterAliases.length).toBeGreaterThanOrEqual(13)
    for (const e of recruiterAliases) expect([EXTERNAL, IN_HOUSE], e.display).toContain(e.role_type)
  })

  it('a legal recruiter is an Executive Recruiter, not a legal role', () => {
    expect(resolveTitlePick('Legal Recruiter')!.role_type).toBe(EXTERNAL)
  })
})

// ── 3. THE CLASSIFICATION MATRIX — all four pinned ───────────────────────────────────
describe('classification matrix', () => {
  const rows = [
    { role: EXTERNAL, provider: true,  legal: false, lawFirm: null },
    { role: IN_HOUSE, provider: false, legal: false, lawFirm: null },
  ] as const

  it.each(rows)('$role → provider=$provider legal=$legal lawFirm=$lawFirm', ({ role, provider, legal, lawFirm }) => {
    expect(isBusinessSolutionProvider(rt(role))).toBe(provider)
    expect(isLegalProfessional(rt(role))).toBe(legal)
    expect(lawFirmRole(rt(role))).toBe(lawFirm)
  })

  it('the external recruiter is a provider by EXACT match, not substring', () => {
    expect(EXPLICIT_PROVIDER_ROLE_TYPES).toEqual([EXTERNAL])
    // near-misses must NOT be swept in by the exact layer
    for (const near of ['Executive Recruiters', 'executive recruiter', 'Senior Executive Recruiter', 'Recruiter']) {
      expect(EXPLICIT_PROVIDER_ROLE_TYPES.includes(near), near).toBe(false)
    }
  })

  it('unrelated titles are not accidentally classified', () => {
    for (const v of ['Head of Talent', 'CHRO', 'Chief People Officer', 'HR Executive',
                     'General Counsel', 'CEO', 'Investor', 'Advisor', 'Other']) {
      expect(isRecruiterRole(rt(v)), v).toBe(false)
      expect(isRecruiterRoleType(v), v).toBe(false)
    }
  })

  it('existing provider and legal classifications are unchanged', () => {
    for (const v of ['Law Firm Partner', 'Consultant', 'Legal services professional', 'Legal Tech Founder']) {
      expect(isBusinessSolutionProvider(rt(v)), v).toBe(true)
    }
    for (const v of ['General Counsel', 'In-House Counsel', 'Law Firm Partner', 'Law firm attorney']) {
      expect(isLegalProfessional(rt(v)), v).toBe(true)
    }
    expect(lawFirmRole(rt('Law Firm Partner'))).toBe('partner')
    expect(lawFirmRole(rt('Law firm attorney'))).toBe('attorney')
    expect(isBusinessSolutionProvider(rt('CEO'))).toBe(false)
    expect(isLegalProfessional(rt('CEO'))).toBe(false)
  })

  it('neither recruiter is a legal-networking peer', () => {
    for (const v of [EXTERNAL, IN_HOUSE]) {
      expect(isLegalNetworkingPair(rt(v), rt('General Counsel')), v).toBe(false)
      expect(isLegalNetworkingPair(rt(v), rt('Law Firm Partner')), v).toBe(false)
    }
  })

  it('external vs in-house provider behaviour differs, which is the whole point', () => {
    expect(isBusinessSolutionProvider(rt(EXTERNAL))).toBe(true)
    expect(isBusinessSolutionProvider(rt(IN_HOUSE))).toBe(false)
  })

  it('neither incurs the same-side legal penalty against anyone', () => {
    for (const v of [EXTERNAL, IN_HOUSE]) {
      for (const other of ['Law Firm Partner', 'Law firm attorney', 'General Counsel', 'CEO', EXTERNAL, IN_HOUSE]) {
        expect(legalSameSidePenalty(rt(v), rt(other)), `${v}/${other}`).toBe(0)
      }
    }
  })
})

// ── 4. Cross-market ──────────────────────────────────────────────────────────────────
describe('cross-market classification', () => {
  const isLawFirm = (m: any) => lawFirmRole(m) !== null
  const legalPro = (m: any) => isLegalProfessional(m)
  const cp = (a: string, b: string) => classifyPair(rt(a), rt(b), isLawFirm, legalPro)

  it('a recruiter opposite a law firm is NOT the preferred exec cross-market pair', () => {
    for (const v of [EXTERNAL, IN_HOUSE]) {
      expect(cp('Law Firm Partner', v), v).toBe('law_firm__recruiter')
      expect(cp(v, 'Law firm attorney'), v).toBe('law_firm__recruiter')
      expect(cp('Law Firm Partner', v)).not.toBe('law_firm__exec_or_other')
    }
  })

  it('a real executive opposite a law firm KEEPS the preferred classification', () => {
    for (const v of ['CEO', 'Founder', 'Investor', 'CFO', 'Head of Talent']) {
      expect(cp('Law Firm Partner', v), v).toBe('law_firm__exec_or_other')
    }
  })

  it('every pre-existing pair type is byte-for-byte unchanged', () => {
    expect(cp('Law Firm Partner', 'Law firm attorney')).toBe('law_firm__law_firm')
    expect(cp('Law Firm Partner', 'General Counsel')).toBe('law_firm__in_house')
    expect(cp('Law Firm Partner', 'CEO')).toBe('law_firm__exec_or_other')
    expect(cp('General Counsel', 'CEO')).toBe('in_house__exec_or_other')
    expect(cp('CEO', 'Investor')).toBe('other')
  })

  it('recruiter opposite a non-legal member is its own bucket, never "other"', () => {
    expect(cp(EXTERNAL, 'CEO')).toBe('recruiter__other')
    expect(cp(IN_HOUSE, 'Investor')).toBe('recruiter__other')
    expect(cp(EXTERNAL, IN_HOUSE)).toBe('recruiter__other')
  })

  it('recruiter opposite in-house counsel keeps the in-house rule, not a recruiter bucket', () => {
    expect(cp('General Counsel', EXTERNAL)).toBe('in_house__exec_or_other')
  })

  it('pairTypeCounts reports the new buckets without losing the old ones', () => {
    const counts = pairTypeCounts(
      [{ userA: rt('Law Firm Partner'), userB: rt(EXTERNAL) },
       { userA: rt('Law Firm Partner'), userB: rt('CEO') },
       { userA: rt(EXTERNAL), userB: rt(IN_HOUSE) }] as any[],
      isLawFirm, legalPro)
    expect(counts.law_firm__recruiter).toBe(1)
    expect(counts.law_firm__exec_or_other).toBe(1)
    expect(counts.recruiter__other).toBe(1)
    expect(Object.keys(counts).sort()).toEqual([
      'in_house__exec_or_other', 'law_firm__exec_or_other', 'law_firm__in_house',
      'law_firm__law_firm', 'law_firm__recruiter', 'other', 'recruiter__other',
    ])
  })

  it('classification carries NO score adjustment — prioritisation must come from stated inputs', () => {
    const src = readFileSync('lib/matching/globalBMatching.ts', 'utf8')
    const fn = src.slice(src.indexOf('export function crossMarketAdjustment'), src.indexOf('export function legalPolicyAdjustment'))
    expect(fn).not.toMatch(/Recruiter|recruiter/)      // the score path never sees a recruiter
    expect(src).toMatch(/never from role_type alone/)
  })
})

// ── 5. Recruiter-to-recruiter ────────────────────────────────────────────────────────
describe('recruiter-to-recruiter', () => {
  it('is permitted — nothing forbids or penalises it', () => {
    expect(legalSameSidePenalty(rt(EXTERNAL), rt(EXTERNAL))).toBe(0)
    expect(legalSameSidePenalty(rt(IN_HOUSE), rt(IN_HOUSE))).toBe(0)
  })

  it('receives no special boost anywhere', () => {
    for (const f of ['lib/matching/batch-scoring.ts', 'lib/matching/globalBMatching.ts', 'lib/matching/legalSameSidePenalty.ts']) {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
      expect(code, f).not.toMatch(/score\s*\+=[^\n]*[Rr]ecruiter/)
    }
  })

  it('the existing batch diversity cap still applies to them', () => {
    expect(BATCH_CONFIG.maxSameRolePercent).toBe(0.4)   // unchanged
  })
})

// ── 6. Role scores ───────────────────────────────────────────────────────────────────
describe('role scores', () => {
  const src = readFileSync('lib/scoring.ts', 'utf8')
  /** Read a score from the map SOURCE, so an explicit entry is distinguishable from a fallback. */
  const explicit = (v: string): number | null => {
    const m = src.match(new RegExp(`'${v.replace(/[/&]/g, '\\$&')}':\\s*(\\d+)`))
    return m ? Number(m[1]) : null
  }
  /** What the map ACTUALLY yields, fallback included — mirrors `roleScores[x] ?? 40`. */
  const effective = (v: string): number => explicit(v) ?? 40

  it('Executive Recruiter = 65', () => {
    expect(explicit('Executive Recruiter')).toBe(65)
  })

  it('In-House Talent Leader = 40, through an EXPLICIT entry and not the fallback', () => {
    expect(explicit('In-House Talent Leader')).toBe(40)
    // the key is physically present in the map — remove it and this fails, even though the
    // effective value would be unchanged
    expect(src).toMatch(/'In-House Talent Leader':\s*40,/)
  })

  it('In-House Talent Leader is NOT scored above the HR/People cohort', () => {
    for (const hr of ['CHRO', 'Chief People Officer', 'Head of Talent', 'HR Executive']) {
      expect(effective('In-House Talent Leader'), hr).toBeLessThanOrEqual(effective(hr))
    }
    // and specifically: no advantage at all — the new label confers nothing
    expect(effective('In-House Talent Leader')).toBe(effective('CHRO'))
  })

  it('the HR/People cohort itself is untouched — still no explicit entries', () => {
    for (const hr of ['CHRO', 'Chief People Officer', 'Head of Talent', 'HR Executive']) {
      expect(explicit(hr), hr).toBeNull()
    }
  })

  it('the external recruiter gets NO advantage over other external providers', () => {
    expect(explicit('Executive Recruiter')).toBe(explicit('Consultant'))   // identical, never higher
  })

  it('neither recruiter value outranks an executive member', () => {
    for (const exec of ['Executive / C-Suite', 'Investor', 'Founder / Entrepreneur']) {
      expect(effective('Executive Recruiter'), exec).toBeLessThan(effective(exec))
      expect(effective('In-House Talent Leader'), exec).toBeLessThan(effective(exec))
    }
  })

  it('every pre-existing score is unchanged', () => {
    for (const [v, n] of [['Executive / C-Suite', 100], ['Investor', 90], ['Founder / Entrepreneur', 85],
                          ['Law firm attorney', 80], ['In-house attorney', 75],
                          ['Legal services professional', 70], ['Consultant', 65], ['Other', 40]] as const) {
      expect(explicit(v), v).toBe(n)
    }
    // exactly two keys were added — scoped to the roleScores object, since scoring.ts holds
    // several other numeric maps (tier, priority, seniority)
    const block = src.slice(src.indexOf('const roleScores'), src.indexOf('const roleRaw'))
    const keys = (block.match(/^\s*'[^']+':\s*\d+,$/gm) || []).length
    expect(keys).toBe(10)   // 8 pre-existing + Executive Recruiter + In-House Talent Leader
  })

  it('the explicit 40 is explained, and the cohort review is recorded as a follow-up', () => {
    expect(src).toMatch(/HR \/ People baseline/)
    expect(src).toMatch(/stated as a decision rather than reached by omission/)
    expect(src).toContain('docs/FOLLOWUP_HR_PEOPLE_ROLE_SCORES.md')
    const doc = readFileSync('docs/FOLLOWUP_HR_PEOPLE_ROLE_SCORES.md', 'utf8')
    expect(doc).toMatch(/Status:\*\* open/)
    expect(doc).toMatch(/CHRO/)
  })
})

// ── 7. Onboarding follow-ups ─────────────────────────────────────────────────────────
describe('recruiter onboarding section', () => {
  const FORM = readFileSync('components/OnboardingForm.tsx', 'utf8')
  const STEP1 = readFileSync('components/OnboardingStep1.tsx', 'utf8')
  const PANEL = readFileSync('components/onboarding/RecruiterGuidance.tsx', 'utf8')

  it('appears for exactly the two recruiter roles, and no others', () => {
    for (const v of [EXTERNAL, IN_HOUSE]) expect(recruiterGuidance(v), v).not.toBeNull()
    for (const v of ['Head of Talent', 'CHRO', 'CEO', 'General Counsel', 'Advisor', 'Other', '', null, undefined]) {
      expect(recruiterGuidance(v as any), String(v)).toBeNull()
    }
  })

  it('differs between external and in-house without inventing a field', () => {
    const ext = recruiterGuidance(EXTERNAL)!, inh = recruiterGuidance(IN_HOUSE)!
    expect(ext.heading).not.toBe(inh.heading)
    expect(ext.points.map(p => p.field)).toEqual(inh.points.map(p => p.field))
  })

  it('reuses ONLY existing stored fields — no new column, no duplicate question', () => {
    const fields = recruiterGuidance(EXTERNAL)!.points.map(p => p.field)
    expect(fields).toEqual(['expertise', 'desired_connections', 'purposes'])
    for (const f of fields) expect(FORM, f).toContain(`fd.append('${f}'`)
  })

  it('stores nothing of its own, so it cannot block completion or lose an answer', () => {
    expect(PANEL).not.toMatch(/useState|onChange|<input|<textarea|<select|fd\.append|setRoleType/)
    expect(PANEL).not.toMatch(/'use client'/)
    expect(isExternalRecruiterRoleType(EXTERNAL)).toBe(true)
    expect(isExternalRecruiterRoleType(IN_HOUSE)).toBe(false)
  })

  it('switching away from a recruiter role hides the framing and deletes nothing', () => {
    // the panel is a pure function of role_type; changing role changes only what renders
    expect(recruiterGuidance(EXTERNAL)).not.toBeNull()
    expect(recruiterGuidance('CEO')).toBeNull()
    for (const f of ['components/OnboardingForm.tsx', 'components/OnboardingStep1.tsx']) {
      const code = readFileSync(f, 'utf8')
      expect(code, f).not.toMatch(/setExpertise\(\[\]\)|setPurposes\(\[\]\)|setDesiredConnections\(\{\}\)/)
    }
  })

  it('never touches exact_job_title', () => {
    expect(PANEL).not.toContain('exact_job_title')
    expect(readFileSync('lib/onboarding/recruiterGuidance.ts', 'utf8')).not.toMatch(/exact_job_title\s*=/)
  })

  it('is rendered on both onboarding surfaces, gated on role_type', () => {
    for (const [name, src] of [['OnboardingForm', FORM], ['OnboardingStep1', STEP1]] as const) {
      expect(src, name).toContain('<RecruiterGuidancePanel roleType={roleType} />')
    }
  })

  it('states plainly that membership is not consent to be recruited', () => {
    expect(recruiterGuidance(EXTERNAL)!.footnote).toContain('Membership is not consent to be recruited')
    expect(recruiterGuidance(IN_HOUSE)!.footnote).toContain('not for sourcing outside Andrel')
  })

  it('adds no badge and implies no verification or preferred status', () => {
    const all = PANEL + JSON.stringify(recruiterGuidance(EXTERNAL)) + JSON.stringify(recruiterGuidance(IN_HOUSE))
    expect(all).not.toMatch(/verified|verification|endorse|badge|preferred|certified/i)
  })

  it('cannot overflow a 320px phone', () => {
    expect((PANEL.match(/min-w-0/g) || []).length).toBeGreaterThanOrEqual(2)
    expect((PANEL.match(/break-words/g) || []).length).toBeGreaterThanOrEqual(3)
    expect(PANEL).not.toMatch(/whitespace-nowrap|overflow-x-auto|w-\[\d{3,}px\]/)
  })
})

// ── 8. Completion, eligibility and everything that must NOT change ───────────────────
describe('nothing else changed', () => {
  it('profile completion still requires title, company, location — not role_type', () => {
    const route = readFileSync('app/api/profile/complete/route.ts', 'utf8')
    expect(route).toContain('Professional title is required.')
    expect(route).toContain('Company or organization is required.')
    expect(route).not.toMatch(/role_type/)
  })

  it('matching eligibility does not read role_type at all', () => {
    const el = readFileSync('lib/matching/eligibility.ts', 'utf8')
    expect(el).not.toMatch(/role_type/)
  })

  it('capacity, gating, credits and the Connector badge are untouched by this change', () => {
    const cap = readFileSync('lib/introductions/capacity.ts', 'utf8')
    expect(cap).toContain('MAX_VISIBLE_INTRO_CARDS = 2')
    for (const f of ['lib/onboarding/recruiterGuidance.ts', 'components/onboarding/RecruiterGuidance.tsx']) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/credit|capacity|intro_requests|notification|badge|connector|RLS|GRANT/i)
    }
  })

  it('no migration was added for this feature', () => {
    const src = readFileSync('lib/onboarding/recruiterGuidance.ts', 'utf8')
    expect(src).not.toMatch(/ALTER TABLE|CREATE TABLE|migration/i)
  })
})
