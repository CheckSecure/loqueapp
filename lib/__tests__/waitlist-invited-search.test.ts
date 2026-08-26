import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  normalizeSearchQuery, searchTokens, matchesInvitedSearch,
  filterInvitedBySearch, invitedResultSummary, invitedNoResultsDetail,
} from '@/lib/waitlist/searchInvited'

/**
 * Invited-tab search: filters what is already on the page, and nothing else.
 *
 * The matching rules are pure and are executed here against fixtures. The component is a large
 * client component this vitest setup cannot render (tsconfig jsx=preserve), so the wiring — which
 * tab it appears on, what the clear button does, what the tab badge is derived from — is asserted
 * on source, consistent with the rest of lib/__tests__.
 */
const UI = readFileSync('components/AdminWaitlistClient.tsx', 'utf8')
const MOD = readFileSync('lib/waitlist/searchInvited.ts', 'utf8')
/** Assertions about behaviour run against CODE; the comments discuss what the code must not do. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

type Row = { id: string; status: string; full_name: string | null; email: string | null; lc?: string }
const PEOPLE: Row[] = [
  { id: 'w1', status: 'invited',   full_name: 'Doug Smith',      email: 'doug@acme.test',      lc: 'newly' },
  { id: 'w2', status: 'invited',   full_name: 'Douglas Fir',     email: 'dfir@forest.test',    lc: 'r1_due' },
  { id: 'w3', status: 'invited',   full_name: 'Amara Okafor',    email: 'AMARA@Example.COM',   lc: 'newly' },
  { id: 'w4', status: 'invited',   full_name: null,              email: 'nameless@acme.test',  lc: 'newly' },
  { id: 'w5', status: 'invited',   full_name: 'No Email Person', email: null,                  lc: 'r1_due' },
  { id: 'w6', status: 'pending',   full_name: 'Doug Pending',    email: 'doug@pending.test' },
  { id: 'w7', status: 'declined',  full_name: 'Doug Declined',   email: 'doug@declined.test' },
  { id: 'w8', status: 'approved',  full_name: 'Doug Approved',   email: 'doug@approved.test' },
]
const invited = PEOPLE.filter((p) => p.status === 'invited')
const ids = (rows: Row[]) => rows.map((r) => r.id)

// ── 1. Normalisation ─────────────────────────────────────────────────────────────────
describe('query normalisation', () => {
  it('lowercases, trims, and collapses runs of whitespace', () => {
    expect(normalizeSearchQuery('  DOUG   Smith \n')).toBe('doug smith')
    expect(normalizeSearchQuery('\t Amara \t')).toBe('amara')
  })

  it('treats a whitespace-only query as empty', () => {
    for (const q of ['', '   ', '\t', '\n  \n', null, undefined]) {
      expect(normalizeSearchQuery(q), JSON.stringify(q)).toBe('')
      expect(searchTokens(q)).toEqual([])
    }
  })

  it('splits into tokens on any run of whitespace', () => {
    expect(searchTokens('doug   smith')).toEqual(['doug', 'smith'])
    expect(searchTokens(' ACME ')).toEqual(['acme'])
  })
})

// ── 2. Matching ──────────────────────────────────────────────────────────────────────
describe('matching name and email', () => {
  it('finds by full name', () => {
    expect(ids(filterInvitedBySearch(invited, 'doug'))).toEqual(['w1', 'w2'])   // Doug + Douglas
    expect(ids(filterInvitedBySearch(invited, 'Okafor'))).toEqual(['w3'])
  })

  it('finds by email, including the local part and the domain', () => {
    expect(ids(filterInvitedBySearch(invited, 'dfir'))).toEqual(['w2'])
    expect(ids(filterInvitedBySearch(invited, 'acme.test'))).toEqual(['w1', 'w4'])
    expect(ids(filterInvitedBySearch(invited, 'forest'))).toEqual(['w2'])
  })

  it('is case-insensitive on both sides', () => {
    expect(ids(filterInvitedBySearch(invited, 'DOUG'))).toEqual(['w1', 'w2'])
    expect(ids(filterInvitedBySearch(invited, 'amara@example.com'))).toEqual(['w3'])  // stored uppercase
    expect(ids(filterInvitedBySearch(invited, 'AMARA'))).toEqual(['w3'])
  })

  it('tolerates leading, trailing and repeated spaces', () => {
    for (const q of ['doug smith', '  doug smith  ', 'doug   smith', '\tdoug \n smith ']) {
      expect(ids(filterInvitedBySearch(invited, q)), q).toEqual(['w1'])
    }
  })

  it('requires every token, in any order', () => {
    expect(ids(filterInvitedBySearch(invited, 'smith doug'))).toEqual(['w1'])
    expect(ids(filterInvitedBySearch(invited, 'doug acme'))).toEqual(['w1'])
    // tokens may land in DIFFERENT fields of the same row: 'doug' hits the name Douglas Fir and
    // 'forest' hits dfir@forest.test — that is the intended behaviour, and worth pinning
    expect(ids(filterInvitedBySearch(invited, 'doug forest'))).toEqual(['w2'])
    // a genuine miss: no single invited row carries both tokens
    expect(ids(filterInvitedBySearch(invited, 'doug okafor'))).toEqual([])
  })

  it('never lets a token span the name/email boundary', () => {
    // 'Doug Smith' + 'doug@acme.test' must not match the fabricated string "smithdoug"
    expect(matchesInvitedSearch(PEOPLE[0], 'smithdoug')).toBe(false)
  })

  it('handles a missing name or a missing email without throwing', () => {
    expect(ids(filterInvitedBySearch(invited, 'nameless'))).toEqual(['w4'])
    expect(ids(filterInvitedBySearch(invited, 'no email'))).toEqual(['w5'])
    expect(matchesInvitedSearch({ full_name: null, email: null }, 'x')).toBe(false)
    expect(matchesInvitedSearch({}, 'x')).toBe(false)
  })

  it('an empty query matches everything, in the original order', () => {
    for (const q of ['', '   ', null, undefined]) {
      expect(ids(filterInvitedBySearch(invited, q)), JSON.stringify(q)).toEqual(['w1','w2','w3','w4','w5'])
    }
  })

  it('preserves ordering exactly — it filters, it never sorts', () => {
    const reversed = [...invited].reverse()
    expect(ids(filterInvitedBySearch(reversed, ''))).toEqual(['w5','w4','w3','w2','w1'])
    expect(ids(filterInvitedBySearch(reversed, 'doug'))).toEqual(['w2','w1'])
  })

  it('handles null/undefined input lists', () => {
    expect(filterInvitedBySearch(null, 'x')).toEqual([])
    expect(filterInvitedBySearch(undefined, '')).toEqual([])
  })

  it('does not mutate the input array', () => {
    const src = [...invited]
    filterInvitedBySearch(src, 'doug')
    expect(ids(src)).toEqual(['w1','w2','w3','w4','w5'])
  })
})

// ── 3. Composition with the lifecycle sub-filter ─────────────────────────────────────
describe('search composes with the lifecycle sub-filter', () => {
  const byLifecycle = (rows: Row[], lc: string) => (lc === 'all' ? rows : rows.filter((r) => r.lc === lc))
  const pipeline = (lc: string, q: string) =>
    ids(filterInvitedBySearch(byLifecycle(PEOPLE.filter((p) => p.status === 'invited'), lc), q))

  it('applies the lifecycle filter and then the search', () => {
    expect(pipeline('newly', 'doug')).toEqual(['w1'])        // Douglas Fir is r1_due, excluded
    expect(pipeline('r1_due', 'doug')).toEqual(['w2'])
    expect(pipeline('all', 'doug')).toEqual(['w1', 'w2'])
  })

  it('an empty search leaves the lifecycle result untouched', () => {
    expect(pipeline('newly', '')).toEqual(['w1', 'w3', 'w4'])
    expect(pipeline('r1_due', '   ')).toEqual(['w2', 'w5'])
  })

  it('a search that matches nothing in the current lifecycle yields nothing', () => {
    expect(pipeline('r1_due', 'okafor')).toEqual([])          // Amara is 'newly'
  })

  it('the two are independent — neither widens the other', () => {
    const all = pipeline('all', 'doug')
    const newly = pipeline('newly', 'doug')
    expect(newly.every((id) => all.includes(id))).toBe(true)
    expect(newly.length).toBeLessThanOrEqual(all.length)
  })
})

// ── 4. Non-invited rows can never surface ────────────────────────────────────────────
describe('scope', () => {
  it('search runs only over rows already narrowed to Invited', () => {
    // four non-invited Dougs exist in the fixture and none is reachable
    const found = filterInvitedBySearch(invited, 'doug')
    expect(found.every((r) => r.status === 'invited')).toBe(true)
    expect(ids(found)).not.toContain('w6')
    expect(ids(found)).not.toContain('w7')
    expect(ids(found)).not.toContain('w8')
  })

  it('the component applies search ONLY on the invited tab', () => {
    expect(code(UI)).toMatch(/activeTab === 'invited' \? filterInvitedBySearch\(byTab, invitedSearch\) : byTab/)
    expect(code(UI)).toMatch(/const searchActive = activeTab === 'invited' &&/)
  })

  it('and renders the input ONLY on the invited tab', () => {
    const i = UI.indexOf("{activeTab === 'invited' && (")
    const j = UI.indexOf("{filtered.length === 0 ?")
    expect(i).toBeGreaterThan(-1)
    expect(UI.slice(i, j)).toContain('id="invited-search"')
    // the input appears exactly once in the whole file, inside that block
    expect((UI.match(/id="invited-search"/g) || []).length).toBe(1)
  })
})

// ── 5. The tab badge stays unfiltered ────────────────────────────────────────────────
describe('the Invited tab count', () => {
  it('comes from the server-computed counts prop, never from the filtered list', () => {
    expect(UI).toContain('Invited ({counts.invited})')
    expect(UI).not.toMatch(/Invited \(\{filtered/)
    expect(UI).not.toMatch(/counts\.invited\s*=/)          // never reassigned
  })

  it('the lifecycle chip counts are also independent of the search', () => {
    // each chip counts the whole invited population for its own lifecycle key
    expect(code(UI)).toMatch(/waitlist\.filter\(e => e\.status === 'invited' && matchesLifecycleFilter\(e, f\.key\)\)\.length/)
    const chip = UI.slice(UI.indexOf('LIFECYCLE_FILTERS.map'), UI.indexOf('{filtered.length === 0 ?'))
    expect(chip).not.toContain('invitedSearch')
  })
})

// ── 6. Result summary ────────────────────────────────────────────────────────────────
describe('result summary', () => {
  it('with no query, reports the size of the invited list', () => {
    expect(invitedResultSummary(24, '')).toBe('24 invited people')
    expect(invitedResultSummary(1, '   ')).toBe('1 invited person')
    expect(invitedResultSummary(0, '')).toBe('0 invited people')
  })

  it('with matches, reports the result count', () => {
    expect(invitedResultSummary(3, 'doug')).toBe('3 results')
    expect(invitedResultSummary(1, 'doug')).toBe('1 result')
  })

  it('with no matches, names what was searched', () => {
    expect(invitedResultSummary(0, 'doug')).toBe('No invited people match “doug”')
    expect(invitedResultSummary(0, '  DOUG   Smith ')).toBe('No invited people match “doug smith”')
  })

  it('is accurate against the real filter, for every fixture query', () => {
    for (const q of ['', 'doug', 'okafor', 'zzz', 'acme.test', '  DOUG  ']) {
      const n = filterInvitedBySearch(invited, q).length
      const s = invitedResultSummary(n, q)
      if (!normalizeSearchQuery(q)) expect(s).toBe(`${n} invited ${n === 1 ? 'person' : 'people'}`)
      else if (n === 0) expect(s).toContain('No invited people match')
      else expect(s).toBe(`${n} ${n === 1 ? 'result' : 'results'}`)
    }
  })

  it('the component feeds it the RENDERED count, so it can never disagree with the list', () => {
    expect(code(UI)).toContain('invitedResultSummary(filtered.length, invitedSearch)')
  })

  it('negative or fractional counts cannot produce nonsense', () => {
    expect(invitedResultSummary(-4, '')).toBe('0 invited people')
    expect(invitedResultSummary(2.7, 'x')).toBe('2 results')
  })
})

// ── 7. Clearing ──────────────────────────────────────────────────────────────────────
describe('the clear button', () => {
  it('clears ONLY the search and returns focus to the input', () => {
    // bound to the function BODY: searchAllLifecycles sits just below and legitimately calls
    // setLifecycleFilter
    const c = code(UI)
    const start = c.indexOf('const clearInvitedSearch')
    const fn = c.slice(start, c.indexOf('const activeLifecycleLabel', start))
    expect(fn).toContain("setInvitedSearch('')")
    expect(fn).toContain('searchInputRef.current?.focus()')
    expect(fn).not.toContain('setLifecycleFilter')      // the lifecycle filter survives
    expect(fn).not.toContain('setActiveTab')
  })

  it('is a real keyboard-reachable button with an accessible name and a focus ring', () => {
    const btn = UI.slice(UI.indexOf('aria-label="Clear search"') - 400, UI.indexOf('aria-label="Clear search"') + 400)
    expect(btn).toContain('type="button"')
    expect(btn).toContain('onClick={clearInvitedSearch}')
    expect(btn).toContain('focus-visible:ring-2')
  })

  it('only appears when there is something to clear', () => {
    expect(UI).toMatch(/\{invitedSearch !== '' && \(/)
  })

  it('clearing restores every invited row', () => {
    expect(ids(filterInvitedBySearch(invited, 'doug'))).toEqual(['w1', 'w2'])
    expect(ids(filterInvitedBySearch(invited, ''))).toEqual(['w1','w2','w3','w4','w5'])
  })

  it('the empty state offers the same clear action', () => {
    const empty = UI.slice(UI.indexOf('searchActive ? ('), UI.indexOf('No {activeTab} entries'))
    expect(empty).toContain('Clear search')
    expect(empty).toContain('onClick={clearInvitedSearch}')
    expect(empty).toContain('invitedResultSummary(0, invitedSearch)')
  })
})

// ── 8. Persistence across tab switches ───────────────────────────────────────────────
describe('the query survives leaving Invited and coming back', () => {
  it('no tab button resets it', () => {
    const tabs = UI.slice(UI.indexOf('{/* Tabs */}'), UI.indexOf('{/* Content */}'))
    expect(tabs).toContain("setActiveTab('invited')")
    expect(tabs).not.toContain('setInvitedSearch')
  })

  it('and nothing else clears it except the explicit clear action', () => {
    const resets = (code(UI).match(/setInvitedSearch\(''\)/g) || []).length
    expect(resets).toBe(1)                                   // only clearInvitedSearch
    expect(code(UI)).not.toMatch(/useEffect\([^)]*setInvitedSearch/)
  })

  it('it is component state, and the trade-off is documented rather than silent', () => {
    expect(UI).toContain('const [invitedSearch, setInvitedSearch] = useState')
    expect(UI).toMatch(/COMPONENT STATE, NOT THE URL/)
    expect(UI).toMatch(/network round trip PER KEYSTROKE/)
    expect(UI).toMatch(/does not survive is a full page reload/)
  })
})

// ── 9. Row actions still target the right person ─────────────────────────────────────
describe('row actions after filtering', () => {
  it('the list renders the real entry objects, so actions carry the real waitlist id', () => {
    expect(UI).toContain('{filtered.map(entry => {')
    expect(UI).toContain('key={entry.id}')
    for (const action of ['handleApprove(entry.id)', 'handleDecline(entry.id)', 'handleSendInvite(entry.id)']) {
      expect(UI, action).toContain(action)
    }
    for (const modal of ['setPreviewEntry(entry)', 'setRevokeEntry(entry)', 'setChangeEntry(entry)']) {
      expect(UI, modal).toContain(modal)
    }
  })

  it('nothing keys an action on a position in the filtered array', () => {
    expect(code(UI)).not.toMatch(/filtered\[\s*\d+\s*\]/)
    expect(code(UI)).not.toMatch(/\.map\(\(entry, ?i(ndex)?\) =>[\s\S]{0,400}handle\w+\(i/)
  })

  it('the search filter returns the SAME objects, not copies', () => {
    const [first] = filterInvitedBySearch(invited, 'doug')
    expect(first).toBe(invited[0])                          // identity, not deep equality
  })

  it('lifecycle badges still read from the entry being rendered', () => {
    expect(UI).toMatch(/activeTab === 'invited' && \(entry\.inviteStatus \|\| entry\.lifecycle\)/)
  })
})

// ── 10. Typing performs no IO ────────────────────────────────────────────────────────
describe('typing performs no IO and no write', () => {
  it('the search module contains no client, fetch, or router', () => {
    expect(MOD).not.toMatch(/fetch\(|createClient|supabase|\.rpc\(|router|useState|useEffect/)
    expect(MOD).not.toMatch(/\.insert\(|\.update\(|\.delete\(/)
  })

  it('the input handler only sets state', () => {
    const input = UI.slice(UI.indexOf('id="invited-search"'), UI.indexOf('aria-label="Clear search"'))
    expect(input).toContain('onChange={(e) => setInvitedSearch(e.target.value)}')
    expect(input).not.toMatch(/fetch\(|router\.|handleSend|handleApprove|revalidate/)
  })

  it('no URL write happens while typing — the documented reason it is component state', () => {
    expect(code(UI)).not.toMatch(/router\.(replace|push)\([^)]*invitedSearch/)
    expect(code(UI)).not.toMatch(/useSearchParams/)
  })

  it('search never reaches an invitation path', () => {
    // scoped to the search block itself — the Contacted-tab helper copy above it legitimately
    // says "Send Invite"
    // CODE only: the block's own comment says it performs no resend, which is the point
    const block = code(UI.slice(UI.indexOf('SEARCH — Invited only'), UI.indexOf('Email lifecycle')))
    expect(block).not.toMatch(/handleSendInvite|handleApprove|handleDecline|handleRevoke|sendEmail|\.rpc\(|fetch\(/i)
  })
})

// ── 11. Layout ───────────────────────────────────────────────────────────────────────
describe('layout cannot overflow on a phone', () => {
  it('the search block is full width on mobile and only splits from sm up', () => {
    const block = UI.slice(UI.indexOf('SEARCH — Invited only'), UI.indexOf('Email lifecycle'))
    expect(block).toContain('flex flex-col sm:flex-row')
    expect(block).toContain('w-full sm:max-w-sm')
  })

  it('every level of the block can shrink', () => {
    const block = UI.slice(UI.indexOf('SEARCH — Invited only'), UI.indexOf('Email lifecycle'))
    expect((block.match(/min-w-0/g) || []).length).toBeGreaterThanOrEqual(3)
    expect(block).toContain('w-full min-w-0')                // the input itself
    expect(block).toContain('break-words')                   // the summary line
    expect(block).not.toMatch(/whitespace-nowrap|overflow-x-auto|w-\[\d{3,}px\]|min-w-\[\d{3,}px\]/)
  })

  it('has an accessible label wired to the input, and a visible focus state', () => {
    expect(UI).toContain('htmlFor="invited-search"')
    expect(UI).toContain('Search invited people')
    expect(UI).toMatch(/id="invited-search"[\s\S]{0,700}focus-visible:ring-2/)
    expect(UI).toContain('aria-describedby="invited-search-summary"')
    expect(UI).toContain('id="invited-search-summary"')
  })

  it('announces the result count to assistive technology', () => {
    const sum = UI.slice(UI.indexOf('id="invited-search-summary"'), UI.indexOf('Email lifecycle'))
    expect(sum).toContain('role="status"')
    expect(sum).toContain('aria-live="polite"')
  })

  it('adds no dense advanced-search interface', () => {
    const block = UI.slice(UI.indexOf('SEARCH — Invited only'), UI.indexOf('Email lifecycle'))
    expect(block).not.toMatch(/<select|<details|<summary|type="date"|Advanced/i)
    expect((block.match(/<input/g) || []).length).toBe(1)
  })
})

// ── 12. Nothing outside the page sees an address ─────────────────────────────────────
describe('emails stay on the admin page', () => {
  it('the module neither logs nor transmits anything', () => {
    expect(MOD).not.toMatch(/console\.|fetch\(|URLSearchParams|localStorage|document\./)
  })

  it('the search adds no new surface that carries an address', () => {
    const block = UI.slice(UI.indexOf('SEARCH — Invited only'), UI.indexOf('Email lifecycle'))
    expect(block).not.toMatch(/entry\.email|\.email\b/)
  })
})

// ── 13. No results INSIDE a narrowed lifecycle bucket ────────────────────────────────
describe('the no-results state says when the lifecycle filter is narrowing it', () => {
  it('names the active bucket, and says the person may sit in another one', () => {
    const d = invitedNoResultsDetail('Reminder 1 due')
    expect(d).toContain('Only searching name and email within “Reminder 1 due”')
    expect(d).toContain('may be invited under a different email lifecycle')
  })

  it('says the plain thing when the filter is All', () => {
    for (const label of [null, undefined, '']) {
      expect(invitedNoResultsDetail(label), JSON.stringify(label))
        .toBe('Searching name and email across the invited people on this page.')
    }
  })

  it('the component passes null for All and the label otherwise', () => {
    expect(code(UI)).toMatch(/lifecycleFilter === 'all' \? null : \(LIFECYCLE_FILTERS\.find\(f => f\.key === lifecycleFilter\)\?\.label \?\? null\)/)
    expect(code(UI)).toContain('invitedNoResultsDetail(activeLifecycleLabel)')
  })

  it('this is a real scenario, not a hypothetical', () => {
    // Amara is 'newly'; searching for her inside 'r1_due' finds nothing even though she IS invited
    const inR1 = invited.filter((r) => r.lc === 'r1_due')
    expect(filterInvitedBySearch(inR1, 'okafor')).toHaveLength(0)
    expect(filterInvitedBySearch(invited, 'okafor')).toHaveLength(1)
  })
})

describe('the widen action', () => {
  const fn = code(UI).slice(code(UI).indexOf('const searchAllLifecycles'), code(UI).indexOf('return (', code(UI).indexOf('const searchAllLifecycles')))

  it('returns the lifecycle filter to All and PRESERVES the query', () => {
    expect(fn).toContain("setLifecycleFilter('all')")
    expect(fn).not.toContain('setInvitedSearch')      // the typed name is the thing worth keeping
    expect(fn).toContain('searchInputRef.current?.focus()')
  })

  it('is offered ONLY while a bucket is actually narrowing the result', () => {
    const empty = UI.slice(UI.indexOf('searchActive ? ('), UI.indexOf('No {activeTab} entries'))
    expect(empty).toMatch(/\{activeLifecycleLabel && \(/)
    expect(empty).toContain('Search all incomplete')
    expect(empty).toContain('onClick={searchAllLifecycles}')
  })

  it('sits beside Clear search, and both are keyboard reachable', () => {
    const empty = UI.slice(UI.indexOf('searchActive ? ('), UI.indexOf('No {activeTab} entries'))
    expect((empty.match(/type="button"/g) || []).length).toBe(2)
    expect((empty.match(/focus-visible:ring-2/g) || []).length).toBe(2)
    expect(empty).toContain('flex flex-col sm:flex-row')   // stacks on a phone
    expect(empty).toContain('min-w-0')
  })

  it('clearing and widening remain separate actions', () => {
    const clear = code(UI).slice(code(UI).indexOf('const clearInvitedSearch'), code(UI).indexOf('const activeLifecycleLabel'))
    expect(clear).not.toContain('setLifecycleFilter')
    expect(fn).not.toContain('setInvitedSearch')
  })

  it('widening changes no tab and touches no invitation path', () => {
    expect(fn).not.toContain('setActiveTab')
    expect(fn).not.toMatch(/handle\w+|fetch\(|router\./)
  })
})
