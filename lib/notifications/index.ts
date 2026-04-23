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

export interface NotificationData {
  matchId?: string
  conversationId?: string
  batchCount?: number
  creditsRemaining?: number
  fromUserId?: string
  fromUserName?: string
  [key: string]: any
}

export interface CreateNotificationParams {
  userId: string
  type: NotificationType
  title: string
  message?: string
  data?: NotificationData
}

const NOTIFICATION_COPY = {
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
    message: 'You have used all available credits. Refill soon or upgrade to continue.'
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
  data, link}: {
  userId: string
  type: NotificationType
  data?: NotificationData; link?: string}) {
  const adminClient = createAdminClient()

  console.log('[Notifications] createNotificationSafe called:', { userId, type })
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    
    const { data: existing, error: dupeErr } = await adminClient
      .from('notifications')
      .select('id')
      .eq('user_id', userId)
      .eq('type', type)
      .gte('created_at', twentyFourHoursAgo)
      .maybeSingle()
    
    if (dupeErr) console.error('[Notifications] Dupe check error:', dupeErr)

    if (existing) {
      console.log(`[Notifications] Duplicate prevented: ${type} for user ${userId}`)
      return null
    }

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
      console.error('[Notifications] Insert error:', error)
      return null
    }
    console.log('[Notifications] Inserted OK:', notification?.id)

    if (error) {
      console.error('[Notifications] Failed to create:', error)
      return null
    }

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

export async function markNotificationRead(notificationId: string, userId: string) {
  const adminClient = createAdminClient()

  try {
    const { error } = await adminClient
      .from('notifications')
      .update({ read: true })
      .eq('id', notificationId)
      .eq('user_id', userId)

    if (error) {
      console.error('[Notifications] Failed to mark read:', error)
      return false
    }

    return true
  } catch (error) {
    console.error('[Notifications] Mark read error:', error)
    return false
  }
}

export async function markAllNotificationsRead(userId: string) {
  const adminClient = createAdminClient()

  try {
    const { error } = await adminClient
      .from('notifications')
      .update({ read: true })
      .eq('user_id', userId)
      .eq('read', false)

    if (error) {
      console.error('[Notifications] Failed to mark all read:', error)
      return false
    }

    return true
  } catch (error) {
    console.error('[Notifications] Mark all read error:', error)
    return false
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
