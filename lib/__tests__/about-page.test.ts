import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SRC = readFileSync('app/about/page.tsx', 'utf8')
// Whitespace-normalized copy — JSX wraps long sentences across lines, so copy assertions run against
// this collapsed form; structural assertions (tags, hrefs, aria, component counts) run against SRC.
const TEXT = SRC.replace(/\s+/g, ' ')
// The founder <section> only (aria-labelledby="founder-heading" … </section>).
const FOUNDER = (SRC.match(/aria-labelledby="founder-heading"[\s\S]*?<\/section>/) || [''])[0].replace(/\s+/g, ' ')
// The metadata description string value.
const DESCRIPTION = (SRC.match(/description:\s*\n?\s*'([^']*)'/) || [, ''])[1]

describe('About page — hero + section headings', () => {
  it('has the correct eyebrow, hero heading, and hero body', () => {
    expect(TEXT).toContain('About Andrel')
    expect(TEXT).toContain('A private network built around mutual, curated introductions')
    expect(TEXT).toContain('Andrel introduces senior professionals and executives it believes could benefit from knowing one another.')
    expect(TEXT).toContain('The goal is simple: create a better starting point for professional relationships.')
  })
  it('has all six section headings', () => {
    for (const h of [
      'Why Andrel exists',
      'How it works',
      'Who Andrel is for',
      'What members are expected to do',
      'Why I built Andrel',
      'Build relationships worth maintaining',
    ]) {
      expect(TEXT).toContain(h)
    }
  })
})

describe('About page — the mutual / private-interest mechanic', () => {
  it('states interest is private and a connection needs both people', () => {
    expect(TEXT).toContain('Interest remains private, and a connection is made only when both people want to meet.')
    expect(TEXT).toContain('Neither person sees the other')
    expect(TEXT).toContain('When both choose to connect')
  })
})

describe('About page — Thursday cadence with NO weekly guarantee', () => {
  it('mentions Thursday batches but never promises an introduction every week', () => {
    expect(TEXT).toContain('Introduction batches are prepared each Thursday.')
    expect(TEXT).toContain('A member may not receive an introduction in every batch')
    expect(TEXT).not.toMatch(/at \d{1,2}(:\d\d)?\s*(am|pm)/i) // no exact-time claim
    expect(TEXT).not.toMatch(/every member (receives|gets|will)/i)
    expect(TEXT).not.toMatch(/guaranteed|an introduction every (week|Thursday)/i)
  })
})

describe('About page — cross-functional executive positioning', () => {
  it('leads with senior professionals and executives, not a legal-only audience', () => {
    expect(TEXT).toContain('Andrel introduces senior professionals and executives')
    expect(TEXT).toContain('Andrel is built for senior professionals and executives across')
    expect(TEXT).toContain('accomplished professionals and executives wanted to expand their networks')
  })

  it('names leadership across multiple functions, not one profession', () => {
    for (const fn of [
      'legal',
      'government affairs',
      'business',
      'finance',
      'operations',
      'technology',
      'entrepreneurship',
      'organizational leadership',
    ]) {
      expect(TEXT).toContain(fn)
    }
    expect(TEXT).toContain('accomplished leaders across functions and industries')
    expect(TEXT).toContain('not a particular profession or title')
  })

  it('states the legal-leadership origin honestly, as a foundation rather than the definition', () => {
    expect(TEXT).toContain(
      'The network began with a strong foundation of senior in-house counsel and law-firm partners and is expanding thoughtfully'
    )
    // Every mention of the legal-leadership base must sit inside that origins sentence — never as a
    // statement of what the network currently is.
    const legalBaseMentions = (TEXT.match(/in-house counsel|law-firm partners/g) || []).length
    expect(legalBaseMentions).toBe(2) // both inside the single "began with" sentence
    expect(TEXT).not.toMatch(/currently centered on senior in-house counsel/i)
  })

  it('retains the invite-only + selective-admission line', () => {
    expect(TEXT).toContain('Membership is invite-only, and admission remains selective as the network grows.')
    expect(TEXT).not.toMatch(/(everyone|all applicants|every applicant)[^.]{0,30}(is |are )?(admitted|accepted|approved)/i)
  })

  it('does NOT claim membership is already evenly distributed across functions', () => {
    expect(TEXT).not.toMatch(/even(ly)? (distributed|split|balanced|represented)/i)
    expect(TEXT).not.toMatch(/equal(ly)? (represent|distribut|balanc)/i)
    expect(TEXT).not.toMatch(/(members|leaders|executives) (from|in|across) (all|every) (function|industry|sector|field)/i)
    expect(TEXT).not.toMatch(/across all (functions|industries|sectors)/i)
    expect(TEXT).not.toMatch(/(equal|even) (mix|balance) of/i)
    // "expanding" must stay forward-looking, never asserted as already complete
    expect(TEXT).not.toMatch(/(now|already) (a |an )?(fully |truly )?(cross-functional|multi-disciplinary)/i)
  })

  it('publishes NO composition statistics', () => {
    expect(TEXT).not.toMatch(/\d+\s*%/)
    expect(TEXT).not.toMatch(/\bpercent\b/i)
    expect(TEXT).not.toMatch(/\b(majority|minority|half|two-thirds|a third) of (our |the )?(members|network)/i)
    expect(TEXT).not.toMatch(/\b\d[\d,]*\+?\s*(members|executives|professionals|leaders|companies|firms)\b/i)
  })

  it('carries NO legal-only platform positioning anywhere on the page', () => {
    expect(TEXT).not.toMatch(/senior legal professionals/i)
    expect(TEXT).not.toMatch(/\b(legal|lawyer|attorney)[- ]only\b/i)
    expect(TEXT).not.toMatch(/network (of|for) (senior )?(legal professionals|lawyers|attorneys|counsel)/i)
    expect(TEXT).not.toMatch(/(exclusively|only) for (lawyers|attorneys|legal|in-house counsel)/i)
    expect(TEXT).not.toMatch(/areas of legal practice/i)
    expect(TEXT).not.toMatch(/\bthe legal (industry|community|profession|world)\b/i)
    expect(TEXT).not.toMatch(/\blegal network\b/i)
    // "legal" survives only as one entry in the list of functions Andrel serves
    expect((TEXT.match(/\blegal\b/gi) || []).length).toBe(1)
  })
})

describe('About page — free + optional-paid language (verified against pricing config)', () => {
  it('retains the free-to-join and optional-paid statements', () => {
    expect(TEXT).toContain('There is no cost to join Andrel.')
    expect(TEXT).toContain('Optional paid memberships provide additional introductions and services')
    expect(TEXT).toContain('members can participate without purchasing a subscription')
  })
})

describe('About page — member expectations', () => {
  it('includes the intro, all five expectations, and the closing', () => {
    expect(TEXT).toContain('The quality of Andrel depends on how members participate.')
    for (const e of [
      'Approach introductions with curiosity rather than an immediate pitch.',
      'Respond to an introduction, even when the answer is no.',
      'interest remains private', // "Respect that another member’s interest remains private."
      'Treat conversations and member information with discretion.',
      'Look for opportunities to be useful before asking for something.',
    ]) {
      expect(TEXT).toContain(e)
    }
    expect(TEXT).toContain('Repeatedly leaving introductions unanswered may limit a member')
  })
})

describe('About page — founder section is personal but excludes forbidden topics', () => {
  it('has the founder signature', () => {
    expect(FOUNDER).toContain('Daniel Abramoff')
    expect(FOUNDER).toContain('Founder, Andrel')
  })
  it('mentions NO podcast, legal business development, or Counsel House', () => {
    expect(SRC).not.toMatch(/podcast/i)
    expect(SRC).not.toMatch(/counsel\s*house/i)
    expect(SRC).not.toMatch(/business development/i)
  })
  it('the founder section gives no employment/background/title framing', () => {
    expect(FOUNDER).not.toMatch(/\b(attorney|lawyer|associate|general counsel)\b/i)
    expect(FOUNDER).not.toMatch(/works? at|worked at|practic(e|ed) (law|at)|career (in|as)/i)
  })
})

describe('About page — prohibited claims are absent', () => {
  it('publishes NO member count', () => {
    expect(SRC).not.toMatch(/\b\d[\d,]*\+?\s*(members|professionals|attorneys|lawyers|users)\b/i)
    expect(SRC).not.toMatch(/join(ed)? by \d/i)
  })
  it('makes NO client/job/referral/revenue/partnership outcome promise', () => {
    for (const w of [/\bclients?\b/i, /\bjobs?\b/i, /\brevenue\b/i, /\breferrals?\b/i, /\bpartnerships?\b/i, /win business/i, /land (a|new)/i]) {
      expect(TEXT).not.toMatch(w)
    }
  })
  it('makes NO general profile-privacy promise (interest-privacy only)', () => {
    expect(TEXT).not.toMatch(/profiles?[^.]{0,40}(are|remain|stay|kept) private/i)
    expect(TEXT).not.toMatch(/never (be )?(publicly|public)/i)
    expect(TEXT).not.toMatch(/profile[^.]{0,30}(never|not) (be )?visible/i)
  })
  it('has NO testimonials, logos, comparison table, or unsupported social proof', () => {
    expect(SRC).not.toMatch(/testimonial/i)
    expect(SRC).not.toMatch(/trusted by|as seen (in|on)|featured in/i)
    expect(SRC).not.toMatch(/<table/i)
  })
})

describe('About page — CTAs point to verified routes, at top and bottom', () => {
  it('Request an invitation → "/" (home waitlist) and Member sign in → "/login"', () => {
    expect(TEXT).toContain('Request an invitation')
    expect(TEXT).toContain('Member sign in')
    expect(SRC).toMatch(/href="\/"[\s\S]*?Request an invitation/)
    expect(SRC).toMatch(/href="\/login"[\s\S]*?Member sign in/)
    expect((SRC.match(/<CtaPair/g) || []).length).toBe(2) // hero + closing
  })
})

describe('About page — one three-step visual, not a feature grid', () => {
  it('has exactly the three pathway labels in order', () => {
    const labels = ['Your priorities', 'Andrel curates', 'Mutual introduction']
    for (const l of labels) expect(TEXT).toContain(l)
    const positions = labels.map((l) => SRC.indexOf(l))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })
  it('is a single ordered-list pathway, not a SaaS feature grid', () => {
    expect((SRC.match(/IntroductionPathway/g) || []).length).toBeGreaterThanOrEqual(2)
    expect(SRC).not.toMatch(/grid-cols-4/)
    expect(SRC).not.toMatch(/\bfeatures\s*=\s*\[/)
  })
})

describe('About page — semantic structure + accessibility', () => {
  it('exactly one h1, six h2, and steps rendered from a mapped list', () => {
    expect((SRC.match(/<h1[\s>]/g) || []).length).toBe(1)
    expect((SRC.match(/<h2[\s>]/g) || []).length).toBe(6)
    expect((SRC.match(/<h3[\s>]/g) || []).length).toBe(1) // one <h3> template, mapped over STEPS
    expect((SRC.match(/STEPS\.map/g) || []).length).toBe(1)
  })
  it('sections are labelled, the pathway list has an aria-label, nav marks the current page', () => {
    for (const id of ['why-heading', 'how-heading', 'network-heading', 'expectations-heading', 'founder-heading', 'closing-heading']) {
      expect(SRC).toContain(`aria-labelledby="${id}"`)
      expect(SRC).toContain(`id="${id}"`)
    }
    expect(SRC).toMatch(/aria-label="How an Andrel introduction is made/)
    expect(SRC).toMatch(/aria-current="page"/)
    expect(SRC).toMatch(/aria-hidden="true"/)
    expect(SRC).toMatch(/focus-visible:ring/)
    expect(SRC).toMatch(/motion-reduce:transition-none/)
  })
})

// Locked in after visual QA at 320 / 390 / 640 / 768 / 1024 / 1440px. Each assertion below stands for a
// defect that was visible in a rendered screenshot, not a style preference.
describe('About page — layout regressions found in visual QA', () => {
  it('the hero heading sets its own line-height at lg (44px type must not inherit 40px leading)', () => {
    // sm:text-4xl also emits line-height:2.5rem; that value survives into the lg breakpoint because
    // lg:text-[2.75rem] only sets font-size. Without lg:leading-*, the two-line h1 renders cramped.
    expect(SRC).toMatch(/lg:text-\[2\.75rem\][^"]*lg:leading-\[/)
  })

  it('every section shares one measure — no max-w-3xl next to max-w-2xl', () => {
    expect(SRC).not.toMatch(/max-w-3xl/)
    expect((SRC.match(/max-w-2xl mx-auto/g) || []).length).toBe(7) // one per <section>
  })

  it('uses one vertical rhythm for all sections', () => {
    expect(SRC).not.toMatch(/lg:py-20/)
    expect((SRC.match(/py-16 lg:py-24/g) || []).length).toBe(7)
  })

  it('the tint marks the two "why" sections rather than alternating every other section', () => {
    // Strict alternation over seven sections rendered as an even stripe pattern.
    expect((SRC.match(/bg-brand-cream\/50/g) || []).length).toBe(2)
    const tinted: string[] = []
    const tintedRe = /bg-brand-cream\/50[\s\S]*?aria-labelledby="([a-z-]+)"/g
    let match: RegExpExecArray | null
    while ((match = tintedRe.exec(SRC)) !== null) tinted.push(match[1])
    expect(tinted).toEqual(['why-heading', 'founder-heading'])
  })

  it('the pathway does not repeat the numbering carried by the steps below it', () => {
    expect(SRC).not.toMatch(/Step \{i \+ 1\}/)
    expect(SRC).not.toMatch(/tracking-\[0\.14em\]/) // the "STEP N" eyebrow style
    expect((SRC.match(/\{i \+ 1\}/g) || []).length).toBe(1) // only the numbered STEPS badges
  })

  it('pathway cards share a height so a wrapped label cannot leave the row ragged', () => {
    // sm:items-center let the taller third card ("Mutual introduction" wraps ~600-690px) sit offset
    // from the other two. Default stretch + justify-start keeps tops, heights and icons aligned.
    expect(SRC).not.toMatch(/sm:items-center/)
    expect(SRC).toMatch(/items-stretch/)
    expect(SRC).toMatch(/flex flex-1 flex-col items-center justify-start/)
  })

  it('both CTAs render the same height (the filled button needs a border box too)', () => {
    expect(SRC).toMatch(/border border-transparent bg-brand-navy/)
  })

  it('applies text-balance to headings and text-pretty to body copy (widow control)', () => {
    expect((SRC.match(/text-balance/g) || []).length).toBeGreaterThanOrEqual(6)
    expect((SRC.match(/text-pretty/g) || []).length).toBeGreaterThanOrEqual(6)
  })
})

describe('About page — metadata is accurate, not inflated', () => {
  it('has a title and an honest description with no inflated SEO claims', () => {
    expect(SRC).toMatch(/title:\s*'About Andrel'/)
    expect(DESCRIPTION.length).toBeGreaterThan(20)
    expect(DESCRIPTION).not.toMatch(/#1|\bbest\b|\bleading\b|top-rated|world-class|revolutionary/i)
  })

  it('the description positions Andrel across professions, with no legal-only framing', () => {
    expect(DESCRIPTION).toContain(
      'Andrel is a private professional network that creates curated, mutual introductions among senior professionals and executives.'
    )
    expect(DESCRIPTION).not.toMatch(/legal|lawyer|attorney|counsel|law.firm/i)
    // no keyword-stuffed function list in the meta description
    expect((DESCRIPTION.match(/,/g) || []).length).toBeLessThan(6)
  })

  it('the page title carries no profession-specific positioning', () => {
    const title = (SRC.match(/title:\s*'([^']*)'/) || [, ''])[1]
    expect(title).not.toMatch(/legal|lawyer|attorney|counsel|law.firm/i)
  })
})
