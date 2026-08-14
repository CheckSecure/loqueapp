import { buildBidirectionalBlockFilter } from '@/lib/db/filters'
import { createNotificationSafe as realCreateNotificationSafe } from '@/lib/notifications'
import { shouldEmailNewMessage as realShouldEmailNewMessage } from '@/lib/notifications/engagement'

/**
 * Single authoritative "send a message" path, shared by the API route (`/api/messages/send`) and the
 * `sendMessage` server action so their authorization can NEVER diverge again (the divergence that let a
 * blocked/removed member keep messaging). Runs entirely as service_role (browser INSERT on messages is
 * revoked, migration 055) but performs ALL authorization in code first:
 *
 *   - sender must be a participant of the conversation's match;
 *   - the match must not be removed/closed;
 *   - neither party may have blocked the other (bidirectional);
 *   - both sender and recipient must be active (not deactivated).
 *
 * EVERY rejection returns a single generic 403 and performs NO side effect — no message row, no
 * conversation metadata bump, no notification, no realtime signal, no email. Only after all checks pass
 * is the message inserted and the recipient notified/emailed (best-effort).
 */

export interface SendMessageParams {
  senderId: string
  conversationId: string
  content: string
}

export interface SendMessageDeps {
  createNotificationSafe?: typeof realCreateNotificationSafe
  shouldEmailNewMessage?: typeof realShouldEmailNewMessage
  /** injected for tests; defaults to the real lazy import in production */
  sendNewMessageEmail?: (to: string, toName: string, fromName: string, content: string) => Promise<unknown>
  /** gate emailing behind provider config; defaults to !!process.env.RESEND_API_KEY */
  resendConfigured?: boolean
}

export type SendMessageResult =
  | { ok: true; status: 200; message: any; isFirstMessage: boolean }
  | { ok: false; status: 400 | 403; code: 'invalid' | 'forbidden'; error: string }

// One opaque rejection for every authorization failure so the caller cannot be used as an oracle
// (participant? blocked? removed? inactive? — all indistinguishable).
const FORBIDDEN: SendMessageResult = { ok: false, status: 403, code: 'forbidden', error: 'This conversation is unavailable.' }

export async function sendMessageCore(admin: any, params: SendMessageParams, deps: SendMessageDeps = {}): Promise<SendMessageResult> {
  const createNotificationSafe = deps.createNotificationSafe ?? realCreateNotificationSafe
  const shouldEmailNewMessage = deps.shouldEmailNewMessage ?? realShouldEmailNewMessage
  const resendConfigured = deps.resendConfigured ?? !!process.env.RESEND_API_KEY

  const senderId = params.senderId
  const conversationId = params.conversationId
  const content = (params.content ?? '').trim()
  if (!conversationId || !content) return { ok: false, status: 400, code: 'invalid', error: 'Missing required fields' }

  // Conversation + match (service_role; RLS bypassed, so in-code checks are the authority).
  const { data: conversation } = await admin
    .from('conversations')
    .select('id, match_id, first_message_sent_at, message_count')
    .eq('id', conversationId)
    .maybeSingle()
  if (!conversation?.match_id) return FORBIDDEN

  const { data: match } = await admin
    .from('matches')
    .select('user_a_id, user_b_id, status')
    .eq('id', conversation.match_id)
    .maybeSingle()
  if (!match) return FORBIDDEN

  // Participant check.
  if (match.user_a_id !== senderId && match.user_b_id !== senderId) return FORBIDDEN
  // Removed/closed match → no messaging.
  if (match.status === 'removed' || match.status === 'closed') return FORBIDDEN

  const recipientId = match.user_a_id === senderId ? match.user_b_id : match.user_a_id

  // Bidirectional block check (senderId + recipientId are server-derived UUIDs).
  const { data: blockRow } = await admin
    .from('blocked_users')
    .select('id')
    .or(buildBidirectionalBlockFilter(senderId, recipientId))
    .limit(1)
    .maybeSingle()
  if (blockRow) return FORBIDDEN

  // Both parties must be active. One round-trip for both profiles (also grabs recipient email/name).
  const { data: parties } = await admin
    .from('profiles')
    .select('id, account_status, email, full_name')
    .in('id', [senderId, recipientId])
  const senderProfile = (parties ?? []).find((p: any) => p.id === senderId)
  const recipientProfile = (parties ?? []).find((p: any) => p.id === recipientId)
  if (!senderProfile || senderProfile.account_status !== 'active') return FORBIDDEN
  if (!recipientProfile || recipientProfile.account_status !== 'active') return FORBIDDEN

  // ── Authorized. Insert the message. ──
  const nowIso = new Date().toISOString()
  const { data: message, error: insertErr } = await admin
    .from('messages')
    .insert({ conversation_id: conversationId, sender_id: senderId, content, is_system: false, created_at: nowIso })
    .select()
    .single()
  if (insertErr || !message) return FORBIDDEN // fail closed; no partial side effects follow

  const isFirstMessage = !conversation.first_message_sent_at
  await admin
    .from('conversations')
    .update({
      first_message_sent_at: conversation.first_message_sent_at || nowIso,
      last_message_at: nowIso,
      message_count: (conversation.message_count || 0) + 1,
    })
    .eq('id', conversationId)

  // Notification (idempotent on message id) + throttled best-effort email — never block the result.
  const createdNotif = await createNotificationSafe({
    userId: recipientId,
    type: 'message_received',
    data: { conversationId, fromUserId: senderId, messageId: message.id },
    link: `/dashboard/messages/${conversationId}`,
    dedupeKey: message.id,
  })

  try {
    if (createdNotif && resendConfigured && recipientProfile.email) {
      const { data: unreadNudges } = await admin
        .from('notifications')
        .select('id')
        .eq('user_id', recipientId)
        .eq('type', 'message_received')
        .eq('data->>conversationId', conversationId)
        .is('read_at', null)
      const hasOtherUnreadInConversation = (unreadNudges ?? []).length > 1

      const { data: recipientPresence } = await admin
        .from('member_presence')
        .select('last_active_at')
        .eq('user_id', recipientId)
        .maybeSingle()

      if (shouldEmailNewMessage({
        recipientLastActiveAt: recipientPresence?.last_active_at ?? null,
        hasOtherUnreadInConversation,
      })) {
        const send = deps.sendNewMessageEmail ?? (async (to, toName, fromName, body) => {
          const { sendNewMessageEmail } = await import('@/lib/email')
          return sendNewMessageEmail(to, toName, fromName, body)
        })
        await send(recipientProfile.email, recipientProfile.full_name || 'there', senderProfile.full_name || 'A member', content)
      }
    }
  } catch (emailErr: any) {
    console.error('[sendMessageCore] email non-fatal:', emailErr?.message)
  }

  return { ok: true, status: 200, message, isFirstMessage }
}
