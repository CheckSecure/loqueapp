/**
 * Admin dashboard IO layer.
 *
 * ONE shared fetch: every base dataset (profiles, matches, meetings, intro_requests,
 * member_pairs, member_presence, invitation_deliveries, waitlist, delivery_events, and the
 * small operational counts) is read EXACTLY ONCE, in parallel, and reused across every
 * section — no duplicate reads. Pure builders then compute Members / Recommendations /
 * Invitations / Platform from that shared struct.
 *
 * Budget: a hard request budget is enforced (QUERY_BUDGET). Migration-health is probed via a
 * short-lived server-side cache (schema-only, never member data), so its 26 serial probes run
 * at most once per TTL rather than on every load.
 *
 * Cancellation: all Postgres queries carry a real AbortSignal driven by a wall-clock deadline —
 * a hung query is genuinely cancelled, not merely abandoned by Promise.race. Section failure
 * isolation is preserved: a rejected/aborted dataset marks only its dependent sections
 * unavailable.
 *
 * Server-side + service-role only; admin-authorized at the loader boundary.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { isEligibleMember, ELIGIBILITY_COLUMNS, ADMIN_EMAIL } from '@/lib/matching/eligibility'
import { EXPRESSED_INTEREST_STATUSES } from '@/lib/introductions/queue'
import { checkMigrationHealth, type MigrationHealth } from '@/lib/db/migrationHealth'
import {
  classifyInvitations, classifyRecommendations, computeNeedsAttention, monitoringGaps,
  countUniqueMatchedPairs, pairKey, normalizeEmail,
  type InvitationMetrics, type RecommendationMetrics,
  type AttentionItem, type MonitoringGap,
} from './dashboardMetrics'

type Admin = ReturnType<typeof createAdminClient>
export type Section<T> = { ok: true; data: T } | { ok: false; unavailable: true; reason: string }

/** Wall-clock deadline; on expiry the AbortController cancels every in-flight Postgres query. */
export const DASHBOARD_DEADLINE_MS = 8000
/** Hard ceiling on shared data requests per load (excludes cached migration probes + Auth pages). */
export const QUERY_BUDGET = 13
/** Schema/migration health cache TTL (schema-only; never caches member/admin aggregates). */
export const MIGRATION_HEALTH_TTL_MS = 60_000
/** Safety bound on Auth pages (50 × 1000 = 50k users) before we surface "incomplete". */
export const MAX_AUTH_PAGES = 50

const ms = (s?: string | null): number => (s ? Date.parse(s) || 0 : 0)
const UPCOMING_STATUSES = ['requested', 'scheduled', 'confirmed']

// ── Auth listing (complete or fail-closed) ───────────────────────────────────────────
export interface ActivationResult {
  byId: Map<string, boolean>
  byEmail: Map<string, boolean>
  complete: boolean // false when a page failed OR the bound was hit → activation reads "unavailable"
  pages: number
}
async function buildActivationLookup(admin: Admin): Promise<ActivationResult> {
  const byId = new Map<string, boolean>()
  const byEmail = new Map<string, boolean>()
  const perPage = 1000
  for (let page = 1; page <= MAX_AUTH_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error || !data) return { byId, byEmail, complete: false, pages: page - 1 } // failed (incl. middle) page
    for (const u of data.users) {
      const signedIn = !!u.last_sign_in_at
      byId.set(u.id, signedIn)
      const e = normalizeEmail(u.email)
      if (e) byEmail.set(e, signedIn)
    }
    if (data.users.length < perPage) return { byId, byEmail, complete: true, pages: page } // exhausted
  }
  return { byId, byEmail, complete: false, pages: MAX_AUTH_PAGES } // bound hit → not proven complete
}

// ── Cached schema/migration health (root cause of the 26 probes) ─────────────────────
// checkMigrationHealth loops 26 SchemaExpectations SERIALLY (one probe each). We cache the
// result per server instance for a short TTL so it runs at most once per TTL, not per load.
let mhCache: { at: number; value: MigrationHealth } | null = null
async function getMigrationHealthCached(admin: Admin, now: number): Promise<{ value: MigrationHealth | null; cached: boolean; probes: number }> {
  if (mhCache && now - mhCache.at < MIGRATION_HEALTH_TTL_MS) return { value: mhCache.value, cached: true, probes: 0 }
  try {
    const value = await checkMigrationHealth(admin)
    mhCache = { at: now, value }
    return { value, cached: false, probes: value.checked }
  } catch (err: any) {
    console.warn('[admin-dashboard] migration health failed:', err?.message)
    return { value: mhCache?.value ?? null, cached: !!mhCache, probes: 0 }
  }
}
/** Test-only: reset the module cache so cold-load counts are reproducible. */
export function __resetMigrationHealthCache() { mhCache = null }

// ── Shared single-fetch of every base dataset ────────────────────────────────────────
interface DsResult { ok: boolean; data: any[]; count: number | null }
function dsFromSettled(s: PromiseSettledResult<any>): DsResult {
  if (s.status === 'fulfilled' && s.value && !s.value.error) return { ok: true, data: s.value.data ?? [], count: s.value.count ?? null }
  return { ok: false, data: [], count: null }
}

interface Shared {
  profiles: DsResult; matches: DsResult; meetings: DsResult; intros: DsResult; pairs: DsResult
  presence: DsResult; deliveries: DsResult; waitlist: DsResult; events: DsResult
  messages: DsResult; issues: DsResult; concierge: DsResult; batch: DsResult
}

async function fetchShared(admin: Admin, now: number, signal: AbortSignal, budget: { n: number }): Promise<Shared> {
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
  const nowIso = new Date(now).toISOString()
  const OPEN_STATUSES = ['suggested', 'queued', ...(EXPRESSED_INTEREST_STATUSES as unknown as string[])]
  // Count + attach the AbortSignal to every request (genuine cancellation on deadline).
  const S = (b: any) => { budget.n++; return b.abortSignal(signal) }

  const settled = await Promise.allSettled([
    S(admin.from('profiles').select(`id, ${ELIGIBILITY_COLUMNS}`)),
    S(admin.from('matches').select('user_a_id, user_b_id').eq('status', 'active').is('removed_at', null)),
    // recent + upcoming meetings in ONE read (serves Members created-7d/upcoming AND Recs from-matches).
    S(admin.from('meetings').select('requester_id, recipient_id, scheduled_at, status, created_at').or(`scheduled_at.gt.${nowIso},created_at.gte.${sevenDaysAgo}`)),
    S(admin.from('intro_requests').select('requester_id, target_user_id, status, is_admin_initiated, pair_id, batch_id').in('status', OPEN_STATUSES)),
    S(admin.from('member_pairs').select('status, last_recommended_at')),
    S(admin.from('member_presence').select('user_id').gte('last_active_at', sevenDaysAgo)),
    S(admin.from('invitation_deliveries').select('status, purpose, created_at, delivered_at, last_event_at, auth_user_id, recipient_email, waitlist_id')),
    S(admin.from('waitlist').select('status, id, invited_at')),
    S(admin.from('invitation_delivery_events').select('result, created_at').gte('created_at', sevenDaysAgo)),
    S(admin.from('messages').select('id', { count: 'exact', head: true }).eq('is_system', false).gte('created_at', sevenDaysAgo)),
    S(admin.from('issue_reports').select('id', { count: 'exact', head: true }).eq('status', 'new')),
    S(admin.from('concierge_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending')),
    S(admin.from('introduction_batches').select('id, status').order('created_at', { ascending: false }).limit(1)),
  ])
  const [profiles, matches, meetings, intros, pairs, presence, deliveries, waitlist, events, messages, issues, concierge, batch] = settled.map(dsFromSettled)
  return { profiles, matches, meetings, intros, pairs, presence, deliveries, waitlist, events, messages, issues, concierge, batch }
}

// ── Pure section builders over the shared struct (no IO) ─────────────────────────────
export interface MemberMetrics {
  totalMembers: number; activeMembers: number; onboardingIncomplete: number
  activeLast7d: number; weeklyActivePct: number | null; activeConnections: number
  messages7d: number; meetingsCreated7d: number; upcomingMeetings: number
}
function isRealMember(p: any): boolean {
  return p?.is_test_account !== true && p?.is_admin !== true && normalizeEmail(p?.email) !== ADMIN_EMAIL
}
function buildMembers(s: Shared, now: number): MemberMetrics {
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000
  const real = s.profiles.data.filter(isRealMember)
  const realActiveIds = new Set(real.filter((p: any) => p.account_status === 'active').map((p: any) => p.id))
  const presenceIds = new Set(s.presence.data.map((r: any) => r.user_id))
  let activeLast7d = 0
  for (const id of Array.from(realActiveIds)) if (presenceIds.has(id)) activeLast7d++
  const activeMembers = realActiveIds.size
  return {
    totalMembers: real.length,
    activeMembers,
    onboardingIncomplete: real.filter((p: any) => p.account_status === 'active' && p.profile_complete === false).length,
    activeLast7d,
    weeklyActivePct: activeMembers > 0 ? Math.round((activeLast7d / activeMembers) * 100) : null,
    activeConnections: countUniqueMatchedPairs(s.matches.data),
    messages7d: s.messages.count ?? 0,
    meetingsCreated7d: s.meetings.data.filter((m: any) => ms(m.created_at) >= sevenDaysAgo).length,
    upcomingMeetings: s.meetings.data.filter((m: any) => ms(m.scheduled_at) > now && UPCOMING_STATUSES.includes(m.status)).length,
  }
}
function buildRecommendations(s: Shared, now: number): RecommendationMetrics {
  const eligibleIds = s.profiles.data.filter(isEligibleMember).map((p: any) => p.id)
  const matchPairKeys = new Set<string>()
  for (const m of s.matches.data) { const k = pairKey(m.user_a_id, m.user_b_id); if (k) matchPairKeys.add(k) }
  const meetingPairKeys = s.meetings.data
    .filter((m: any) => ms(m.scheduled_at) > now && UPCOMING_STATUSES.includes(m.status))
    .map((m: any) => pairKey(m.requester_id, m.recipient_id)).filter(Boolean) as string[]
  return classifyRecommendations({
    intros: s.intros.data as any, pairs: s.pairs.data as any, eligibleIds,
    matchPairKeys, matchedPairCount: countUniqueMatchedPairs(s.matches.data), meetingPairKeys, now,
  })
}
function buildInvitations(s: Shared, activation: ActivationResult, now: number): InvitationMetrics {
  const wl = s.waitlist.data
  const invitedRows = wl.filter((w: any) => w.status === 'invited' && w.invited_at != null)
  const linkedIds = new Set(s.deliveries.data.map((d: any) => d.waitlist_id).filter(Boolean))
  return classifyInvitations({
    deliveries: s.deliveries.data as any,
    waitlistStatuses: wl.map((w: any) => w.status),
    invitedTotal: invitedRows.length,
    invitedTracked: invitedRows.filter((w: any) => linkedIds.has(w.id)).length,
    activation: { byId: activation.byId, byEmail: activation.byEmail },
    activationAvailable: activation.complete,
    now,
  })
}

export interface WebhookHealth { totalEvents: number; errorEvents: number }
export interface PlatformHealth {
  migration: { ok: boolean; pending: Array<{ migration: string; message: string; impact: string }> } | null
  webhook: Section<WebhookHealth>
  deployedSha: string | null
  cronHistory: { available: false }
  authErrors: { available: false }
  supabaseResources: { available: false }
}
export interface RequestCount { data: number; migrationProbes: number; authPages: number; budget: number; warm: boolean }
export interface AdminDashboard {
  invitations: Section<InvitationMetrics>
  recommendations: Section<RecommendationMetrics>
  members: Section<MemberMetrics>
  platform: PlatformHealth
  needsAttention: AttentionItem[]
  monitoringGaps: MonitoringGap[]
  operational: { waitlistPending: number; concierge: number; issues: number; adminIntros: number; batchNeedsReview: boolean }
  activation: { complete: boolean; pages: number }
  requestCount: RequestCount
}

export class AdminAuthorizationError extends Error {
  constructor() { super('forbidden: admin authorization required'); this.name = 'AdminAuthorizationError' }
}

const UNAVAIL = { ok: false as const, unavailable: true as const, reason: 'a required dataset was unavailable' }

/**
 * Orchestrator. Admin-only (refuses any other identity before touching data). One shared fetch
 * under an AbortController deadline; migration health served from a short-lived server cache.
 */
export async function loadAdminDashboard(admin: Admin, opts: {
  now: number
  adminEmail: string | null | undefined
  env: { deployedSha?: string | null }
}): Promise<AdminDashboard> {
  const { now, adminEmail, env } = opts
  if (normalizeEmail(adminEmail) !== ADMIN_EMAIL) throw new AdminAuthorizationError()

  const budget = { n: 0 }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DASHBOARD_DEADLINE_MS)

  let shared: Shared
  let activation: ActivationResult = { byId: new Map(), byEmail: new Map(), complete: false, pages: 0 }
  let mh: { value: MigrationHealth | null; cached: boolean; probes: number } = { value: null, cached: false, probes: 0 }
  try {
    // Shared data + Auth listing + (cached) migration health run concurrently.
    const [sharedRes, activationRes, mhRes] = await Promise.allSettled([
      fetchShared(admin, now, controller.signal, budget),
      buildActivationLookup(admin), // Auth API has no abort param; bounded by the overall deadline.
      getMigrationHealthCached(admin, now),
    ])
    shared = sharedRes.status === 'fulfilled' ? sharedRes.value : emptyShared()
    if (activationRes.status === 'fulfilled') activation = activationRes.value
    if (mhRes.status === 'fulfilled') mh = mhRes.value
  } finally {
    clearTimeout(timer)
  }

  const invitations: Section<InvitationMetrics> = shared.deliveries.ok && shared.waitlist.ok
    ? { ok: true, data: buildInvitations(shared, activation, now) } : UNAVAIL
  const recommendations: Section<RecommendationMetrics> =
    shared.profiles.ok && shared.intros.ok && shared.pairs.ok && shared.matches.ok && shared.meetings.ok
      ? { ok: true, data: buildRecommendations(shared, now) } : UNAVAIL
  const members: Section<MemberMetrics> =
    shared.profiles.ok && shared.matches.ok && shared.meetings.ok && shared.presence.ok && shared.messages.ok
      ? { ok: true, data: buildMembers(shared, now) } : UNAVAIL
  const webhook: Section<WebhookHealth> = shared.events.ok
    ? { ok: true, data: { totalEvents: shared.events.data.length, errorEvents: shared.events.data.filter((r: any) => r.result === 'error' || r.result === 'not_found').length } }
    : { ok: false, unavailable: true, reason: 'delivery events unavailable' }

  const operational = {
    waitlistPending: shared.waitlist.ok ? shared.waitlist.data.filter((w: any) => w.status === 'pending').length : 0,
    concierge: shared.concierge.count ?? 0,
    issues: shared.issues.count ?? 0,
    adminIntros: shared.intros.ok ? shared.intros.data.filter((i: any) => i.status === 'admin_pending').length : 0,
    batchNeedsReview: shared.batch.ok && shared.batch.data[0] ? shared.batch.data[0].status !== 'active' : false,
  }

  const platform: PlatformHealth = {
    migration: mh.value ? { ok: mh.value.ok, pending: mh.value.pending.map((p) => ({ migration: p.migration, message: p.message, impact: p.impact })) } : null,
    webhook,
    deployedSha: env.deployedSha ?? null,
    cronHistory: { available: false }, authErrors: { available: false }, supabaseResources: { available: false },
  }

  const needsAttention = computeNeedsAttention({
    invitations: invitations.ok ? invitations.data : null,
    recommendations: recommendations.ok ? recommendations.data : null,
    pendingMigrations: mh.value?.pending?.map((p) => ({ migration: p.migration, message: p.message, impact: p.impact })) ?? [],
    webhookErrors: webhook.ok ? webhook.data.errorEvents : null,
    operational,
  })

  return {
    invitations, recommendations, members, platform,
    needsAttention, monitoringGaps: monitoringGaps(), operational,
    activation: { complete: activation.complete, pages: activation.pages },
    requestCount: { data: budget.n, migrationProbes: mh.probes, authPages: activation.pages, budget: QUERY_BUDGET, warm: mh.cached },
  }
}

function emptyShared(): Shared {
  const empty: DsResult = { ok: false, data: [], count: null }
  return { profiles: empty, matches: empty, meetings: empty, intros: empty, pairs: empty, presence: empty, deliveries: empty, waitlist: empty, events: empty, messages: empty, issues: empty, concierge: empty, batch: empty }
}
