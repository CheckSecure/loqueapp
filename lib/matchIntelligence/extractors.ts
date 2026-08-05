// Match Intelligence — signal extractors (Phases A + B, display-only).
//
// A registry of pure extractors that turn TWO profiles (+ a light context of
// already-stored data) into concise "why we recommended this connection" signals.
// Entirely SEPARATE from scoring/ranking — reads nothing new the surfaces can't
// already fetch, writes nothing, and never influences who is matched.
//
// Phase A signals come from the profile objects: role_type, seniority, expertise,
// purposes, mentorship_role, location. Phase B signals come from the CONTEXT
// (fetched once, in bulk, fail-open by the surface): current focus areas,
// additional roles/affiliations, and previous employers. Adding a future signal =
// add one extractor to EXTRACTORS; the builder/card never change.

export type SignalCategory =
  | 'role'
  | 'focus'
  | 'affiliation'
  | 'expertise'
  | 'previous'
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
  /**
   * Normalized concept term(s) this signal represents, for cross-signal concept
   * de-dupe (e.g. a "focus: nuclear energy" claim suppresses an identical
   * "expertise: nuclear energy" line). Undefined → not concept-deduped.
   */
  terms?: string[]
  /**
   * Display token (org / company / focus area / expertise list / purpose) used by
   * the conversation-starter generator. Undefined → no specific value to reference.
   */
  value?: string
}

/** Lightweight shapes the surface passes in (subsets of the real rows). */
export interface RoleLite {
  organization_name?: string | null
  role_category?: string | null
  is_current?: boolean | null
}
export interface PrevRoleLite {
  company?: string | null
  title?: string | null
}

/** Phase B data, fetched once per surface (bulk, fail-open) and passed in. */
export interface MatchContext {
  viewerFocus?: unknown
  viewedFocus?: unknown
  viewerRoles?: RoleLite[]
  viewedRoles?: RoleLite[]
  viewerPrev?: PrevRoleLite[]
  viewedPrev?: PrevRoleLite[]
}

// ── Local pure helpers (no imports from scoring/reason modules) ───────────────

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

function eqField(a: unknown, b: unknown): boolean {
  return Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase())
}

/** Lowercase-exact intersection; returns the VIEWER-side casing, capped. */
function overlapViewer(viewerVal: unknown, viewedVal: unknown, max: number): string[] {
  const viewedSet = new Set(toList(viewedVal).map((s) => s.toLowerCase()))
  const out: string[] = []
  for (const x of toList(viewerVal)) {
    if (viewedSet.has(x.toLowerCase())) out.push(x)
    if (out.length >= max) break
  }
  return out
}

function humanJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

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

// Shared additional-role category → phrase (both members share the category).
const CATEGORY_PHRASES: Record<string, string> = {
  board_member: 'You both serve on boards.',
  advisor: 'You both hold advisory roles.',
  investor_fund: 'You share experience in investment-fund governance.',
  committee_leadership: 'You both hold committee leadership roles.',
  government_policy: 'You both work in government and policy.',
  professional_association: "You're both active in professional associations.",
  nonprofit: "You're both involved with nonprofits.",
  academic: 'You both hold academic roles.',
}
// Preference order when several categories are shared (highest-value first).
const CATEGORY_ORDER = [
  'board_member', 'advisor', 'investor_fund', 'committee_leadership',
  'government_policy', 'professional_association', 'nonprofit', 'academic',
]

const normOrg = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

// ── Phase A extractors: (viewer, viewed) ─────────────────────────────────────

function roleExtractor(v: any, w: any): MatchSignal[] {
  if (!eqField(v?.role_type, w?.role_type)) return []
  const field = fieldFor(String(w.role_type))
  const label = field ? `You both work in ${field}.` : `You both work as ${String(w.role_type)}.`
  return [{ key: 'role', category: 'role', label, priority: 10, specificity: 50 }]
}

function expertiseExtractor(v: any, w: any): MatchSignal[] {
  const shared = overlapViewer(v?.expertise, w?.expertise, 3)
  if (shared.length === 0) return []
  return [{
    key: 'expertise', category: 'expertise',
    label: `Shared expertise in ${humanJoin(shared.map((s) => s.toLowerCase()))}.`,
    priority: 40, specificity: 80, terms: shared.map((s) => s.toLowerCase()),
    value: humanJoin(shared.slice(0, 2).map((s) => s.toLowerCase())),
  }]
}

function mentorshipExtractor(v: any, w: any): MatchSignal[] {
  const a = String(v?.mentorship_role || '').toLowerCase()
  const b = String(w?.mentorship_role || '').toLowerCase()
  if (!a || !b) return []
  const complementary = (a.includes('mentor') && b.includes('mentee')) || (a.includes('mentee') && b.includes('mentor'))
  const label = complementary ? 'Your mentorship interests are complementary.' : 'Your mentorship preferences align.'
  return [{ key: 'mentorship', category: 'mentorship', label, priority: 60, specificity: 45 }]
}

function purposeExtractor(v: any, w: any): MatchSignal[] {
  const shared = overlapViewer(v?.purposes, w?.purposes, 2)
  if (shared.length === 0) return []
  const phrase = shared.map((p) => PURPOSE_PHRASES[p.toLowerCase()]).find(Boolean)
  const label = phrase ? `You're both looking to ${phrase}.` : `You share professional goals around ${humanJoin(shared.map((s) => s.toLowerCase()))}.`
  return [{ key: 'purpose', category: 'purpose', label, priority: 70, specificity: 40, value: shared[0] }]
}

function geographyExtractor(v: any, w: any): MatchSignal[] {
  if (!eqField(v?.location, w?.location)) return []
  return [{ key: 'geography', category: 'geography', label: `You're both based in ${String(v.location)}.`, priority: 80, specificity: 70 }]
}

function seniorityExtractor(v: any, w: any): MatchSignal[] {
  if (!eqField(v?.seniority, w?.seniority)) return []
  return [{ key: 'seniority', category: 'seniority', label: "You're at a similar career stage.", priority: 90, specificity: 30 }]
}

// ── Phase B extractors: (viewer, viewed, ctx) ────────────────────────────────

/** Current focus areas — exact case-insensitive overlap, up to 2 reasons. */
function focusAreasExtractor(_v: any, _w: any, ctx: MatchContext): MatchSignal[] {
  const shared = overlapViewer(ctx.viewerFocus, ctx.viewedFocus, 2)
  return shared.map((area) => ({
    key: `focus:${area.toLowerCase()}`, category: 'focus' as const,
    label: `You're both currently focused on ${area}.`,
    priority: 20, specificity: 95, terms: [area.toLowerCase()], value: area,
  }))
}

/** Additional roles & affiliations — shared org first, else a shared category. */
function additionalRolesExtractor(_v: any, _w: any, ctx: MatchContext): MatchSignal[] {
  const vr = ctx.viewerRoles ?? []
  const wr = ctx.viewedRoles ?? []
  if (vr.length === 0 || wr.length === 0) return []
  const out: MatchSignal[] = []

  // 1) Same organization (association / board / nonprofit / university). Specific.
  const wByOrg = new Map<string, RoleLite>()
  for (const r of wr) { const k = normOrg(r.organization_name); if (k) wByOrg.set(k, r) }
  const seenOrg = new Set<string>()
  for (const r of vr) {
    const k = normOrg(r.organization_name)
    if (!k || seenOrg.has(k) || !wByOrg.has(k)) continue
    seenOrg.add(k)
    const other = wByOrg.get(k)!
    const leadership = [r.role_category, other.role_category].some((c) => c === 'board_member' || c === 'committee_leadership')
    const org = String(r.organization_name).trim()
    out.push({
      key: `affiliation:org:${k}`, category: 'affiliation',
      label: `You're both active in ${org}${leadership ? ' leadership' : ''}.`,
      priority: 30, specificity: 90, terms: [k], value: org,
    })
    if (out.length >= 2) return out
  }
  if (out.length > 0) return out

  // 2) No shared org → a single shared-category signal (most valuable first).
  const vCats = new Set(vr.map((r) => String(r.role_category || '')))
  const wCats = new Set(wr.map((r) => String(r.role_category || '')))
  for (const c of CATEGORY_ORDER) {
    if (vCats.has(c) && wCats.has(c)) {
      out.push({ key: `affiliation:cat:${c}`, category: 'affiliation', label: CATEGORY_PHRASES[c], priority: 30, specificity: 60 })
      return out
    }
  }
  // Board-or-advisory catch (one board, one advisor, or vice versa).
  const boardOrAdvisory = (cats: Set<string>) => cats.has('board_member') || cats.has('advisor')
  if (boardOrAdvisory(vCats) && boardOrAdvisory(wCats)) {
    out.push({ key: 'affiliation:cat:board_advisory', category: 'affiliation', label: 'You both serve in board or advisory roles.', priority: 30, specificity: 60 })
  }
  return out
}

/** Previous employers — EXACT organization overlap only (no title inference). */
function previousRolesExtractor(_v: any, _w: any, ctx: MatchContext): MatchSignal[] {
  const vPrev = (ctx.viewerPrev ?? []).map((p) => String(p.company ?? '')).filter(Boolean)
  const wSet = new Set((ctx.viewedPrev ?? []).map((p) => normOrg(p.company)).filter(Boolean))
  for (const company of vPrev) {
    const k = normOrg(company)
    if (k && wSet.has(k)) {
      return [{
        key: `previous:${k}`, category: 'previous',
        label: `You both previously worked at ${company.trim()}.`,
        priority: 50, specificity: 85, terms: [k], value: company.trim(),
      }]
    }
  }
  return []
}

/** The registry — extraction order is irrelevant (the builder ranks). */
export const EXTRACTORS: Array<(v: any, w: any, ctx: MatchContext) => MatchSignal[]> = [
  roleExtractor,
  focusAreasExtractor,
  additionalRolesExtractor,
  expertiseExtractor,
  previousRolesExtractor,
  mentorshipExtractor,
  purposeExtractor,
  geographyExtractor,
  seniorityExtractor,
]
