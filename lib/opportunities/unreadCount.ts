import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Live count for the Opportunities sidebar badge. Two components summed:
 *
 *   receiverCount — For You opportunities the user hasn't responded to or
 *   dismissed. Only active, non-archived opportunities count.
 *
 *   creatorCount — opportunity_responses with status 'interested' on signals
 *   the user has created that are still active + non-archived. Represents
 *   responses waiting on the creator's action.
 *
 * No read/seen state. Badge reflects actionable state. Decays when the user
 * responds, dismisses, closes, introduces, or archives.
 */
export async function getOpportunityBadgeCount(
  admin: SupabaseClient,
  userId: string
): Promise<{ receiverCount: number; creatorCount: number; total: number }> {
  try {
    // Receiver side: For You candidates, not dismissed, opportunity still active,
    // and user has not yet responded.
    const { data: candidates } = await admin
      .from('opportunity_candidates')
      .select('opportunity_id, opportunities!inner(status, archived_at)')
      .eq('user_id', userId)
      .is('dismissed_at', null)
      .eq('opportunities.status', 'active')
      .is('opportunities.archived_at', null);

    const candidateOppIds = (candidates ?? []).map((c: any) => c.opportunity_id);

    let receiverCount = 0;
    if (candidateOppIds.length > 0) {
      const { data: responded } = await admin
        .from('opportunity_responses')
        .select('opportunity_id')
        .eq('user_id', userId)
        .in('opportunity_id', candidateOppIds);
      const respondedSet = new Set((responded ?? []).map((r: any) => r.opportunity_id));
      receiverCount = candidateOppIds.filter((id: string) => !respondedSet.has(id)).length;
    }

    // Creator side: interested responses waiting on action. Only count responses
    // whose underlying opportunity is still active + non-archived (expired/closed
    // signals should not produce badge noise).
    const { data: mySignals } = await admin
      .from('opportunities')
      .select('id')
      .eq('creator_id', userId)
      .eq('status', 'active')
      .is('archived_at', null);

    const mySignalIds = (mySignals ?? []).map((s: any) => s.id);

    let creatorCount = 0;
    if (mySignalIds.length > 0) {
      const { count } = await admin
        .from('opportunity_responses')
        .select('id', { count: 'exact', head: true })
        .in('opportunity_id', mySignalIds)
        .eq('status', 'interested')
        .is('declined_by_creator_at', null);
      creatorCount = count ?? 0;
    }

    return {
      receiverCount,
      creatorCount,
      total: receiverCount + creatorCount,
    };
  } catch {
    return { receiverCount: 0, creatorCount: 0, total: 0 };
  }
}
