/**
 * lib/opportunities/matching.ts
 *
 * Candidate selection for the three opportunity paths.
 *
 * Prompt #15 changes:
 * - Normalized scoring in ~0-95 range
 * - Threshold filter: 40 hiring / 50 business / 55 recruiter
 * - Near-threshold fallback: deliver 1 if top candidate scores within 5 of threshold
 * - Min tag rules: 1 (hiring) / 2 (business) / 2 (recruiter)
 * - Bootstrap behavior: users with < 3 past deliveries get median (0.5) stubs
 *   for opp_response_rate and opp_conversation_continuation_rate
 */

import { createAdminClient } from '@/lib/supabase/admin';
import {
  DELIVERY_CEILING,
  TRANCHE_CEILING,
  REMOVED_MATCH_COOLDOWN_DAYS,
  RECRUITER_WEEKLY_CAP,
  SCORING_TIER_BOOST,
  type Tier,
} from './caps';
import { shouldNotify } from './notifications';
import { rateLimitedUserIds } from './rateLimits';
import { logMatcherRun, logEvent } from './events';
import { acceptedRoleTypesForNeed } from './relevance';
import { getReferralExclusionsForUser } from '@/lib/referrals/exclusions';

// ------------------------------------------------------------
// Threshold configuration — Prompt #15
// ------------------------------------------------------------

export const THRESHOLDS = {
  hiring: 40,
  business: 50,
  recruiter: 55,
} as const;

export const NEAR_THRESHOLD_WINDOW = 5;

export const MIN_TAGS = {
  hiring: 1,
  business: 2,
  recruiter: 2,
} as const;

export const BOOTSTRAP_DELIVERED_CUTOFF = 3;
export const BOOTSTRAP_MEDIAN_RATE = 0.5;

export type DeliveryMode =
  | 'above_threshold'
  | 'near_threshold_fallback'
  | 'below_quality_threshold'
  | 'no_qualified_pool';

type OpportunityRow = {
  id: string;
  creator_id: string;
  type: 'hiring' | 'business';
  include_recruiters: boolean;
  criteria: {
    role_title?: string;
    seniority?: string;
    industry?: string;
    expertise?: string[];
    role_types?: string[];
    need?: string;
  };
};

type CandidateProfile = {
  id: string;
  seniority: string | null;
  role_type: string | null;
  expertise: string[] | string | null;
  trust_score: number | null;
  responsivenessScore: number | null;
  networkValueScore: number | null;
  opp_delivered_count: number | null;
  opp_response_rate: number | null;
  opp_conversation_continuation_rate: number | null;
  subscription_tier?: string | null;
};

type ScoredCandidate = { userId: string; score: number };

type SelectResult = {
  delivered: ScoredCandidate[];
  mode: DeliveryMode;
  topScore: number | null;
  qualifiedCount: number;
  threshold: number;
};

// ------------------------------------------------------------
// Exclusions
// ------------------------------------------------------------

function isoWeekStart(d = new Date()): string {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  if (day !== 1) copy.setUTCDate(copy.getUTCDate() - (day - 1));
  return copy.toISOString().slice(0, 10);
}

async function excludedUserIdsFor(creatorId: string): Promise<Set<string>> {
  const admin = createAdminClient();
  const excluded = new Set<string>([creatorId]);

  const { data: blocks } = await admin
    .from('blocked_users')
    .select('user_id, blocked_user_id')
    .or(`user_id.eq.${creatorId},blocked_user_id.eq.${creatorId}`);
  blocks?.forEach((b) => {
    excluded.add(b.user_id === creatorId ? b.blocked_user_id : b.user_id);
  });

  const { data: activeMatches } = await admin
    .from('matches')
    .select('user_a_id, user_b_id, status, removed_at')
    .or(`user_a_id.eq.${creatorId},user_b_id.eq.${creatorId}`)
    .in('status', ['active', 'accepted'])
    .is('removed_at', null);
  activeMatches?.forEach((m) => {
    excluded.add(m.user_a_id === creatorId ? m.user_b_id : m.user_a_id);
  });

  const cooldownCutoff = new Date(
    Date.now() - REMOVED_MATCH_COOLDOWN_DAYS * 86400_000
  ).toISOString();
  const { data: recentRemoved } = await admin
    .from('matches')
    .select('user_a_id, user_b_id, removed_at')
    .or(`user_a_id.eq.${creatorId},user_b_id.eq.${creatorId}`)
    .eq('status', 'removed')
    .gte('removed_at', cooldownCutoff);
  recentRemoved?.forEach((m) => {
    excluded.add(m.user_a_id === creatorId ? m.user_b_id : m.user_a_id);
  });

  const { data: openIntros } = await admin
    .from('intro_requests')
    .select('requester_id, target_user_id, status')
    .or(`requester_id.eq.${creatorId},target_user_id.eq.${creatorId}`)
    .in('status', ['admin_pending', 'pending', 'approved']);
  openIntros?.forEach((r) => {
    excluded.add(r.requester_id === creatorId ? r.target_user_id : r.requester_id);
  });

  // Referral pairs — bidirectional exclusion (helper fetches email internally)
  const referralExcluded = await getReferralExclusionsForUser(creatorId)
  referralExcluded.forEach(id => excluded.add(id))

  return excluded;
}



async function alreadyDeliveredFor(opportunityId: string): Promise<Set<string>> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('opportunity_candidates')
    .select('user_id')
    .eq('opportunity_id', opportunityId);
  return new Set((data ?? []).map((r) => r.user_id));
}

// ------------------------------------------------------------
// Expertise + scoring helpers
// ------------------------------------------------------------

/**
 * profiles.expertise is stored as TEXT containing a Postgres array literal
 * like {privacy,"data protection",regulatory}, or sometimes JSON like ["privacy"],
 * or null/empty. Normalize to a plain string[] before use.
 */
function parseExpertise(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((s) => String(s));
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '{}' || trimmed === '[]') return [];
  if (trimmed.startsWith('[')) {
    try {
      const j = JSON.parse(trimmed);
      return Array.isArray(j) ? j.map((s) => String(s)) : [];
    } catch {
      return [];
    }
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1);
    if (inner === '') return [];
    const out: string[] = [];
    let buf = '';
    let inQuotes = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '"' && inner[i - 1] !== '\\') {
        inQuotes = !inQuotes;
        continue;
      }
      if (ch === ',' && !inQuotes) {
        out.push(buf.trim());
        buf = '';
        continue;
      }
      buf += ch;
    }
    if (buf.length > 0) out.push(buf.trim());
    return out.filter((s) => s.length > 0);
  }
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

function expertiseOverlapCount(a: unknown, b: string[] | undefined): number {
  const parsed = parseExpertise(a);
  if (parsed.length === 0 || !b || b.length === 0) return 0;
  const set = new Set(b.map((s) => s.toLowerCase()));
  return parsed.filter((t) => set.has(t.toLowerCase())).length;
}

/**
 * Seniority alignment: 15 points max for exact match, 7 for one step off,
 * 0 for two+ steps or missing data.
 */
function seniorityAlignment(candidate: string | null, target: string | undefined): number {
  if (!candidate || !target) return 0;
  const order = ['Junior', 'Mid-Level', 'Senior', 'Executive', 'C-Suite'];
  const ci = order.indexOf(candidate);
  const ti = order.indexOf(target);
  if (ci < 0 || ti < 0) return 0;
  const diff = Math.abs(ci - ti);
  if (diff === 0) return 15;
  if (diff === 1) return 7;
  return 0;
}

/**
 * Bootstrap a behavioral rate when the user has insufficient history.
 * Returns the provided value clamped to [0,1], or the bootstrap median if
 * the user has fewer than BOOTSTRAP_DELIVERED_CUTOFF prior deliveries.
 */
function bootstrapRate(value: number | null, deliveredCount: number | null): number {
  const count = Number(deliveredCount ?? 0);
  if (count < BOOTSTRAP_DELIVERED_CUTOFF || value === null) {
    return BOOTSTRAP_MEDIAN_RATE;
  }
  const v = Number(value);
  if (Number.isNaN(v)) return BOOTSTRAP_MEDIAN_RATE;
  return Math.max(0, Math.min(1, v));
}

/**
 * Clamp a 0-100 score signal (trust, responsiveness, network) to a weighted range.
 * Contribution is (value / 100) * maxPoints.
 */
function scaled(value: number | null, maxPoints: number): number {
  const v = Number(value ?? 0);
  if (Number.isNaN(v)) return 0;
  const clamped = Math.max(0, Math.min(100, v));
  return (clamped / 100) * maxPoints;
}

// ------------------------------------------------------------
// Normalized scoring — Prompt #15 design weights
// ------------------------------------------------------------

function tierBoost(c: CandidateProfile): number {
  const tier = ((c.subscription_tier as Tier) || 'free');
  return SCORING_TIER_BOOST[tier] ?? 0;
}

function scoreHiring(c: CandidateProfile, o: OpportunityRow): number {
  // Expertise overlap: 12 per tag, capped at 3 tags (max 36)
  const overlap = Math.min(3, expertiseOverlapCount(c.expertise, o.criteria.expertise));
  const expertisePts = overlap * 12;

  // Seniority alignment: 0-15
  const seniorityPts = seniorityAlignment(c.seniority, o.criteria.seniority);

  // Role-type match boost: Prompt #15 / Option C — role_type is a scoring
  // signal for hiring (not a hard filter). Candidates whose role_type is in
  // the creator's requested list get +15; others get 0.
  const requested = o.criteria.role_types ?? [];
  const roleTypePts =
    requested.length === 0 || requested.includes(c.role_type ?? '') ? 15 : 0;

  // Behavioral signals (bootstrap for new users)
  const responseRate = bootstrapRate(c.opp_response_rate, c.opp_delivered_count);
  const continuationRate = bootstrapRate(
    c.opp_conversation_continuation_rate,
    c.opp_delivered_count
  );
  const responsePts = responseRate * 10;
  const continuationPts = continuationRate * 8;

  // Scaled signals (0-100 → bounded contribution)
  const responsivenessPts = scaled(c.responsivenessScore, 10);
  const trustPts = scaled(c.trust_score, 10);
  const networkPts = scaled(c.networkValueScore, 6);

  return (
    expertisePts +
    seniorityPts +
    roleTypePts +
    responsePts +
    continuationPts +
    responsivenessPts +
    trustPts +
    networkPts
  ) + tierBoost(c);
}

function scoreBusiness(c: CandidateProfile, o: OpportunityRow): number {
  const overlap = Math.min(3, expertiseOverlapCount(c.expertise, o.criteria.expertise));
  const expertisePts = overlap * 12;

  // Business doesn't use seniority alignment — providers match on expertise
  const responseRate = bootstrapRate(c.opp_response_rate, c.opp_delivered_count);
  const continuationRate = bootstrapRate(
    c.opp_conversation_continuation_rate,
    c.opp_delivered_count
  );
  const responsePts = responseRate * 10;
  const continuationPts = continuationRate * 8;

  const responsivenessPts = scaled(c.responsivenessScore, 10);
  const trustPts = scaled(c.trust_score, 10);
  const networkPts = scaled(c.networkValueScore, 6);

  return expertisePts + responsePts + continuationPts + responsivenessPts + trustPts + networkPts + tierBoost(c);
}

function scoreRecruiter(c: CandidateProfile): number {
  const responseRate = bootstrapRate(c.opp_response_rate, c.opp_delivered_count);
  const continuationRate = bootstrapRate(
    c.opp_conversation_continuation_rate,
    c.opp_delivered_count
  );
  const responsePts = responseRate * 10;
  const continuationPts = continuationRate * 8;

  const responsivenessPts = scaled(c.responsivenessScore, 10);
  const trustPts = scaled(c.trust_score, 10);
  const networkPts = scaled(c.networkValueScore, 6);

  return responsePts + continuationPts + responsivenessPts + trustPts + networkPts + tierBoost(c);
}

// ------------------------------------------------------------
// Threshold + fallback application
// ------------------------------------------------------------

/**
 * Apply the threshold filter + near-threshold fallback per Prompt #15.
 *
 * Preconditions: scored is already filtered to min-tag-qualified candidates
 * and sorted descending by score.
 *
 * Returns: selection + delivery mode metadata.
 */
function applyThresholdAndFallback(
  scored: ScoredCandidate[],
  threshold: number,
  deliveryCeiling: number
): {
  delivered: ScoredCandidate[];
  mode: DeliveryMode;
  topScore: number | null;
} {
  if (scored.length === 0) {
    return { delivered: [], mode: 'no_qualified_pool', topScore: null };
  }

  const topScore = scored[0].score;
  const above = scored.filter((s) => s.score >= threshold);

  if (above.length > 0) {
    return {
      delivered: above.slice(0, deliveryCeiling),
      mode: 'above_threshold',
      topScore,
    };
  }

  // Zero above threshold — is top candidate within near-threshold window?
  if (topScore >= threshold - NEAR_THRESHOLD_WINDOW) {
    return {
      delivered: [scored[0]],
      mode: 'near_threshold_fallback',
      topScore,
    };
  }

  return { delivered: [], mode: 'below_quality_threshold', topScore };
}

// ------------------------------------------------------------
// Selection (hiring / business / recruiter)
// ------------------------------------------------------------

const PROFILE_SELECT =
  'id, seniority, role_type, expertise, trust_score, ' +
  '"networkValueScore", "responsivenessScore", ' +
  'opp_delivered_count, opp_response_rate, opp_conversation_continuation_rate, subscription_tier';

export async function selectCandidates(opportunity: OpportunityRow): Promise<SelectResult> {
  const admin = createAdminClient();

  const [excluded, alreadyDelivered, rateLimited] = await Promise.all([
    excludedUserIdsFor(opportunity.creator_id),
    alreadyDeliveredFor(opportunity.id),
    rateLimitedUserIds(opportunity.creator_id),
  ]);

  const { data: pool } = await admin
    .from('profiles')
    .select(PROFILE_SELECT)
    .eq('open_to_roles', true)
    .eq('account_status', 'active')
    .eq('profile_complete', true);

  const requestedRoleTypes = opportunity.criteria.role_types ?? [];

  const filtered = (pool ?? [])
    .filter((p) => !excluded.has(p.id))
    .filter((p) => !alreadyDelivered.has(p.id))
    .filter((p) => !rateLimited.has(p.id))
    // Option C: role_type is a scoring boost for hiring, not a hard filter.
    // (See scoreHiring roleTypePts.) Business KEEPS the hard filter.
    // Min-tag rule for hiring: >=1 overlap
    .filter(
      (p) =>
        expertiseOverlapCount(p.expertise, opportunity.criteria.expertise) >=
        MIN_TAGS.hiring
    );

  const scored: ScoredCandidate[] = filtered.map((p) => ({
    userId: p.id,
    score: scoreHiring(p as CandidateProfile, opportunity),
  }));

  scored.sort((a, b) => b.score - a.score);

  const result = applyThresholdAndFallback(
    scored,
    THRESHOLDS.hiring,
    TRANCHE_CEILING.hiring
  );

  return {
    delivered: result.delivered,
    mode: result.mode,
    topScore: result.topScore,
    qualifiedCount: scored.length,
    threshold: THRESHOLDS.hiring,
  };
}

export async function selectProviders(opportunity: OpportunityRow): Promise<SelectResult> {
  const admin = createAdminClient();

  const [excluded, alreadyDelivered, rateLimited] = await Promise.all([
    excludedUserIdsFor(opportunity.creator_id),
    alreadyDeliveredFor(opportunity.id),
    rateLimitedUserIds(opportunity.creator_id),
  ]);

  const acceptedRoles = acceptedRoleTypesForNeed(opportunity.criteria.need);

  const { data: pool } = await admin
    .from('profiles')
    .select(PROFILE_SELECT)
    .eq('open_to_business_solutions', true)
    .eq('account_status', 'active')
    .eq('profile_complete', true);

  const filtered = (pool ?? [])
    .filter((p) => !excluded.has(p.id))
    .filter((p) => !alreadyDelivered.has(p.id))
    .filter((p) => !rateLimited.has(p.id))
    .filter((p) => acceptedRoles.includes(p.role_type ?? ''))
    // Min-tag rule for business: >=2 overlap (strict)
    .filter(
      (p) =>
        expertiseOverlapCount(p.expertise, opportunity.criteria.expertise) >=
        MIN_TAGS.business
    );

  const scored: ScoredCandidate[] = filtered.map((p) => ({
    userId: p.id,
    score: scoreBusiness(p as CandidateProfile, opportunity),
  }));

  scored.sort((a, b) => b.score - a.score);

  const result = applyThresholdAndFallback(
    scored,
    THRESHOLDS.business,
    TRANCHE_CEILING.business
  );

  return {
    delivered: result.delivered,
    mode: result.mode,
    topScore: result.topScore,
    qualifiedCount: scored.length,
    threshold: THRESHOLDS.business,
  };
}

export async function selectRecruiters(opportunity: OpportunityRow): Promise<SelectResult> {
  const admin = createAdminClient();

  if (!opportunity.include_recruiters || opportunity.type !== 'hiring') {
    return {
      delivered: [],
      mode: 'no_qualified_pool',
      topScore: null,
      qualifiedCount: 0,
      threshold: THRESHOLDS.recruiter,
    };
  }

  const { data: networkMatches } = await admin
    .from('matches')
    .select('user_a_id, user_b_id')
    .or(`user_a_id.eq.${opportunity.creator_id},user_b_id.eq.${opportunity.creator_id}`)
    .eq('status', 'active')
    .is('removed_at', null);

  const networkIds = new Set<string>();
  networkMatches?.forEach((m) => {
    const other = m.user_a_id === opportunity.creator_id ? m.user_b_id : m.user_a_id;
    networkIds.add(other);
  });

  if (networkIds.size === 0) {
    return {
      delivered: [],
      mode: 'no_qualified_pool',
      topScore: null,
      qualifiedCount: 0,
      threshold: THRESHOLDS.recruiter,
    };
  }

  const [excluded, alreadyDelivered, rateLimited] = await Promise.all([
    excludedUserIdsFor(opportunity.creator_id),
    alreadyDeliveredFor(opportunity.id),
    rateLimitedUserIds(opportunity.creator_id),
  ]);

  const week = isoWeekStart();
  const { data: weekly } = await admin
    .from('recruiter_activity')
    .select('user_id, responses_sent')
    .eq('week_starting', week)
    .gte('responses_sent', RECRUITER_WEEKLY_CAP);
  const overCap = new Set((weekly ?? []).map((r) => r.user_id));

  const { data: pool } = await admin
    .from('profiles')
    .select('id, seniority, role_type, expertise, trust_score, subscription_tier' +
        '"networkValueScore", "responsivenessScore", ' +
        'opp_delivered_count, opp_response_rate, opp_conversation_continuation_rate'
    )
    .eq('recruiter', true)
    .eq('account_status', 'active')
    .eq('profile_complete', true)
    .in('id', Array.from(networkIds));

  const filtered = (pool ?? [])
    .filter((p) => !excluded.has(p.id))
    .filter((p) => !alreadyDelivered.has(p.id))
    .filter((p) => !rateLimited.has(p.id))
    .filter((p) => !overCap.has(p.id))
    // Min-tag rule for recruiter: >=2 overlap
    .filter(
      (p) =>
        expertiseOverlapCount(p.expertise, opportunity.criteria.expertise) >=
        MIN_TAGS.recruiter
    );

  const scored: ScoredCandidate[] = filtered.map((p) => ({
    userId: p.id,
    score: scoreRecruiter(p as CandidateProfile),
  }));

  scored.sort((a, b) => b.score - a.score);

  const result = applyThresholdAndFallback(
    scored,
    THRESHOLDS.recruiter,
    TRANCHE_CEILING.recruiter
  );

  return {
    delivered: result.delivered,
    mode: result.mode,
    topScore: result.topScore,
    qualifiedCount: scored.length,
    threshold: THRESHOLDS.recruiter,
  };
}

// ------------------------------------------------------------
// Delivery
// ------------------------------------------------------------

export type DeliveryResult = {
  candidatesNotified: number;
  recruitersNotified: number;
  candidateMode: DeliveryMode;
  recruiterMode: DeliveryMode;
  candidateTopScore: number | null;
  recruiterTopScore: number | null;
  candidateThreshold: number;
  recruiterThreshold: number;
  candidateQualified: number;
  recruiterQualified: number;
};

export async function deliverOpportunity(
  opportunity: OpportunityRow,
  options: { tranche?: 1 | 2 } = {}
): Promise<DeliveryResult> {
  const tranche = options.tranche ?? 1;
  const admin = createAdminClient();

  const candidateResult =
    opportunity.type === 'hiring'
      ? await selectCandidates(opportunity)
      : await selectProviders(opportunity);

  const recruiterResult = await selectRecruiters(opportunity);

  const candidateRole = opportunity.type === 'hiring' ? 'candidate' : 'provider';

  const rows = [
    ...candidateResult.delivered.map((c) => ({
      opportunity_id: opportunity.id,
      user_id: c.userId,
      role: candidateRole,
      relevance_score: Math.round(c.score),
      tranche,
    })),
    ...recruiterResult.delivered.map((c) => ({
      opportunity_id: opportunity.id,
      user_id: c.userId,
      role: 'recruiter',
      relevance_score: Math.round(c.score),
      tranche,
    })),
  ];

  if (rows.length > 0) {
    const { error } = await admin.from('opportunity_candidates').insert(rows);
    if (error) throw new Error(`opportunity_candidates insert failed: ${error.message}`);
  }

  const { createNotificationSafe } = await import('@/lib/notifications');

  // Per-type notification cooldowns: users receive candidate rows (delivery)
  // regardless, but notifications are gated by shouldNotify() per type.
  // This is the delivery/notification split introduced in Prompt #15.
  const candidateType = opportunity.type === 'hiring' ? 'opportunity_received' : 'opportunity_received';
  await Promise.all(
    candidateResult.delivered.map(async (c) => {
      if (await shouldNotify(c.userId, candidateType)) {
        await createNotificationSafe({
          userId: c.userId,
          type: candidateType,
          data: { opportunity_id: opportunity.id, role: candidateRole },
        });
      }
    })
  );
  await Promise.all(
    recruiterResult.delivered.map(async (c) => {
      if (await shouldNotify(c.userId, 'recruiter_request')) {
        await createNotificationSafe({
          userId: c.userId,
          type: 'recruiter_request',
          data: { opportunity_id: opportunity.id, role: 'recruiter' },
        });
      }
    })
  );

  // Track matcher run on the opportunity itself.
  await admin
    .from('opportunities')
    .update({ last_matcher_run_at: new Date().toISOString() })
    .eq('id', opportunity.id);

  // Observability: log matcher runs and per-candidate deliveries.
  // Fail-open — logging errors don't block delivery.
  await logMatcherRun({
    opportunityId: opportunity.id,
    tranche,
    deliveryMode: candidateResult.mode,
    deliveredCount: candidateResult.delivered.length,
    topScore: candidateResult.topScore,
    reason: candidateResult.mode,
  });
  if (recruiterResult.delivered.length > 0 || recruiterResult.mode !== 'no_qualified_pool') {
    await logMatcherRun({
      opportunityId: opportunity.id,
      tranche,
      deliveryMode: recruiterResult.mode,
      deliveredCount: recruiterResult.delivered.length,
      topScore: recruiterResult.topScore,
      reason: `recruiter_${recruiterResult.mode}`,
    });
  }
  for (const c of candidateResult.delivered) {
    await logEvent({
      eventType: 'candidates_delivered',
      opportunityId: opportunity.id,
      userId: c.userId,
      metadata: { role: candidateRole, tranche, score: Math.round(c.score) },
    });
  }
  for (const c of recruiterResult.delivered) {
    await logEvent({
      eventType: 'candidates_delivered',
      opportunityId: opportunity.id,
      userId: c.userId,
      metadata: { role: 'recruiter', tranche, score: Math.round(c.score) },
    });
  }

  return {
    candidatesNotified: candidateResult.delivered.length,
    recruitersNotified: recruiterResult.delivered.length,
    candidateMode: candidateResult.mode,
    recruiterMode: recruiterResult.mode,
    candidateTopScore: candidateResult.topScore,
    recruiterTopScore: recruiterResult.topScore,
    candidateThreshold: candidateResult.threshold,
    recruiterThreshold: recruiterResult.threshold,
    candidateQualified: candidateResult.qualifiedCount,
    recruiterQualified: recruiterResult.qualifiedCount,
  };
}
