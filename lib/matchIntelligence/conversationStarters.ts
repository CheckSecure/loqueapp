// Match Intelligence — conversation starters (Phase C, display-only).
//
// A pure generator that turns the ALREADY-COMPUTED signals into 2–3 concise
// conversation starters. It never invents a signal — every starter is derived from
// a signal that is actually present, using that signal's specific value (focus
// area, organization, employer, expertise, purpose). No scoring, no persistence,
// no fabrication.

import type { MatchSignal, MatchContext } from './extractors'

/** Starter category priority (distinct from the display priority of the signals). */
const STARTER_ORDER: MatchSignal['category'][] = [
  'focus', 'affiliation', 'previous', 'expertise', 'purpose', 'mentorship',
]

const MAX_STARTERS = 3
const MAX_LEN = 90

const PURPOSE_STARTERS: Record<string, string> = {
  networking: 'Compare how you each grow your networks.',
  'expand network': 'Compare how you each grow your networks.',
  hiring: 'Swap notes on hiring great people.',
  'hire talent': 'Swap notes on hiring great people.',
  fundraising: 'Compare your fundraising strategies.',
  'raise capital': 'Compare your fundraising strategies.',
  partnerships: 'Explore potential partnership ideas.',
  'business development': 'Compare business-development approaches.',
  mentorship: 'Compare what you each look for in mentorship.',
  'give back / mentor': 'Compare what you each look for in mentorship.',
  'advice / expertise': 'Trade advice on a current challenge.',
  'find customers': 'Compare how you each find new customers.',
  'learn & grow': 'Compare how you each keep learning.',
  'explore opportunities': 'Compare the opportunities you’re each exploring.',
}

/** One starter for a given signal, or null if it can't produce a specific one. */
function starterFor(sig: MatchSignal): string | null {
  switch (sig.category) {
    case 'focus':
      return sig.value ? `Ask how they're approaching ${sig.value.toLowerCase()} right now.` : null
    case 'affiliation':
      if (sig.value) return `Ask how they got involved with ${sig.value}.`
      if (sig.key.includes('board_advisory') || sig.key.includes('board_member')) return 'Compare your board experiences.'
      if (sig.key.includes('advisor')) return 'Compare your advisory experiences.'
      if (sig.key.includes('investor_fund')) return 'Compare notes on fund governance.'
      if (sig.key.includes('committee_leadership')) return 'Compare your committee leadership experiences.'
      if (sig.key.includes('government_policy')) return 'Compare notes on working in policy.'
      if (sig.key.includes('professional_association')) return 'Compare your association involvement.'
      if (sig.key.includes('nonprofit')) return 'Compare your nonprofit work.'
      if (sig.key.includes('academic')) return 'Compare your academic experiences.'
      return null
    case 'previous':
      return sig.value ? `Ask what their time at ${sig.value} was like.` : null
    case 'expertise':
      return sig.value ? `Compare your approaches to ${sig.value}.` : null
    case 'purpose':
      return sig.value ? (PURPOSE_STARTERS[sig.value.toLowerCase()] ?? null) : null
    case 'mentorship':
      return 'Ask what kinds of professionals they enjoy mentoring most.'
    default:
      return null
  }
}

/**
 * Generate up to 3 conversation starters from the shown signals, in starter
 * priority order. Pure. `viewer`/`other` are accepted for signature completeness
 * but the starters derive from `signals` (+ their values). Never repeats a signal's
 * exact "why" wording, never duplicates, and never exceeds ~90 chars.
 */
export function generateConversationStarters(
  _viewer: any,
  _other: any,
  signals: MatchSignal[],
  _context: MatchContext = {},
): string[] {
  const shown = new Set(signals.map((s) => s.label)) // avoid echoing the "why" lines
  const byCat = new Map<string, MatchSignal[]>()
  for (const s of signals) {
    if (!byCat.has(s.category)) byCat.set(s.category, [])
    byCat.get(s.category)!.push(s)
  }

  const out: string[] = []
  const add = (s: string | null) => {
    if (!s) return
    const t = s.trim()
    if (!t || t.length > MAX_LEN || out.includes(t) || shown.has(t)) return
    out.push(t)
  }

  for (const cat of STARTER_ORDER) {
    if (out.length >= MAX_STARTERS) break
    for (const sig of byCat.get(cat) ?? []) {
      if (out.length >= MAX_STARTERS) break
      add(starterFor(sig))
    }
  }
  return out.slice(0, MAX_STARTERS)
}
