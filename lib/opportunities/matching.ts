/**
 * lib/opportunities/matching.ts
 *
 * Candidate selection for the three opportunity paths.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import {
  DELIVERY_CEILING,
  OPPORTUNITY_NOTIF_SUPPRESSION_DAYS,
  REMOVED_MATCH_COOLDOWN_DAYS,
  RECRUITER_WEEKLY_CAP,
} from './caps';
import { acceptedRoleTypesForNeed } from './relevance';

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
};

type ScoredCandidate = { userId: string; score: number };

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

  return excluded;
}

async function suppressedUserIds(): Promise<Set<string>> {
  const admin = createAdminClient();
  const cutoff = new Date(
    Date.now() - OPPORTUNITY_NOTIF_SUPPRESSION_DAYS * 86400_000
  ).toISOString();
  const { data } = await admin
    .from('notifications')
    .select('user_id')
    .in('type', ['opportunity_received', 'recruiter_request'])
    .gte('created_at', cutoff);
  return new Set((data ?? []).map((r) => r.user_id));
}

async function alreadyDeliveredFor(opportunityId: string): Promise<Set<string>> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('opportunity_candidates')
    .select('user_id')
    .eq('opportunity_id', opportunityId);
  return new Set((data ?? []).map((r) => r.user_id));
}

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
  // JSON array shape: ["a","b"]
  if (trimmed.startsWith('[')) {
    try {
      const j = JSON.parse(trimmed);
      return Array.isArray(j) ? j.map((s) => String(s)) : [];
    } catch {
      return [];
    }
  }
  // Postgres array literal shape: {a,"b c",d}
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
  // Bare comma-separated fallback.
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

function expertiseOverlapCount(a: unknown, b: string[] | undefined): number {
  const parsed = parseExpertise(a);
  if (parsed.length === 0 || !b || b.length === 0) return 0;
  const set = new Set(b.map((s) => s.toLowerCase()));
  return parsed.filter((t) => set.has(t.toLowerCase())).length;
}

function seniorityFitBonus(candidate: string | null, target: string | undefined): number {
  if (!candidate || !target) return 0;
  const order = ['Junior', 'Mid-Level', 'Senior', 'Executive', 'C-Suite'];
  const ci = order.indexOf(candidate);
  const ti = order.indexOf(target);
  if (ci < 0 || ti < 0) return 0;
  const diff = Math.abs(ci - ti);
  if (diff === 0) return 5;
  if (diff === 1) return 2;
  return 0;
}

function scoreHiring(c: CandidateProfile, o: OpportunityRow): number {
  const overlap = expertiseOverlapCount(c.expertise, o.criteria.expertise);
  return (
    overlap * 2 +
    (Number(c.trust_score ?? 0) * 1.5) +
    Number(c.responsivenessScore ?? 0) +
    (Number(c.networkValueScore ?? 0) * 0.5) +
    seniorityFitBonus(c.seniority, o.criteria.seniority)
  );
}

function scoreBusiness(c: CandidateProfile, o: OpportunityRow): number {
  const overlap = expertiseOverlapCount(c.expertise, o.criteria.expertise);
  return (
    overlap * 3 +
    (Number(c.trust_score ?? 0) * 1.5) +
    Number(c.responsivenessScore ?? 0) +
    (Number(c.networkValueScore ?? 0) * 0.5)
  );
}

export async function selectCandidates(
  opportunity: OpportunityRow
): Promise<ScoredCandidate[]> {
  const admin = createAdminClient();

  const [excluded, suppressed, alreadyDelivered] = await Promise.all([
    excludedUserIdsFor(opportunity.creator_id),
    suppressedUserIds(),
    alreadyDeliveredFor(opportunity.id),
  ]);

  const { data: pool } = await admin
    .from('profiles')
    .select(
      'id, seniority, role_type, expertise, trust_score, ' +
      '"networkValueScore", "responsivenessScore"'
    )
    .eq('open_to_roles', true)
    .eq('account_status', 'active')
    .eq('profile_complete', true);

  const filtered = (pool ?? [])
    .filter((p) => !excluded.has(p.id))
    .filter((p) => !suppressed.has(p.id))
    .filter((p) => !alreadyDelivered.has(p.id))
    .filter((p) => {
      const overlap = expertiseOverlapCount(p.expertise, opportunity.criteria.expertise);
      const roleMatch = opportunity.criteria.role_types?.includes(p.role_type ?? '');
      return overlap > 0 || roleMatch;
    });

  const scored: ScoredCandidate[] = filtered.map((p) => ({
    userId: p.id,
    score: scoreHiring(p, opportunity),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, DELIVERY_CEILING.hiring);
}

export async function selectProviders(
  opportunity: OpportunityRow
): Promise<ScoredCandidate[]> {
  const admin = createAdminClient();

  const [excluded, suppressed, alreadyDelivered] = await Promise.all([
    excludedUserIdsFor(opportunity.creator_id),
    suppressedUserIds(),
    alreadyDeliveredFor(opportunity.id),
  ]);

  const acceptedRoles = acceptedRoleTypesForNeed(opportunity.criteria.need);

  const { data: pool } = await admin
    .from('profiles')
    .select(
      'id, seniority, role_type, expertise, trust_score, ' +
      '"networkValueScore", "responsivenessScore"'
    )
    .eq('open_to_business_solutions', true)
    .eq('account_status', 'active')
    .eq('profile_complete', true);

  const filtered = (pool ?? [])
    .filter((p) => !excluded.has(p.id))
    .filter((p) => !suppressed.has(p.id))
    .filter((p) => !alreadyDelivered.has(p.id))
    .filter((p) => acceptedRoles.includes(p.role_type ?? ''))
    .filter((p) => expertiseOverlapCount(p.expertise, opportunity.criteria.expertise) >= 1);

  const scored: ScoredCandidate[] = filtered.map((p) => ({
    userId: p.id,
    score: scoreBusiness(p, opportunity),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, DELIVERY_CEILING.business);
}

export async function selectRecruiters(
  opportunity: OpportunityRow
): Promise<ScoredCandidate[]> {
  const admin = createAdminClient();

  if (!opportunity.include_recruiters || opportunity.type !== 'hiring') return [];

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

  if (networkIds.size === 0) return [];

  const [excluded, suppressed, alreadyDelivered] = await Promise.all([
    excludedUserIdsFor(opportunity.creator_id),
    suppressedUserIds(),
    alreadyDeliveredFor(opportunity.id),
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
    .select('id, trust_score, "networkValueScore", "responsivenessScore"')
    .eq('recruiter', true)
    .eq('account_status', 'active')
    .eq('profile_complete', true)
    .in('id', Array.from(networkIds));

  const filtered = (pool ?? [])
    .filter((p) => !excluded.has(p.id))
    .filter((p) => !suppressed.has(p.id))
    .filter((p) => !alreadyDelivered.has(p.id))
    .filter((p) => !overCap.has(p.id));

  const scored: ScoredCandidate[] = filtered.map((p) => ({
    userId: p.id,
    score: Number(p.trust_score ?? 0) * 1.5 + Number(p.responsivenessScore ?? 0),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, DELIVERY_CEILING.recruiter);
}

export async function deliverOpportunity(
  opportunity: OpportunityRow
): Promise<{ candidatesNotified: number; recruitersNotified: number }> {
  const admin = createAdminClient();

  const candidates =
    opportunity.type === 'hiring'
      ? await selectCandidates(opportunity)
      : await selectProviders(opportunity);

  const recruiters = await selectRecruiters(opportunity);

  const candidateRole = opportunity.type === 'hiring' ? 'candidate' : 'provider';

  const rows = [
    ...candidates.map((c) => ({
      opportunity_id: opportunity.id,
      user_id: c.userId,
      role: candidateRole,
      relevance_score: c.score,
    })),
    ...recruiters.map((c) => ({
      opportunity_id: opportunity.id,
      user_id: c.userId,
      role: 'recruiter',
      relevance_score: c.score,
    })),
  ];

  if (rows.length > 0) {
    const { error } = await admin.from('opportunity_candidates').insert(rows);
    if (error) throw new Error(`opportunity_candidates insert failed: ${error.message}`);
  }

  const { createNotificationSafe } = await import('@/lib/notifications');

  await Promise.all([
    ...candidates.map((c) =>
      createNotificationSafe({
        userId: c.userId,
        type: 'opportunity_received',
        data: { opportunity_id: opportunity.id, role: candidateRole },
      })
    ),
    ...recruiters.map((c) =>
      createNotificationSafe({
        userId: c.userId,
        type: 'recruiter_request',
        data: { opportunity_id: opportunity.id, role: 'recruiter' },
      })
    ),
  ]);

  return { candidatesNotified: candidates.length, recruitersNotified: recruiters.length };
}
