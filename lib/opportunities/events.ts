/**
 * lib/opportunities/events.ts
 *
 * Prompt #15 Step 7: lightweight observability.
 *
 * Writes to two tables:
 *   - opportunity_matcher_runs: one row per matcher invocation (tranche, mode, counts).
 *   - opportunity_events: one row per app-level event.
 *
 * All helpers are FAIL-OPEN. A logging error must never block a user action.
 * Admin-client writes, no user-facing surface.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export type OpportunityEventType =
  | 'opportunity_created'
  | 'candidates_delivered'
  | 'response_clicked'
  | 'connection_made';

export type MatcherRunMode =
  | 'above_threshold'
  | 'near_threshold_fallback'
  | 'below_quality_threshold'
  | 'no_qualified_pool';

export interface MatcherRunFacts {
  opportunityId: string;
  tranche: number;
  deliveryMode: MatcherRunMode;
  deliveredCount: number;
  totalScanned?: number;
  rateLimitedCount?: number;
  belowThresholdCount?: number;
  topScore?: number | null;
  reason?: string | null;
}

export async function logMatcherRun(facts: MatcherRunFacts): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from('opportunity_matcher_runs').insert({
      opportunity_id: facts.opportunityId,
      tranche: facts.tranche,
      delivery_mode: facts.deliveryMode,
      delivered_count: facts.deliveredCount,
      total_scanned: facts.totalScanned ?? null,
      rate_limited_count: facts.rateLimitedCount ?? null,
      below_threshold_count: facts.belowThresholdCount ?? null,
      top_score: facts.topScore ?? null,
      reason: facts.reason ?? null,
    });
    if (error) {
      console.warn('[opportunities/logMatcherRun] insert error', error);
    }
  } catch (err) {
    console.warn('[opportunities/logMatcherRun] exception', err);
  }
}

export interface EventFacts {
  eventType: OpportunityEventType;
  opportunityId?: string | null;
  userId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function logEvent(facts: EventFacts): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from('opportunity_events').insert({
      event_type: facts.eventType,
      opportunity_id: facts.opportunityId ?? null,
      user_id: facts.userId ?? null,
      metadata: facts.metadata ?? null,
    });
    if (error) {
      console.warn('[opportunities/logEvent] insert error', error);
    }
  } catch (err) {
    console.warn('[opportunities/logEvent] exception', err);
  }
}
