/**
 * lib/opportunities/notifications.ts
 *
 * Prompt #15 Step 4: delivery/notification split.
 *
 * Replaces the old suppressedUserIds() approach (which blocked BOTH candidate
 * delivery AND notification for a flat 7-day window). Now:
 *
 *   - Candidate delivery is NOT gated by recent notifications.
 *   - Notification firing is gated by per-type cooldowns.
 *
 * Users can receive a new opportunity silently (it appears in their For You
 * surface) even if they were notified about another opportunity recently.
 */

import { createAdminClient } from '@/lib/supabase/admin';

// Cooldown windows per notification type. Null = no cooldown (fires every time).
const COOLDOWNS_DAYS: Record<string, number | null> = {
  opportunity_received: 5,
  recruiter_request: 14,
  opportunity_response: 1,
  opportunity_nudge_creator: 14,
  opportunity_nudge_receiver: 5,
  opportunity_closed: null,
};

/**
 * Should we fire a notification of this type to this user right now?
 * Returns false if user received the same type within the cooldown window.
 */
export async function shouldNotify(userId: string, type: string): Promise<boolean> {
  const days = COOLDOWNS_DAYS[type];
  if (days === null || days === undefined) return true;

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();

  const { data, error } = await admin
    .from('notifications')
    .select('id')
    .eq('user_id', userId)
    .eq('type', type)
    .gte('created_at', cutoff)
    .limit(1);

  if (error) {
    console.warn('[opportunities/shouldNotify] query error', error);
    // Fail-open: if we can't check, allow the notification. Better to over-notify
    // once than suppress in a masked-error state.
    return true;
  }

  return (data ?? []).length === 0;
}
