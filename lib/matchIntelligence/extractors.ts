// Match Intelligence — signal extractors (Phase A, display-only).
//
// A registry of pure extractors that turn TWO already-fetched profiles into
// concise, member-friendly "why we recommended this connection" signals. This is
// entirely SEPARATE from scoring/ranking — it reads nothing the surfaces don't
// already have and writes nothing. Phase A uses ONLY existing profile fields
// (role_type, seniority, expertise, purposes, mentorship_role, location); it does
// NOT read the focus-areas, additional-roles, or previous-employer fields.
//
// Adding a future signal = add one extractor to EXTRACTORS. The builder/card never
// change. (Focus areas, additional roles, previous employers, etc. arrive in later
// phases as new extractors.)

export type SignalCategory =
  | 'role'
  | 'expertise'
  | 'purpose'
  | 'seniority'
  | 'mentorship'
  | 'geography'

export interface MatchSignal {
  /** Stable de-dupe key (same concept → same key). */
  key: string
  category: SignalCategory
  /** Concise, member-friendly sentence. */
  label: string
  /** Primary sort — LOWER shows first (category order). */
  priority: number
  /** Secondary sort (tie-break) — HIGHER shows first (more specific first). */
  specificity: number
}

// ── Local pure helpers (no imports from scoring/reason modules) ───────────────

/** Normalize array | JSON-string | pg-array | csv | single → string[]. */
export function toList(value: unknown): string[] {
  if (value == null) return []
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
  if (typeof value !== 'string') return []
  let t = value.trim()
  if (!t || t === '{}' || t === '[]') return []
  if (t.startsWith('[') && t.endsWith(']')) {
    try { const j = JSON.parse(t); if (Array.isArray(j)) return j.map((x: any) => String(x).trim()).filter(Boolean) } catch { /* fall through */ }
  }
  if (t.startsWith('{') && t.endsWith('}')) t = t.slice(1, -1)
  return t.split(',').map((s) => s.replace(/^"|"$/g, '').trim()).filter(Boolean)
}

/** Case-insensitive scalar equality. */
function eqField(a: unknown, b: unknown): boolean {
  return Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase())
}

/** Lowercase-exact set intersection; returns the viewed-side casing, capped. */
function overlap(viewerVal: unknown, viewedVal: unknown, max: number): string[] {
  const viewerSet = new Set(toList(viewerVal).map((s) => s.toLowerCase()))
  const out: string[] = []
  for (const x of toList(viewedVal)) {
    if (viewerSet.has(x.toLowerCase())) out.push(x)
    if (out.length >= max) break
  }
  return out
}

/** Join a short list into "a, b and c". */
function humanJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

// ── Copy maps ────────────────────────────────────────────────────────────────

/** Map a role_type to a friendly field noun; null → generic "work as {role}". */
function fieldFor(roleType: string): string | null {
  const r = roleType.toLowerCase()
  if (/legal|counsel|attorney|lawyer/.test(r)) return 'legal'
  if (/finance|cfo|accounting|treasur/.test(r)) return 'finance'
  if (/engineer|developer|technolog|cto|software|\bdata\b|security|cyber/.test(r)) return 'technology'
  if (/market/.test(r)) return 'marketing'
  if (/sales|revenue/.test(r)) return 'sales'
  if (/\bproduct\b/.test(r)) return 'product'
  if (/people|human resources|\bhr\b|talent|recruit/.test(r)) return 'people & talent'
  if (/operat/.test(r)) return 'operations'
  if (/policy|government|regulat|public affairs/.test(r)) return 'government & policy'
  if (/health|clinical|medical|life science/.test(r)) return 'healthcare'
  if (/invest|venture|private equity|\bvc\b|capital/.test(r)) return 'investing'
  if (/consult|advisor/.test(r)) return 'consulting'
  return null
}

const PURPOSE_PHRASES: Record<string, string> = {
  networking: 'expand your professional network',
  'expand network': 'expand your professional network',
  hiring: 'hire talent',
  'hire talent': 'hire talent',
  fundraising: 'raise capital',
  'raise capital': 'raise capital',
  mentorship: 'connect around mentorship',
  'give back / mentor': 'connect around mentorship',
  partnerships: 'explore partnerships',
  'business development': 'grow business',
  'find customers': 'find new customers',
  'advice / expertise': 'exchange advice and expertise',
  'learn & grow': 'learn and grow',
  'explore opportunities': 'explore new opportunities',
}

// ── Extractors: (viewer, viewed) → MatchSignal[] ─────────────────────────────

/** Role framing (context) — leads the card. */
function roleExtractor(v: any, w: any): MatchSignal[] {
  if (!eqField(v?.role_type, w?.role_type)) return []
  const field = fieldFor(String(w.role_type))
  const label = field ? `You both work in ${field}.` : `You both work as ${String(w.role_type)}.`
  return [{ key: 'role', category: 'role', label, priority: 10, specificity: 50 }]
}

/** Shared expertise — most specific professional overlap. */
function expertiseExtractor(v: any, w: any): MatchSignal[] {
  const shared = overlap(v?.expertise, w?.expertise, 3)
  if (shared.length === 0) return []
  return [{
    key: 'expertise',
    category: 'expertise',
    label: `Shared expertise in ${humanJoin(shared.map((s) => s.toLowerCase()))}.`,
    priority: 20,
    specificity: 90,
  }]
}

/** Mentorship compatibility. */
function mentorshipExtractor(v: any, w: any): MatchSignal[] {
  const a = String(v?.mentorship_role || '').toLowerCase()
  const b = String(w?.mentorship_role || '').toLowerCase()
  if (!a || !b) return []
  const complementary = (a.includes('mentor') && b.includes('mentee')) || (a.includes('mentee') && b.includes('mentor'))
  const label = complementary ? 'Your mentorship interests are complementary.' : 'Your mentorship preferences align.'
  return [{ key: 'mentorship', category: 'mentorship', label, priority: 30, specificity: 45 }]
}

/** Shared goals/purposes (intent). */
function purposeExtractor(v: any, w: any): MatchSignal[] {
  const shared = overlap(v?.purposes, w?.purposes, 2)
  if (shared.length === 0) return []
  const phrase = shared.map((p) => PURPOSE_PHRASES[p.toLowerCase()]).find(Boolean)
  const label = phrase ? `You're both looking to ${phrase}.` : `You share professional goals around ${humanJoin(shared.map((s) => s.toLowerCase()))}.`
  return [{ key: 'purpose', category: 'purpose', label, priority: 40, specificity: 40 }]
}

/** Exact geography overlap (supporting). */
function geographyExtractor(v: any, w: any): MatchSignal[] {
  if (!eqField(v?.location, w?.location)) return []
  // Use the viewer's own casing for the shared location (the card is theirs).
  return [{ key: 'geography', category: 'geography', label: `You're both based in ${String(v.location)}.`, priority: 50, specificity: 70 }]
}

/** Similar career stage (lowest-priority supporting; friendly, not "Similar seniority"). */
function seniorityExtractor(v: any, w: any): MatchSignal[] {
  if (!eqField(v?.seniority, w?.seniority)) return []
  return [{ key: 'seniority', category: 'seniority', label: "You're at a similar career stage.", priority: 60, specificity: 30 }]
}

/** The registry — add future extractors here; nothing else changes. */
export const EXTRACTORS: Array<(v: any, w: any) => MatchSignal[]> = [
  roleExtractor,
  expertiseExtractor,
  mentorshipExtractor,
  purposeExtractor,
  geographyExtractor,
  seniorityExtractor,
]
