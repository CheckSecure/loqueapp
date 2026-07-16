/**
 * Shared message-edit-window logic. Used by BOTH the client (to show/hide the
 * Edit control) and the server (which is authoritative). Keeping one constant +
 * one predicate ensures the UI and the enforced deadline can never drift.
 */

/** A member may edit their own message for 60 minutes after it was sent. */
export const MESSAGE_EDIT_WINDOW_MS = 60 * 60 * 1000

/** True if `now` is still within the edit window of a message sent at createdAt. */
export function isWithinEditWindow(
  createdAt: string | number | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (createdAt == null) return false
  const t = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime()
  if (Number.isNaN(t)) return false
  return now.getTime() <= t + MESSAGE_EDIT_WINDOW_MS
}

/** Minimal shape needed to decide edit eligibility. */
export interface EditableMessage {
  sender_id: string | null
  is_system: boolean
  created_at: string | number | Date | null | undefined
}

/**
 * Whether the given user may edit the given message right now:
 *   - they are the original sender,
 *   - it is not a system message,
 *   - it is still within the 60-minute window.
 * The server re-checks this from the stored created_at; the client uses it only
 * to decide whether to render the Edit control.
 */
export function canEditMessage(
  message: EditableMessage | null | undefined,
  currentUserId: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!message || !currentUserId) return false
  if (message.is_system) return false
  if (message.sender_id !== currentUserId) return false
  return isWithinEditWindow(message.created_at, now)
}
