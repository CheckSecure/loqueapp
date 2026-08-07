/**
 * Client-side contract for the admin "Send password reset" action.
 *
 * Calls POST /api/admin/send-password-reset with the memberId and maps the response to a
 * neutral UI result. It reads ONLY the HTTP status and the safe `sent` boolean — it never
 * reads or surfaces a recovery link, auth token, password, or the raw provider response.
 * Extracted from AdminMembersClient so the fetch/mapping is unit-testable in node.
 */
export type ResetUiResult = { kind: 'success' | 'error'; message: string }

export const RESET_SUCCESS = 'Password reset email requested.'
export const RESET_FAILURE = 'Unable to send reset email. Try again or check auth logs.'

export async function requestMemberPasswordReset(
  memberId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResetUiResult> {
  try {
    const res = await fetchImpl('/api/admin/send-password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok && (data as any)?.sent) return { kind: 'success', message: RESET_SUCCESS }
    return { kind: 'error', message: RESET_FAILURE }
  } catch {
    return { kind: 'error', message: RESET_FAILURE }
  }
}
