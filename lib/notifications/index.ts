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

// Premium notification copy
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
    message: 'Your introduction has been facilitated. You can now connect.'
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
  }
}


/**
 * Create a notification safely (prevents duplicates within 24 hours)
 */
export async function createNotificationSafe({
  userId,
  type,
  data
}: {
  userId: string
  type: NotificationType
  data?: NotificationData
}) {
  const adminClient = createAdminClient()

  try {
    // Check for duplicate notification in last 24 hours
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    
    const { data: existing } = await adminClient
      .from('notifications')
      .select('id')
      .eq('user_id', userId)
      .eq('type', type)
      .gte('created_at', twentyFourHoursAgo)
      .maybeSingle()

    if (existing) {
      console.log(`[Notifications] Duplicate prevented: ${type} for user ${userId}`)
      return null
    }

    // Get copy from mapping
    const copy = NOTIFICATION_COPY[type]
    if (!copy) {
      console.error(`[Notifications] Unknown type: ${type}`)
      return null
    }

    // Create notification
    const { data: notification, error } = await adminClient
      .from('notifications')
      .insert({
        user_id: userId,
        type,
        title: copy.title,
        message: copy.message,
        data,
        read: false,
        created_at: new Date().toISOString()
      })
      .select()
      .single()

    if (error) {
      console.error('[Notifications] Failed to create:', error)
      return null
    }

    // Cleanup old notifications (keep last 100)
    await adminClient.rpc('cleanup_old_notifications', {
      user_id_input: userId
    }).catch(err => {
      // Don't fail if cleanup fails
      console.warn('[Notifications] Cleanup failed:', err)
    })

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

/**
 * Create a notification for a user
 */
export async function createNotification({
  userId,
  type,
  title,
  message,
  data
}: CreateNotificationParams) {
  // Legacy function - use createNotificationSafe instead
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
        read: false,
        created_at: new Date().toISOString()
      })
      .select()
      .single()

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

/**
 * Create notifications for multiple users
 */
export async function createBulkNotifications(
  notifications: CreateNotificationParams[]
) {
  const adminClient = createAdminClient()

  try {
    const records = notifications.map(n => ({
      user_id: n.userId,
      type: n.type,
      title: n.title,
      message: n.message,
      data: n.data,
      read: false,
      created_at: new Date().toISOString()
    }))

    const { error } = await adminClient
      .from('notifications')
      .insert(records)

    if (error) {
      console.error('[Notifications] Bulk create failed:', error)
      return false
    }

    console.log(`[Notifications] Created ${records.length} notifications`)
    return true
  } catch (error) {
    console.error('[Notifications] Bulk error:', error)
    return false
  }
}

/**
 * Mark notification as read
 */
export async function markNotificationRead(notificationId: string, userId: string) {
  const adminClient = createAdminClient()

  try {
    const { error } = await adminClient
      .from('notifications')
      .update({ read: true })
      .eq('id', notificationId)
      .eq('user_id', userId) // Security: only mark own notifications

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

/**
 * Mark all notifications as read for a user
 */
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

/**
 * Get navigation route for notification type
 */
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
}
