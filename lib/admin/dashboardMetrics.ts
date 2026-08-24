/**
 * Admin dashboard metrics — the aggregation layer behind app/dashboard/admin/page.tsx.
 *
 * DESIGN
 *  • PURE classifiers (exported, unit-tested with plain fixtures) do all the counting/
 *    bucketing/threshold logic. They never touch the DB, so their definitions are exact
 *    and verifiable.
 *  • IO loaders fetch the minimum rows in a bounded number of aggregate queries (no N+1),
 *    then hand off to the pure classifiers. Each loader is wrapped so ONE unavailable
 *    dependency degrades ONLY its own section ({ unavailable, reason }) — never the page.
 *  • Everything here runs SERVER-SIDE with the service-role client. The page is the
 *    admin-only gate; nothing in this module is import-safe for the client bundle.
 *
 * HONESTY RULE: when a metric has no reliable persisted source (cron-run history,
 * recommendation-generation failures, auth 5xx), we return { unavailable, reason } and the
 * UI shows "Unavailable"/"Not connected" — we never synthesize a healthy/green value.
 */
import { MAX_VISIBLE_INTRO_CARDS, VISIBLE_STATUS } from '@/lib/introductions/capacity'
import { EXPRESSED_INTEREST_STATUSES } from '@/lib/introductions/queue'

// ── Documented thresholds (every "needs attention" rule cites one of these) ──────────
export const THRESHOLDS = {
  /** An invitation still in-flight (claimed/accepted/deferred) longer than this is STUCK.
   *  Resend delivers in seconds–minutes; 24h absorbs legitimate provider deferrals. */
  DELIVERY_STUCK_HOURS: 24,
  /** Delivered-but-not-activated age buckets, in hours: 24h, 3d, 7d. */
  ACTIVATION_BUCKET_HOURS: [24, 72, 168] as const,
  /** Reciprocal rotation window — mirrors expire_stale_reciprocal_pairs p_rotation_days=14. */
  ROTATION_DAYS: 14,
  /** A still-active pair older than this (but < ROTATION_DAYS) is "nearing rotation". */
  ROTATION_NEARING_DAYS: 11,
  /** Webhook-health lookback for the recent error-rate reading. */
  WEBHOOK_LOOKBACK_HOURS: 168,
  /** Exposure concentration alerts only when the top inbound count is both materially
   *  large (>= MIN) AND a multiple of the median — so small pools never false-alarm. */
  EXPOSURE_ALERT_MIN: 4,
  EXPOSURE_ALERT_MULTIPLE: 3,
} as const

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** Outbound statuses that OCCUPY a member's visible recommendation slots. */
export const ACTIVE_SUGGESTION_STATUSES = ['suggested', 'queued'] as const
/** Terminal-failure delivery states. */
export const FAILED_DELIVERY_STATUSES = ['bounced', 'blocked', 'complained', 'failed'] as const
/** In-flight (non-terminal, non-failed) delivery states. */
export const PENDING_DELIVERY_STATUSES = ['claimed', 'accepted', 'deferred'] as const
/** Webhook event results that mean processing did NOT complete. */
export const WEBHOOK_ERROR_RESULTS = ['error', 'not_found'] as const

// ── Generic pure helpers ─────────────────────────────────────────────────────────────
export function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/** Canonical unordered pair key; null for self/invalid so messy rows can't double-count. */
export function pairKey(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a || !b || a === b) return null
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

/** Unique matched pairs, canonicalized so a stray reverse row never double-counts. */
export function countUniqueMatchedPairs(rows: Array<{ user_a_id?: string; user_b_id?: string }>): number {
  const set = new Set<string>()
  for (const r of rows ?? []) {
    const k = pairKey(r.user_a_id, r.user_b_id)
    if (k) set.add(k)
  }
  return set.size
}

// ── Invitations & activation (pure) ──────────────────────────────────────────────────
// A person can have MANY invitation_deliveries rows (first_invite + reminder + access_resend
// + retries). All headline metrics (Delivered/Activated/conversion) count PEOPLE (invitees),
// never attempts: we collapse every attempt to ONE canonical invitee, derive that invitee's
// CURRENT delivery state by latest event time (so a later delivered resend beats an earlier
// bounce, and a later terminal bounce/complaint after a delivery is represented correctly),
// then count invitees. Attempt-level totals are preserved separately under `attempts`.
export interface DeliveryRow {
  status: string
  purpose?: string | null
  created_at?: string | null
  delivered_at?: string | null
  last_event_at?: string | null
  auth_user_id?: string | null
  recipient_email?: string | null
  waitlist_id?: string | null
}
export interface ActivationLookup {
  /** auth_user_id → has ever signed in (last_sign_in_at not null). */
  byId: Map<string, boolean>
  /** normalized recipient_email → has ever signed in. */
  byEmail: Map<string, boolean>
}
export interface InvitationMetrics {
  awaitingReview: number
  invited: number                        // unique invited invitees (waitlist status='invited')
  deliveryPending: number                // unique invitees currently in-flight
  deliveryStuck: number                  // subset in-flight past DELIVERY_STUCK_HOURS
  delivered: number                      // unique invitees whose CURRENT state is 'delivered'
  failed: number                         // unique invitees whose CURRENT state is terminal-failure
  activated: number | null               // unique delivered invitees who signed in (null if source incomplete)
  notActivated24h: number | null
  notActivated3d: number | null
  notActivated7d: number | null
  conversionRate: number | null          // activated ÷ unique DELIVERED invitees
  conversionDenominator: 'unique_delivered_invitees'
  historicalUnknown: number              // invited invitees with NO delivery record (pre-tracking)
  activationAvailable: boolean           // false → activation figures are 'unavailable', not partial
  // Attempt-level operational counts (NOT people) — labeled separately in the UI.
  attempts: { total: number; delivered: number; failed: number; byPurpose: Record<string, number> }
  unattributableAttempts: number         // delivery rows with no waitlist_id/auth_user_id/email
  manualReview: number                   // attempts an email-reassignment conflict makes ambiguous
}

export function normalizeEmail(e: string | null | undefined): string | null {
  const t = (e ?? '').trim().toLowerCase()
  return t || null
}

const parseMs = (s?: string | null): number => (s ? Date.parse(s) || 0 : 0)
/** Latest meaningful event time for an attempt (webhook event, else delivery, else creation). */
function attemptEventTime(r: DeliveryRow): number {
  return Math.max(parseMs(r.last_event_at), parseMs(r.delivered_at), parseMs(r.created_at))
}

export interface Invitee {
  key: string
  currentStatus: string
  currentEventTime: number
  currentDeliveredAt: string | null // set only when currentStatus === 'delivered'
  authIds: string[]
  emails: string[]
}

/** Minimal union-find (disjoint set) over string identifier nodes; deterministic roots (min string). */
class UnionFind {
  private parent = new Map<string, string>()
  find(x: string): string {
    let p = this.parent.get(x)
    if (p === undefined) { this.parent.set(x, x); return x }
    if (p !== x) { p = this.find(p); this.parent.set(x, p) }
    return p
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b)
    if (ra === rb) return
    if (ra < rb) this.parent.set(rb, ra); else this.parent.set(ra, rb) // smaller string wins → deterministic
  }
}

const wNode = (id: string) => `w:${id}`
const aNode = (id: string) => `a:${id}`
const eNode = (email: string) => `e:${email}`

/**
 * CONNECTED-IDENTITY grouping. Each delivery attempt is a hyper-edge joining its identifiers
 * (waitlist_id, auth_user_id, normalized email). Any shared identifier transitively merges
 * attempts into ONE invitee (connected component), so W↔E and A↔E rows sharing email E collapse
 * to a single person — a row-local precedence key would split them.
 *
 * EMAIL-REASSIGNMENT SAFETY: if an email is affirmatively linked to TWO different Auth user ids
 * (evidence it was reassigned), that email is CONFLICTED and is NOT used as a merge edge — so it
 * cannot bridge two distinct people. Rows still carrying a strong id (waitlist/auth) attribute to
 * that id; a row whose ONLY identifier is a conflicted email is ambiguous → counted as
 * `manualReview` (surfaced, never guessed). Output is deterministic regardless of row order
 * (union roots are the lexicographically-smallest node; invitees are sorted by key).
 */
export function groupInvitees(deliveries: DeliveryRow[]): { invitees: Invitee[]; unattributable: number; manualReview: number } {
  const rows = deliveries ?? []

  // 1. Detect conflicted (reassigned) emails: normalized email → distinct auth ids seen with it.
  const emailAuth = new Map<string, Set<string>>()
  for (const r of rows) {
    const e = normalizeEmail(r.recipient_email)
    if (e && r.auth_user_id) {
      const s = emailAuth.get(e) ?? new Set<string>()
      s.add(r.auth_user_id); emailAuth.set(e, s)
    }
  }
  const conflicted = new Set<string>()
  for (const [e, ids] of Array.from(emailAuth.entries())) if (ids.size > 1) conflicted.add(e)

  // 2. Union-find over identifier nodes; email edges only for NON-conflicted emails.
  const uf = new UnionFind()
  const rootOfRow: (string | null)[] = []
  let unattributable = 0, manualReview = 0
  for (const r of rows) {
    const ids: string[] = []
    if (r.waitlist_id) ids.push(wNode(r.waitlist_id))
    if (r.auth_user_id) ids.push(aNode(r.auth_user_id))
    const e = normalizeEmail(r.recipient_email)
    if (e && !conflicted.has(e)) ids.push(eNode(e))
    if (ids.length === 0) {
      // No usable identifier: a conflicted-email-only row is ambiguous; else truly unattributable.
      if (e && conflicted.has(e)) manualReview++; else unattributable++
      rootOfRow.push(null); continue
    }
    ids.forEach((id) => uf.find(id))
    for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i])
    rootOfRow.push(ids[0])
  }

  // 3. Group rows by connected-component root, THEN derive each invitee's current state.
  const comp = new Map<string, DeliveryRow[]>()
  rows.forEach((r, i) => {
    const n = rootOfRow[i]; if (!n) return
    const root = uf.find(n)
    const arr = comp.get(root)
    if (arr) arr.push(r); else comp.set(root, [r])
  })
  const invitees: Invitee[] = []
  for (const [root, crows] of Array.from(comp.entries())) {
    // Current attempt = latest by event time; deterministic tie-break by created_at then status.
    const current = crows.reduce((best, r) => {
      const be = attemptEventTime(best), re = attemptEventTime(r)
      if (re > be) return r
      if (re < be) return best
      const bc = parseMs(best.created_at), rc = parseMs(r.created_at)
      if (rc > bc) return r
      if (rc < bc) return best
      return r.status < best.status ? r : best // final stable tie-break
    }, crows[0])
    invitees.push({
      key: root,
      currentStatus: current.status,
      currentEventTime: attemptEventTime(current),
      currentDeliveredAt: current.status === 'delivered' ? (current.delivered_at ?? null) : null,
      authIds: crows.map((r) => r.auth_user_id).filter(Boolean) as string[],
      emails: crows.map((r) => normalizeEmail(r.recipient_email)).filter(Boolean) as string[],
    })
  }
  invitees.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) // deterministic output order
  return { invitees, unattributable, manualReview }
}

function inviteeActivated(inv: Invitee, act: ActivationLookup): boolean {
  return inv.authIds.some((id) => act.byId.get(id) === true) || inv.emails.some((e) => act.byEmail.get(e) === true)
}

/**
 * @param invitedTracked      invited waitlist entries that DO have a delivery record
 * @param activationAvailable false when the Auth listing was incomplete — then activation
 *                            figures are returned as null ('unavailable'), never a partial count
 */
export function classifyInvitations(args: {
  deliveries: DeliveryRow[]
  waitlistStatuses: string[]
  invitedTotal: number
  invitedTracked: number
  activation: ActivationLookup
  activationAvailable: boolean
  now: number
}): InvitationMetrics {
  const { deliveries, waitlistStatuses, invitedTotal, invitedTracked, activation, activationAvailable, now } = args
  const awaitingReview = waitlistStatuses.filter((s) => s === 'pending').length
  const { invitees, unattributable, manualReview } = groupInvitees(deliveries)

  let deliveryPending = 0, deliveryStuck = 0, failed = 0
  const deliveredInvitees: Invitee[] = []
  for (const inv of invitees) {
    if (inv.currentStatus === 'delivered') { deliveredInvitees.push(inv); continue }
    if (FAILED_DELIVERY_STATUSES.includes(inv.currentStatus as any)) { failed++; continue }
    if (PENDING_DELIVERY_STATUSES.includes(inv.currentStatus as any)) {
      deliveryPending++
      if (inv.currentEventTime > 0 && now - inv.currentEventTime >= THRESHOLDS.DELIVERY_STUCK_HOURS * HOUR_MS) deliveryStuck++
    }
  }
  const delivered = deliveredInvitees.length

  let activated: number | null = null
  let buckets: [number, number, number] | [null, null, null] = [null, null, null]
  let conversionRate: number | null = null
  if (activationAvailable) {
    activated = 0
    const b: [number, number, number] = [0, 0, 0]
    for (const inv of deliveredInvitees) {
      if (inviteeActivated(inv, activation)) { activated++; continue }
      const ageMs = inv.currentDeliveredAt ? now - parseMs(inv.currentDeliveredAt) : 0
      THRESHOLDS.ACTIVATION_BUCKET_HOURS.forEach((h, i) => { if (ageMs >= h * HOUR_MS) b[i]++ })
    }
    buckets = b
    conversionRate = delivered > 0 ? Math.round((activated / delivered) * 100) : null // denom = unique delivered invitees
  }

  // Attempt-level (operational) — counts ROWS, not people.
  const byPurpose: Record<string, number> = {}
  let deliveredAttempts = 0, failedAttempts = 0
  for (const d of deliveries ?? []) {
    const purpose = d.purpose ?? 'unknown'
    byPurpose[purpose] = (byPurpose[purpose] ?? 0) + 1
    if (d.status === 'delivered') deliveredAttempts++
    if (FAILED_DELIVERY_STATUSES.includes(d.status as any)) failedAttempts++
  }

  return {
    awaitingReview,
    invited: invitedTotal,
    deliveryPending,
    deliveryStuck,
    delivered,
    failed,
    activated,
    notActivated24h: buckets[0],
    notActivated3d: buckets[1],
    notActivated7d: buckets[2],
    conversionRate,
    conversionDenominator: 'unique_delivered_invitees',
    historicalUnknown: Math.max(0, invitedTotal - invitedTracked),
    activationAvailable,
    attempts: { total: (deliveries ?? []).length, delivered: deliveredAttempts, failed: failedAttempts, byPurpose },
    unattributableAttempts: unattributable,
    manualReview,
  }
}

// ── Recommendations & matching (pure) ────────────────────────────────────────────────
export interface IntroRow {
  requester_id: string
  target_user_id: string
  status: string
  is_admin_initiated?: boolean | null
  pair_id?: string | null
  batch_id?: string | null
}
export interface PairRow {
  status: string
  last_recommended_at?: string | null
}
export interface ExposureStats {
  median: number
  max: number
  concentrationAlert: boolean
}
export interface RecommendationMetrics {
  eligibleWithoutRec: number
  reciprocalPairsCreated: number
  activeReciprocalSuggestions: number  // directional cards with a pair_id, status suggested
  oneSidedLegacySuggestions: number    // status suggested, no pair_id (legacy batch model)
  membersAtCapacity: number
  nearingRotation: number
  staleOverdue: number
  interestExpressed: number
  mutualMatches: number
  upcomingMeetingsFromMatches: number
  exposure: ExposureStats
}

export function exposureStats(inboundCounts: number[]): ExposureStats {
  if (inboundCounts.length === 0) return { median: 0, max: 0, concentrationAlert: false }
  const med = median(inboundCounts)
  const max = Math.max(...inboundCounts)
  const concentrationAlert = max >= THRESHOLDS.EXPOSURE_ALERT_MIN && max >= Math.max(med, 1) * THRESHOLDS.EXPOSURE_ALERT_MULTIPLE
  return { median: med, max, concentrationAlert }
}

export function classifyRecommendations(args: {
  intros: IntroRow[]
  pairs: PairRow[]
  eligibleIds: string[]
  matchPairKeys: Set<string>       // canonical keys of active matches (for meeting attribution)
  matchedPairCount: number
  meetingPairKeys: string[]        // canonical keys of upcoming meetings (pair-attributed)
  now: number
}): RecommendationMetrics {
  const { intros, pairs, eligibleIds, matchPairKeys, matchedPairCount, meetingPairKeys, now } = args
  const eligibleSet = new Set(eligibleIds)

  // Outbound cards per requester, split by TIER. `outboundActive` (visible+reserved) answers "does
  // this member have anything live at all" → the coverage gap. `outboundVisible` ('suggested' only)
  // is the capacity question: a member holding two reservations and nothing visible is NOT at
  // capacity, and counting them as such is what hid the real over-capacity members.
  const outboundActive = new Map<string, number>()
  const outboundVisible = new Map<string, number>()
  const inbound = new Map<string, number>()
  let activeReciprocalSuggestions = 0
  let oneSidedLegacySuggestions = 0
  let interestExpressed = 0
  const expressedSet = new Set<string>(EXPRESSED_INTEREST_STATUSES as unknown as string[])

  for (const r of intros) {
    const isActive = ACTIVE_SUGGESTION_STATUSES.includes(r.status as any)
    if (isActive) {
      outboundActive.set(r.requester_id, (outboundActive.get(r.requester_id) ?? 0) + 1)
      if (r.status === VISIBLE_STATUS) outboundVisible.set(r.requester_id, (outboundVisible.get(r.requester_id) ?? 0) + 1)
      // inbound exposure counts BOTH reciprocal (pair_id) and legacy suggestion cards.
      inbound.set(r.target_user_id, (inbound.get(r.target_user_id) ?? 0) + 1)
    }
    if (r.status === 'suggested') {
      if (r.pair_id) activeReciprocalSuggestions++
      else oneSidedLegacySuggestions++
    }
    if (expressedSet.has(r.status)) interestExpressed++
  }

  const eligibleWithoutRec = eligibleIds.filter((id) => (outboundActive.get(id) ?? 0) === 0).length
  // ">=" not "==" deliberately: it must keep counting a member who is OVER the cap, so an
  // enforcement regression shows up as a rising number rather than disappearing from the metric.
  const membersAtCapacity = Array.from(outboundVisible.entries())
    .filter(([id, n]) => eligibleSet.has(id) && n >= MAX_VISIBLE_INTRO_CARDS).length

  // Rotation windows over active pairs.
  let nearingRotation = 0
  let staleOverdue = 0
  for (const p of pairs) {
    if (p.status !== 'active' || !p.last_recommended_at) continue
    const ageDays = (now - new Date(p.last_recommended_at).getTime()) / DAY_MS
    if (ageDays >= THRESHOLDS.ROTATION_DAYS) staleOverdue++
    else if (ageDays >= THRESHOLDS.ROTATION_NEARING_DAYS) nearingRotation++
  }

  // Exposure distribution across ALL eligible members (0-inclusive so median reflects typical).
  const inboundCounts = eligibleIds.map((id) => inbound.get(id) ?? 0)

  // Upcoming meetings attributable to a match (both members form a matched pair).
  const upcomingMeetingsFromMatches = meetingPairKeys.filter((k) => matchPairKeys.has(k)).length

  return {
    eligibleWithoutRec,
    reciprocalPairsCreated: pairs.length,
    activeReciprocalSuggestions,
    oneSidedLegacySuggestions,
    membersAtCapacity,
    nearingRotation,
    staleOverdue,
    interestExpressed,
    mutualMatches: matchedPairCount,
    upcomingMeetingsFromMatches,
    exposure: exposureStats(inboundCounts),
  }
}

// ── Needs Attention (pure) ───────────────────────────────────────────────────────────
export type Severity = 'high' | 'medium' | 'low'
export interface AttentionItem {
  id: string
  severity: Severity
  count: number
  title: string
  explanation: string
  href: string
}
/** A monitoring source we cannot read — surfaced honestly instead of a fake healthy state. */
export interface MonitoringGap {
  id: string
  label: string
  reason: string
  href: string
}
const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

export function computeNeedsAttention(input: {
  invitations?: InvitationMetrics | null
  recommendations?: RecommendationMetrics | null
  pendingMigrations?: Array<{ migration: string; message: string; impact: string }>
  webhookErrors?: number | null
  operational?: { waitlistPending?: number; concierge?: number; issues?: number; adminIntros?: number; batchNeedsReview?: boolean }
}): AttentionItem[] {
  const items: AttentionItem[] = []
  const inv = input.invitations
  if (inv) {
    if (inv.failed > 0) items.push({ id: 'inv-failed', severity: 'high', count: inv.failed, title: 'Invitation deliveries failed', explanation: 'Bounced, blocked, or hard-failed sends — inspect these invitees on the Waitlist (per-row delivery badge).', href: '/dashboard/admin/waitlist' })
    if (inv.deliveryStuck > 0) items.push({ id: 'inv-stuck', severity: 'high', count: inv.deliveryStuck, title: 'Deliveries stuck in flight', explanation: `In-flight longer than ${THRESHOLDS.DELIVERY_STUCK_HOURS}h with no terminal event — likely a provider/webhook problem; check the Waitlist delivery badges.`, href: '/dashboard/admin/waitlist' })
    if ((inv.notActivated7d ?? 0) > 0) items.push({ id: 'inv-na-7d', severity: 'medium', count: inv.notActivated7d as number, title: 'Delivered but not activated (7d+)', explanation: 'Delivered over 7 days ago; the invitee has never signed in — review on the Waitlist and consider a nudge.', href: '/dashboard/admin/waitlist' })
    else if ((inv.notActivated3d ?? 0) > 0) items.push({ id: 'inv-na-3d', severity: 'low', count: inv.notActivated3d as number, title: 'Delivered but not activated (3d+)', explanation: 'Delivered over 3 days ago; the invitee has never signed in — review on the Waitlist.', href: '/dashboard/admin/waitlist' })
  }
  if ((input.webhookErrors ?? 0) > 0) items.push({ id: 'webhook-errors', severity: 'high', count: input.webhookErrors as number, title: 'Invitation webhook errors', explanation: `Resend webhook events recorded an error/not-found result in the last ${THRESHOLDS.WEBHOOK_LOOKBACK_HOURS / 24}d — delivery status may be stale. Review delivery and webhook details on this page.`, href: '/dashboard/admin/operations' })

  const rec = input.recommendations
  if (rec) {
    if (rec.eligibleWithoutRec > 0) items.push({ id: 'rec-none', severity: 'medium', count: rec.eligibleWithoutRec, title: 'Eligible members without a recommendation', explanation: 'Active, complete members with zero suggestion cards — they see an empty state.', href: '/dashboard/admin/batches' })
    if (rec.staleOverdue > 0) items.push({ id: 'rec-stale', severity: 'medium', count: rec.staleOverdue, title: 'Reciprocal pairs overdue for rotation', explanation: `Active pairs untouched past ${THRESHOLDS.ROTATION_DAYS}d — the weekly rotation may not be running.`, href: '/dashboard/admin/operations' })
    if (rec.exposure.concentrationAlert) items.push({ id: 'rec-concentration', severity: 'medium', count: rec.exposure.max, title: 'Recommendation exposure concentrated', explanation: `One member is recommended to ${rec.exposure.max} others (median ${rec.exposure.median}) — distribution is unhealthy.`, href: '/dashboard/admin/batches' })
  }

  for (const m of input.pendingMigrations ?? []) {
    items.push({ id: `mig-${m.migration}`, severity: 'medium', count: 1, title: `Pending schema migration: ${m.migration}`, explanation: m.impact, href: '/dashboard/admin/operations' })
  }

  const op = input.operational ?? {}
  if ((op.waitlistPending ?? 0) > 0) items.push({ id: 'op-waitlist', severity: 'medium', count: op.waitlistPending as number, title: 'Waitlist awaiting approval', explanation: 'New applicants pending an approval decision.', href: '/dashboard/admin/waitlist' })
  if ((op.concierge ?? 0) > 0) items.push({ id: 'op-concierge', severity: 'medium', count: op.concierge as number, title: 'Concierge requests to triage', explanation: 'Member-requested introductions awaiting triage.', href: '/dashboard/admin/concierge' })
  if ((op.issues ?? 0) > 0) items.push({ id: 'op-issues', severity: 'high', count: op.issues as number, title: 'New issue reports', explanation: 'User-submitted bug reports / support questions, unreviewed.', href: '/dashboard/admin/issues' })
  if ((op.adminIntros ?? 0) > 0) items.push({ id: 'op-intros', severity: 'low', count: op.adminIntros as number, title: 'Admin intros awaiting response', explanation: 'Admin-initiated introductions the member has not answered.', href: '/dashboard/admin/members' })
  if (op.batchNeedsReview) items.push({ id: 'op-batch', severity: 'low', count: 1, title: 'Current batch needs review', explanation: 'A generated recommendation batch is awaiting admin approval.', href: '/dashboard/admin/batches' })

  return items.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])
}

/** Monitoring sources with no persisted telemetry — always surfaced as honest gaps. */
export function monitoringGaps(): MonitoringGap[] {
  return [
    { id: 'gap-cron', label: 'Cron run history', reason: 'No run-history table exists; success/failure is only in Vercel logs.', href: 'https://vercel.com/dashboard' },
    { id: 'gap-recgen', label: 'Recommendation-generation failures', reason: 'Generation errors are logged (console) but not persisted — check Vercel logs.', href: 'https://vercel.com/dashboard' },
    { id: 'gap-auth', label: 'Auth / service 5xx', reason: 'No internal error-log table; not queryable from the database.', href: 'https://vercel.com/dashboard' },
  ]
}

// ── Homepage triage (pure, PRESENTATION ONLY) ────────────────────────────────────────
//
// computeNeedsAttention above is unchanged and still produces the COMPLETE list — nothing
// here alters how any metric is calculated. This layer only decides which of those already
// computed items belong on the short admin homepage and which belong on Operations.
//
// The distinction the operator actually needs: "a person is stuck / waiting on me" versus
// "a machine is misbehaving". A webhook that recorded three error events is three events,
// not three affected members, so it must never sit on the homepage looking like a member
// incident. Same for pending schema migrations, rotation lag, and exposure concentration:
// real, worth fixing, but infrastructure — they live under Operations.

/** Non-member-facing attention items: infrastructure telemetry, routed to Operations. */
export const TECHNICAL_ATTENTION_IDS = ['webhook-errors', 'rec-stale', 'rec-concentration'] as const
/** Pending-migration items are id-prefixed (`mig-<name>`), so they are matched by prefix. */
export const TECHNICAL_ATTENTION_PREFIXES = ['mig-'] as const
/** Hard cap on homepage attention rows. Anything beyond this is reached via Operations. */
export const MAX_HOME_ATTENTION = 4

export function isTechnicalAttention(id: string): boolean {
  if (TECHNICAL_ATTENTION_PREFIXES.some((p) => id.startsWith(p))) return true
  return (TECHNICAL_ATTENTION_IDS as readonly string[]).includes(id)
}

/**
 * Homepage ordering for member-impacting items. Highest member impact first: someone was
 * never reached (failed / stuck delivery), then someone is waiting on a decision from the
 * operator, then someone is on the platform with nothing to act on.
 * An id absent from this list sorts after every listed one, then by severity.
 */
export const ATTENTION_PRIORITY: readonly string[] = [
  'inv-failed',    // invitation never arrived — the person cannot join at all
  'inv-stuck',     // invitation in flight past the stuck threshold — same outcome, not yet terminal
  'op-waitlist',   // applicants waiting on an approval decision
  'op-issues',     // members reported a problem and nobody has looked
  'rec-none',      // eligible members seeing an empty Introductions page
  'op-concierge',  // member-requested introductions awaiting triage
  'inv-na-7d',     // delivered a week ago, never signed in
  'inv-na-3d',
  'op-batch',      // a generated batch is blocking new introductions
  'op-intros',     // admin-initiated intros a member has not answered
]

const ATTENTION_SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

/** Plain-language destination label per admin page. Never a verb the homepage can execute. */
export function attentionActionLabel(href: string): string {
  switch (href) {
    case '/dashboard/admin/waitlist': return 'Review waitlist'
    case '/dashboard/admin/issues': return 'Review reports'
    case '/dashboard/admin/batches': return 'Review batches'
    case '/dashboard/admin/concierge': return 'Open concierge'
    case '/dashboard/admin/members': return 'View members'
    case '/dashboard/admin/operations': return 'Open operations'
    default: return 'Review'
  }
}

export interface AttentionTriage {
  /** Member-impacting items, in homepage priority order. */
  memberImpacting: AttentionItem[]
  /** Infrastructure items — shown on Operations, never as a top-level homepage alert. */
  technical: AttentionItem[]
  /** The at-most-MAX_HOME_ATTENTION rows the homepage renders. */
  top: AttentionItem[]
  /** Member-impacting items that did not fit on the homepage (0 when everything fits). */
  overflow: number
  /** True when there is anything at all to see on Operations beyond the homepage rows. */
  hasMore: boolean
}

/** Split the computed attention list into what Daniel must decide vs what a machine reports. */
export function triageAttention(items: AttentionItem[]): AttentionTriage {
  const all = items ?? []
  const rank = (i: AttentionItem) => {
    const p = ATTENTION_PRIORITY.indexOf(i.id)
    return p === -1 ? ATTENTION_PRIORITY.length + ATTENTION_SEV_RANK[i.severity] : p
  }
  const memberImpacting = all.filter((i) => !isTechnicalAttention(i.id)).sort((a, b) => rank(a) - rank(b))
  const technical = all.filter((i) => isTechnicalAttention(i.id))
  const top = memberImpacting.slice(0, MAX_HOME_ATTENTION)
  const overflow = memberImpacting.length - top.length
  return { memberImpacting, technical, top, overflow, hasMore: overflow > 0 || technical.length > 0 }
}
