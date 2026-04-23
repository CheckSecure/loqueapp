// Generates up to 2 short, human-readable insights explaining why two users were matched.
// Uses existing profile fields only. Returns empty array when no strong signal.

type Profile = {
  id?: string | null
  full_name?: string | null
  title?: string | null
  company?: string | null
  bio?: string | null
  seniority?: string | null
  role_type?: string | null
  purposes?: string[] | string | null
  intro_preferences?: string[] | string | null
  interests?: string[] | string | null
  expertise?: string[] | string | null
  open_to_mentorship?: boolean | null
  [key: string]: any
}

type Kind = 'purposes' | 'keywords' | 'intro_prefs' | 'mentorship' | 'seniority' | 'interests'

export interface MatchInsight {
  text: string
  kind: Kind
}

// Candidate is the internal representation. `subject` is the trailing content that gets
// appended to the chosen phrase stem. For kinds that use full-sentence phrases,
// `subject` is empty string and the phrase array holds complete sentences.
interface Candidate {
  kind: Kind
  subject: string  // e.g. 'compliance-related work' or '' for whole-sentence kinds
}

// Phrase sets. First entry is primary; subsequent entries used for collision handling.
const PHRASES: Record<Kind, string[]> = {
  purposes: ["You're both focused on", 'You both prioritize', 'Aligned on'],
  keywords: ['Shared focus on', 'Aligned on', 'Both operate in'],
  intro_prefs: ["You're aligned on the kinds of people you want to meet"],
  mentorship: ['Strong mentorship alignment', 'Clear mentorship alignment'],
  seniority: ['Both of you operate at a senior level', 'Operating at a senior level'],
  interests: ['Shared interest in', 'You both enjoy', 'Common interest in']
}

// Which kinds are whole-sentence (phrase IS the full bullet, no subject appended)
const WHOLE_SENTENCE_KINDS = new Set<Kind>(['intro_prefs', 'mentorship', 'seniority'])

// ── Helpers ───────────────────────────────────────────────────

function toStringArray(value: any): string[] {
  if (Array.isArray(value)) {
    const out: string[] = []
    for (const x of value) {
      if (typeof x === 'string' && x.trim()) out.push(x.trim())
    }
    return out
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) {
          const out: string[] = []
          for (const x of parsed) {
            if (typeof x === 'string' && x.trim()) out.push(x.trim())
          }
          return out
        }
      } catch (e) { /* fall through */ }
      return []
    }
    return trimmed.split(',').map(s => s.trim()).filter(Boolean)
  }
  return []
}

function lower(s: string | null | undefined): string {
  return (s || '').toLowerCase()
}

function setIntersect(a: string[], b: string[]): string[] {
  const bLower = new Set(b.map(x => x.toLowerCase()))
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of a) {
    const key = x.toLowerCase()
    if (bLower.has(key) && !seen.has(key)) {
      out.push(x)
      seen.add(key)
    }
  }
  return out
}

function seniorityBucket(v: string | null | undefined): 'junior' | 'mid' | 'senior' | 'executive' | null {
  const s = lower(v)
  if (!s) return null
  if (/\bexec|\bceo|chief|c\-suite|csuite|founder/.test(s)) return 'executive'
  if (/senior|partner|principal|director/.test(s)) return 'senior'
  if (/mid|manager/.test(s)) return 'mid'
  if (/junior|associate|analyst|entry/.test(s)) return 'junior'
  return null
}

function humanize(raw: string): string {
  return raw.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

function joinList(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return items[0] + ' and ' + items[1]
  return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1]
}

const BIO_KEYWORDS: string[] = [
  'capital markets', 'private equity', 'venture capital',
  'm&a', 'mergers and acquisitions', 'mergers & acquisitions',
  'government affairs',
  'fintech', 'healthcare', 'litigation', 'compliance', 'regulatory',
  'antitrust', 'privacy', 'cybersecurity', 'securities', 'tax',
  'intellectual property', 'ip', 'employment', 'real estate',
  'esg', 'sustainability', 'ai', 'artificial intelligence',
  'startups', 'saas', 'biotech', 'pharma', 'insurance',
  'restructuring', 'banking', 'investment', 'contracts'
]

function bioKeywords(bio: string | null | undefined): Set<string> {
  const text = lower(bio)
  if (!text) return new Set()
  const found = new Set<string>()
  for (const kw of BIO_KEYWORDS) {
    const needle = kw.toLowerCase()
    const escaped = needle.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
    const re = new RegExp('(?:^|[^a-z0-9])' + escaped + '(?:[^a-z0-9]|$)', 'i')
    if (re.test(text)) found.add(needle)
  }
  if (found.has('m&a') || found.has('mergers and acquisitions') || found.has('mergers & acquisitions')) {
    found.delete('mergers and acquisitions')
    found.delete('mergers & acquisitions')
    found.add('m&a')
  }
  if (found.has('artificial intelligence') || found.has('ai')) {
    found.delete('artificial intelligence')
    found.add('ai')
  }
  if (found.has('intellectual property') || found.has('ip')) {
    found.delete('intellectual property')
    found.add('ip')
  }
  return found
}

function introPrefReciprocity(wantsList: string[], otherTitle: string, otherRoleType: string, otherSeniority: string, otherCompany: string): boolean {
  const hay = [otherTitle, otherRoleType, otherSeniority, otherCompany].filter(Boolean).map(x => (x || '').toLowerCase()).join(' ')
  if (!hay.trim()) return false
  for (const want of wantsList) {
    const w = want.toLowerCase().trim()
    if (!w) continue
    const tokens = w.split(/[\s\/]+/).filter(t => t.length >= 3)
    let hits = 0
    for (const t of tokens) {
      if (hay.includes(t)) hits++
    }
    if (hits > 0 && hits >= Math.min(tokens.length, 2)) return true
    if (tokens.length === 1 && hay.includes(tokens[0])) return true
  }
  return false
}

function renderCandidate(c: Candidate, stemIdx: number): string {
  const phrases = PHRASES[c.kind]
  const chosen = phrases[Math.min(stemIdx, phrases.length - 1)]
  if (WHOLE_SENTENCE_KINDS.has(c.kind)) return chosen
  return chosen + ' ' + c.subject
}

function firstTwoWords(text: string): string {
  return text.split(' ').slice(0, 2).join(' ').toLowerCase()
}

// ── Main entry point ─────────────────────────────────────────

export function generateMatchInsights(userA: Profile, userB: Profile): MatchInsight[] {
  const candidates: Candidate[] = []

  const aPurposes = toStringArray(userA.purposes).map(humanize)
  const bPurposes = toStringArray(userB.purposes).map(humanize)
  const sharedPurposes = setIntersect(aPurposes, bPurposes)

  // 1. Purposes overlap
  if (sharedPurposes.length > 0) {
    const top = sharedPurposes.slice(0, 2)
    candidates.push({ kind: 'purposes', subject: joinList(top) })
  }

  // 2. Bio keyword overlap
  const aKw = bioKeywords(userA.bio)
  const bKw = bioKeywords(userB.bio)
  const sharedKw: string[] = []
  for (const k of Array.from(aKw)) if (bKw.has(k)) sharedKw.push(k)
  if (sharedKw.length > 0) {
    const ACRONYMS = new Set(['ai', 'ip', 'esg', 'saas', 'm&a'])
    const top = sharedKw.slice(0, 2).map(k => {
      if (ACRONYMS.has(k.toLowerCase())) return k.toUpperCase()
      return k.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    })
    const subject = top.length === 1 ? top[0] + '-related work' : joinList(top)
    candidates.push({ kind: 'keywords', subject })
  }

  // 3. Intro preference reciprocity (mutual only)
  const aWants = toStringArray(userA.intro_preferences)
  const bWants = toStringArray(userB.intro_preferences)
  const aMatchesBWants = introPrefReciprocity(bWants, userA.title || '', userA.role_type || '', userA.seniority || '', userA.company || '')
  const bMatchesAWants = introPrefReciprocity(aWants, userB.title || '', userB.role_type || '', userB.seniority || '', userB.company || '')
  if (aMatchesBWants && bMatchesAWants) {
    candidates.push({ kind: 'intro_prefs', subject: '' })
  }

  // 4. Mentorship signal
  const aMentor = userA.open_to_mentorship === true
  const bMentor = userB.open_to_mentorship === true
  const aBucket = seniorityBucket(userA.seniority)
  const bBucket = seniorityBucket(userB.seniority)
  const isJuniorish = (b: typeof aBucket) => b === 'junior' || b === 'mid'
  const isSeniorish = (b: typeof aBucket) => b === 'senior' || b === 'executive'
  if (aMentor && bMentor) {
    candidates.push({ kind: 'mentorship', subject: '' })
  } else if ((aMentor && isSeniorish(aBucket) && isJuniorish(bBucket)) ||
             (bMentor && isSeniorish(bBucket) && isJuniorish(aBucket))) {
    candidates.push({ kind: 'mentorship', subject: '' })
  }

  // 5. Seniority alignment
  if (aBucket && bBucket) {
    if (aBucket === bBucket && aBucket === 'executive') {
      candidates.push({ kind: 'seniority', subject: '' })
    } else if (aBucket === bBucket) {
      candidates.push({ kind: 'seniority', subject: '' })
    } else if ((aBucket === 'senior' && bBucket === 'executive') || (aBucket === 'executive' && bBucket === 'senior')) {
      candidates.push({ kind: 'seniority', subject: '' })
    }
  }

  // 6. Shared personal interests
  const aInterests = toStringArray(userA.interests)
  const bInterests = toStringArray(userB.interests)
  const sharedInterests = setIntersect(aInterests, bInterests)
  const kwAlreadySurfaced = new Set<string>()
  for (const k of sharedKw) kwAlreadySurfaced.add(k.toLowerCase())
  const personalOnly = sharedInterests.filter(s => !kwAlreadySurfaced.has(s.toLowerCase()))
  if (personalOnly.length > 0) {
    const top = personalOnly.slice(0, 2).map(t => t.toLowerCase())
    const subject = top.length === 1 ? top[0] : top.join(' and ')
    candidates.push({ kind: 'interests', subject })
  }

  // Dedupe by kind, cap at 2, preserve professional-first priority by push order.
  const seen = new Set<Kind>()
  const picked: Candidate[] = []
  for (const c of candidates) {
    if (seen.has(c.kind)) continue
    seen.add(c.kind)
    picked.push(c)
    if (picked.length >= 2) break
  }

  // Collision-aware rendering: if both bullets would share the first 2-word stem,
  // bump the second bullet to its next acceptable phrase.
  if (picked.length === 2) {
    const firstText = renderCandidate(picked[0], 0)
    let secondIdx = 0
    while (secondIdx < PHRASES[picked[1].kind].length - 1) {
      const secondText = renderCandidate(picked[1], secondIdx)
      if (firstTwoWords(firstText) !== firstTwoWords(secondText)) break
      secondIdx++
    }
    return [
      { kind: picked[0].kind, text: renderCandidate(picked[0], 0) },
      { kind: picked[1].kind, text: renderCandidate(picked[1], secondIdx) }
    ]
  }

  return picked.map(c => ({ kind: c.kind, text: renderCandidate(c, 0) }))
}
