import { describe, it, expect } from 'vitest'
import {
  professionalIdentity,
  professionalIdentityLine,
  isPlaceholderCompany,
  shouldShowRecentRoleHint,
} from '@/lib/professionalIdentity'

// Any rendered surface joins primary + secondary; assert neither ever contains
// the awkward placeholder join.
const rendered = (p: any) => {
  const id = professionalIdentity(p)
  return [id.primary, id.secondary].filter(Boolean).join(' | ')
}

describe('professional identity — independent-like companies', () => {
  it('1. Independent -> "Independent General Counsel"', () => {
    expect(professionalIdentityLine({ title: 'General Counsel', company: 'Independent' }))
      .toBe('Independent General Counsel')
  })

  it('Self-employed -> "Independent Director"', () => {
    expect(professionalIdentityLine({ title: 'Director', company: 'Self-employed' }))
      .toBe('Independent Director')
  })

  it('handles Consultant / Freelance / Fractional / Advisor as independent', () => {
    for (const company of ['Consultant', 'Freelance', 'Fractional', 'Advisor']) {
      expect(professionalIdentityLine({ title: 'CFO', company })).toBe('Independent CFO')
    }
  })

  it('current_status "consulting_advisory" with no company reads as independent', () => {
    expect(professionalIdentityLine({ title: 'Product Lead', company: '', current_status: 'consulting_advisory' }))
      .toBe('Independent Product Lead')
  })
})

describe('professional identity — never "… at Independent"', () => {
  it('2. never renders "General Counsel at Independent"', () => {
    for (const company of ['Independent', 'Self-employed', 'Confidential', 'Freelance', 'Between roles', 'Retired', 'Stealth']) {
      const text = rendered({ title: 'General Counsel', company })
      expect(text).not.toMatch(/at Independent/i)
      expect(text).not.toMatch(/at Self-employed/i)
      expect(text).not.toMatch(/at Confidential/i)
    }
  })
})

describe('professional identity — status-driven formats', () => {
  it('3. Between roles -> title + "Currently between roles"', () => {
    expect(professionalIdentity({ title: 'VP Engineering', company: 'Between roles' }))
      .toEqual({ primary: 'VP Engineering', secondary: 'Currently between roles' })
  })

  it('4. Retired -> "Former [Title]"', () => {
    expect(professionalIdentity({ title: 'General Counsel', company: 'Retired' }))
      .toEqual({ primary: 'Former General Counsel', secondary: null })
  })

  it('5. Confidential -> title + "Current organization confidential"', () => {
    expect(professionalIdentity({ title: 'Head of Sales', company: 'Confidential' }))
      .toEqual({ primary: 'Head of Sales', secondary: 'Current organization confidential' })
  })

  it('Stealth -> title + "Currently in stealth"', () => {
    expect(professionalIdentity({ title: 'Founder', company: 'Stealth' }))
      .toEqual({ primary: 'Founder', secondary: 'Currently in stealth' })
  })
})

describe('professional identity — employed users unchanged', () => {
  it('6. real company still renders "Title at Company"', () => {
    expect(professionalIdentityLine({ exact_job_title: 'General Counsel', company: 'Microsoft' }))
      .toBe('General Counsel at Microsoft')
    expect(professionalIdentity({ title: 'Engineer', company: 'Stripe' }))
      .toEqual({ primary: 'Engineer at Stripe', secondary: null })
  })

  it('does not misclassify real companies containing a keyword', () => {
    // "Advisor Group" / "Freelance.com" are real firms, not placeholders.
    expect(professionalIdentityLine({ title: 'Partner', company: 'Advisor Group' }))
      .toBe('Partner at Advisor Group')
  })

  it('title-only and company-only still render sensibly', () => {
    expect(professionalIdentityLine({ title: 'Engineer', company: '' })).toBe('Engineer')
    expect(professionalIdentityLine({ title: '', company: 'Stripe' })).toBe('Stripe')
    expect(professionalIdentityLine({ title: '', company: '' })).toBe('')
  })
})

describe('professional identity — previous roles', () => {
  it('7. appends most recent employer when available', () => {
    const indep = professionalIdentity({
      title: 'General Counsel', company: 'Independent',
      previous_roles: [{ company: 'Microsoft', title: 'Deputy GC' }],
    })
    expect(indep).toEqual({ primary: 'Independent General Counsel', secondary: 'Previously at Microsoft' })

    const between = professionalIdentity({
      title: 'CTO', company: 'Between roles',
      previous_roles: [{ company: 'Cisco', title: 'VP Eng' }],
    })
    expect(between).toEqual({ primary: 'CTO', secondary: 'Most recently at Cisco' })
  })

  it('ignores placeholder / incomplete previous roles', () => {
    const id = professionalIdentity({
      title: 'Advisor', company: 'Independent',
      previous_roles: [{ company: 'Independent', title: 'Consultant' }, { company: 'Acme' /* no title */ }],
    })
    expect(id.secondary).toBeNull()
  })
})

describe('professional identity — existing "Independent" users improve without editing', () => {
  it('8. a stored "Independent" profile immediately displays better (no edit needed)', () => {
    // Simulates a row already in the DB — no migration, no user action.
    const storedRow = { exact_job_title: 'Chief Marketing Officer', title: null, role_type: 'Marketing', company: 'Independent', previous_roles: [] }
    expect(professionalIdentityLine(storedRow)).toBe('Independent Chief Marketing Officer')
    expect(rendered(storedRow)).not.toMatch(/at Independent/i)
  })
})

describe('professional identity — no duplicated words', () => {
  it('never produces "Independent Independent …"', () => {
    expect(professionalIdentityLine({ title: 'Independent Consultant', company: 'Independent' }))
      .toBe('Independent Consultant')
  })

  it('never produces "Former Former …"', () => {
    expect(professionalIdentityLine({ title: 'Former CEO', company: 'Retired' }))
      .toBe('Former CEO')
  })
})

describe('compact "name · identity" surfaces (opportunity creators, referrals)', () => {
  // Mirrors the compact one-line join used on those surfaces.
  const compact = (p: any) => [p.full_name, professionalIdentityLine(p)].filter(Boolean).join(' · ')

  it('does not show "· Independent" (or any raw placeholder) as the trailing token', () => {
    for (const company of ['Independent', 'Self-employed', 'Confidential', 'Stealth', 'Between roles', 'Retired']) {
      const line = compact({ full_name: 'Neal Dongre', title: 'General Counsel', company })
      expect(line).not.toMatch(/· (Independent|Self-employed|Confidential|Stealth|Between roles|Retired)$/)
    }
  })

  it('renders "Neal Dongre · Independent General Counsel" for an independent profile', () => {
    expect(compact({ full_name: 'Neal Dongre', title: 'General Counsel', company: 'Independent' }))
      .toBe('Neal Dongre · Independent General Counsel')
  })

  it('normal employed profiles still show their real company', () => {
    expect(compact({ full_name: 'Ana Ruiz', exact_job_title: 'Engineer', company: 'Stripe' }))
      .toBe('Ana Ruiz · Engineer at Stripe')
    // Even without a title, a real company is preserved.
    expect(compact({ full_name: 'Ana Ruiz', company: 'Stripe' })).toBe('Ana Ruiz · Stripe')
  })

  it('confidential / stealth never reveal a placeholder as the company', () => {
    const conf = compact({ full_name: 'Dana Lee', title: 'Head of Sales', company: 'Confidential' })
    expect(conf).toBe('Dana Lee · Head of Sales')
    expect(conf).not.toMatch(/Confidential/)

    const stealth = compact({ full_name: 'Kai Wu', title: 'Founder', company: 'Stealth' })
    expect(stealth).toBe('Kai Wu · Founder')
    expect(stealth).not.toMatch(/Stealth/)
  })

  it('name-only (no title, no real company) degrades to just the name', () => {
    expect(compact({ full_name: 'Jordan Poe', company: 'Independent' }))
      .toBe('Jordan Poe · Independent professional')
    expect(compact({ full_name: 'Jordan Poe' })).toBe('Jordan Poe')
  })
})

describe('profile-editor recent-role hint', () => {
  it('9. only offers the hint for independent-like company values', () => {
    for (const company of ['Independent', 'Self-employed', 'Consultant', 'Freelance', 'Fractional', 'Advisor', 'Confidential', 'Stealth', 'Between roles', 'Retired']) {
      expect(isPlaceholderCompany(company)).toBe(true)
      expect(shouldShowRecentRoleHint({ company, hasUsablePreviousRole: false, dismissed: false })).toBe(true)
    }
    // Real companies never trigger the hint.
    for (const company of ['Microsoft', 'Acme Corp', 'Advisor Group', '']) {
      expect(shouldShowRecentRoleHint({ company, hasUsablePreviousRole: false, dismissed: false })).toBe(false)
    }
  })

  it('10. the hint disappears permanently after dismissal', () => {
    const base = { company: 'Independent', hasUsablePreviousRole: false }
    expect(shouldShowRecentRoleHint({ ...base, dismissed: false })).toBe(true)
    expect(shouldShowRecentRoleHint({ ...base, dismissed: true })).toBe(false)
  })

  it('does not nag once a usable previous role already exists', () => {
    expect(shouldShowRecentRoleHint({ company: 'Independent', hasUsablePreviousRole: true, dismissed: false })).toBe(false)
  })
})
