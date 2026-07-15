/**
 * Ownership helpers for the NotificationBell.
 *
 * The bell reads/writes notifications with the browser (user-JWT) client, so
 * RLS is the primary guard. These helpers add explicit user-ownership scoping
 * as defense-in-depth: a server-side realtime filter, a payload ownership check,
 * and user_id constraints on the read + mark-as-read queries. Pure/thin so the
 * scoping is unit-testable without rendering React or hitting Supabase.
 */

/** Server-side postgres_changes filter for the current user's rows only. */
export function realtimeFilterForUser(userId: string): string {
  return `user_id=eq.${userId}`
}

/** Defensive check: does a realtime payload row belong to the signed-in user? */
export function isOwnNotification(
  row: { user_id?: string | null } | null | undefined,
  userId: string | null | undefined,
): boolean {
  return !!row && !!userId && row.user_id === userId
}

/** Initial load — scoped to the user (explicit, on top of RLS), newest first. */
export function scopedNotificationsQuery(client: any, userId: string) {
  return client
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20)
}

/** Mark all of the user's given notification ids as read — user-constrained. */
export function markAllReadQuery(client: any, userId: string, ids: string[], readAt: string) {
  return client
    .from('notifications')
    .update({ read_at: readAt })
    .eq('user_id', userId)
    .in('id', ids)
}

/** Mark a single notification read — constrained to both id AND the user. */
export function markOneReadQuery(client: any, userId: string, id: string, readAt: string) {
  return client
    .from('notifications')
    .update({ read_at: readAt })
    .eq('user_id', userId)
    .eq('id', id)
}

/**
 * Mark ONLY the message notifications for one conversation read — scoped to the
 * user, the 'message_received' type, and data->>conversationId. Opening a
 * conversation clears its own message notifications without touching any other
 * conversation's (or any other type's) notifications.
 */
export function markConversationMessageNotificationsReadQuery(
  client: any,
  userId: string,
  conversationId: string,
  readAt: string,
) {
  return client
    .from('notifications')
    .update({ read_at: readAt })
    .eq('user_id', userId)
    .eq('type', 'message_received')
    .eq('data->>conversationId', conversationId)
    .is('read_at', null)
}
