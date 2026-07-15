import { createAdminClient } from '@/lib/supabase/admin'

export type NotificationType = 
  | 'new_batch'
  | 'interest_received'
  | 'mutual_match'
  | 'message_received'
  | 'low_credits'
  | 'no_credits'
  | 'nudge_reply'
  | 'nudge_interest'
  | 'admin_intro'
  | 'admin_intro_nudge'
  | 'opportunity_received'
  | 'recruiter_request'
  | 'opportunity_response'
  | 'opportunity_nudge_creator'
  | 'opportunity_nudge_receiver'
  | 'opportunity_closed'
  | 'meeting_request'
  | 'meeting_accepted'
  | 'meeting_declined'
  | 'new_connection'
  | 'intro_accepted'

export interface NotificationData {
  matchId?: string
  conversationId?: string
  messageId?: string
  batchCount?: number
  creditsRemaining?: number
  fromUserId?: string
  fromUserName?: string
  /** Set by createNotificationSafe when a dedupeKey is supplied — enables
   *  per-entity idempotency (e.g. one notification per message id). */
  dedupeKey?: string
  [key: string]: any
}

export interface CreateNotificationParams {
  userId: string
  type: NotificationType
  title: string
  message?: string
  data?: NotificationData
}

const NOTIFICATION_COPY: Partial<Record<NotificationType, { title: string; message: string }>> = {
  new_batch: {
    title: 'New curated introductions',
    message: 'Your latest set of curated connections is ready to review.'
  },
  interest_received: {
    title: 'New connection interest',
    message: 'A curated connection is interested in meeting you.'
  },
  mutual_match: {
    title: 'Introduction ready',
    message: 'You\'re now connected.'
  },
  message_received: {
    title: 'New message',
    message: 'You have a new message from a connection.'
  },
  low_credits: {
    title: 'Credits running low',
    message: 'You have limited credits remaining this cycle.'
  },
  no_credits: {
    title: 'No credits remaining',
    message: 'You have no credits. Add credits to make new connections.'
  },
  nudge_interest: {
    title: 'Connections waiting',
    message: 'You have curated connections ready to review.'
  },
  nudge_reply: {
    title: 'Introduction awaiting response',
    message: 'A connection is waiting to hear from you.'
  },
  admin_intro_nudge: {
    title: 'Introduction update',
    message: 'Someone is ready to connect with you.'
  },
  admin_intro: {
    title: 'A curated introduction',
    message: 'We think you should meet — this is a strong match.'
  },
  opportunity_received: {
    title: 'A curated opportunity',
    message: 'Someone is signaling a need you can help with.'
  },
  recruiter_request: {
    title: 'A hiring signal in your network',
    message: 'Someone you know is hiring for a role in your reach.'
  },
  opportunity_response: {
    title: 'Someone responded to your signal',
    message: 'Review the response to make an introduction.'
  },
  opportunity_nudge_creator: {
    title: 'Responses waiting for review',
    message: 'Take a look at who’s interested in your signal.'
  },
  opportunity_nudge_receiver: {
    title: 'You have opportunities waiting',
    message: 'Curated opportunities are in your inbox.'
  },
  opportunity_closed: {
    title: 'Opportunity closed',
    message: 'A signal you responded to is no longer active.'
  }
}

const LINK_BY_TYPE: Partial<Record<string, string>> = {
  admin_intro: '/dashboard/introductions',
  admin_intro_nudge: '/dashboard/introductions',
  interest_received: '/dashboard/introductions',
  mutual_match: '/dashboard/messages',
  message_received: '/dashboard/messages',
  new_batch: '/dashboard/introductions',
  nudge_interest: '/dashboard/introductions',
  nudge_reply: '/dashboard/messages',
  low_credits: '/dashboard/billing',
  no_credits: '/dashboard/billing',
  opportunity_received: '/dashboard/opportunities',
  recruiter_request: '/dashboard/opportunities',
  opportunity_response: '/dashboard/opportunities/signals',
  opportunity_nudge_creator: '/dashboard/opportunities/signals',
  opportunity_nudge_receiver: '/dashboard/opportunities',
  opportunity_closed: '/dashboard/opportunities/responses'
}

export async function createNotificationSafe({
  userId,
  type,
  data, link, dedupeKey}: {
  userId: string
  type: NotificationType
  data?: NotificationData; link?: string
  /**
   * Per-entity idempotency key (e.g. a message id). When supplied, a duplicate
   * is defined as an EXISTING notification with the same (user_id, type,
   * data->>dedupeKey) — with NO time window — so distinct entities each notify
   * once and a retry for the same entity is a no-op. When omitted, the legacy
   * "one per (user_id, type) per 24h" digest behavior is preserved so existing
   * notification types are unaffected.
   */
  dedupeKey?: string}) {
  const adminClient = createAdminClient()

  console.log('[Notifications] createNotificationSafe called:', { userId, type, dedupeKey })
  try {
    let dupeQuery = adminClient
      .from('notifications')
      .select('id')
      .eq('user_id', userId)
      .eq('type', type)

    if (dedupeKey) {
      // Idempotent per entity — no time window.
      dupeQuery = dupeQuery.eq('data->>dedupeKey', dedupeKey)
    } else {
      // Legacy digest dedup — at most one of this type per 24h.
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      dupeQuery = dupeQuery.gte('created_at', twentyFourHoursAgo)
    }

    const { data: existing, error: dupeErr } = await dupeQuery.maybeSingle()

    if (dupeErr) console.error('[Notifications] Dupe check error:', dupeErr)

    if (existing) {
      console.log(`[Notifications] Duplicate prevented: ${type} for user ${userId}${dedupeKey ? ` (dedupeKey ${dedupeKey})` : ''}`)
      return null
    }

    // Persist the dedupeKey inside data so the check above can find it next time.
    if (dedupeKey) data = { ...(data ?? {}), dedupeKey }

    const copy = NOTIFICATION_COPY[type]
    if (!copy) {
      console.error(`[Notifications] Unknown type: ${type}`)
      return null
    }

    console.log('[Notifications] Inserting:', { type, userId, copy })
    const { data: notification, error } = await adminClient
      .from('notifications')
      .insert({
        link: (link ?? LINK_BY_TYPE[type]) || null,
        user_id: userId,
        type,
        title: copy.title,
        body: copy.message,
        data,
        created_at: new Date().toISOString()
      })
      .select()
      .single()

    if (error) {
      // 23505 = unique_violation. With the partial unique index
      // (notifications_user_type_dedupe_key_uniq) a concurrent identical request
      // can lose the race here; that is the intended idempotent outcome, not an
      // error — the notification already exists. Return cleanly, don't surface it.
      if ((error as { code?: string }).code === '23505') {
        console.log('[Notifications] Idempotent no-op (dedupeKey unique conflict):', { userId, type, dedupeKey })
        return null
      }
      console.error('[Notifications] Insert error:', error)
      return null
    }
    console.log('[Notifications] Inserted OK:', notification?.id)

    try {
      await adminClient.rpc('cleanup_old_notifications', {
        user_id_input: userId
      })
    } catch (err) {
      console.warn('[Notifications] Cleanup failed:', err)
    }

    console.log('[Notifications] Created:', {
      userId,
      type,
      title: copy.title
    })

    return notification
  } catch (error) {
    console.error('[Notifications] Error:', error)
    return null
  }
}

export async function createNotification({
  userId,
  type,
  title,
  message,
  data
}: CreateNotificationParams) {
  const adminClient = createAdminClient()

  try {
    const { data: notification, error } = await adminClient
      .from('notifications')
      .insert({
        user_id: userId,
        type,
        title,
        message,
        data,
        created_at: new Date().toISOString()
      })
      .select()
      .single()

    if (error) {
      console.error('[Notifications] Insert error:', error)
      return null
    }
    console.log('[Notifications] Inserted OK:', notification?.id)

    if (error) {
      console.error('[Notifications] Failed to create:', error)
      return null
    }

    console.log('[Notifications] Created:', {
      userId,
      type,
      title
    })

    return notification
  } catch (error) {
    console.error('[Notifications] Error:', error)
    return null
  }
}

export function getNotificationRoute(type: NotificationType, data?: NotificationData): string {
  switch (type) {
    case 'new_batch':
      return '/dashboard'
    case 'interest_received':
      return '/dashboard'
    case 'mutual_match':
      return data?.conversationId 
        ? `/dashboard/messages/${data.conversationId}`
        : '/dashboard/network'
    case 'message_received':
      return data?.conversationId 
        ? `/dashboard/messages/${data.conversationId}`
        : '/dashboard/messages'
    case 'low_credits':
      return '/dashboard'
    case 'no_credits':
      return '/pricing'
    case 'nudge_reply':
      return data?.conversationId 
        ? `/dashboard/messages/${data.conversationId}`
        : '/dashboard/network'
    case 'nudge_interest':
      return '/dashboard'
    default:
      return '/dashboard'
  }
}// Force rebuild
