import { createAdminClient } from '@/lib/supabase/admin'

type NotificationType = 'new_batch' | 'intro_accepted' | 'new_message' | 'meeting_scheduled'

interface CreateNotificationParams {
  userId: string
  type: NotificationType
  title: string
  body: string
  link?: string
}

export async function createNotification(params: CreateNotificationParams) {
  const adminClient = createAdminClient()
  const { error } = await adminClient.from('notifications').insert({
    user_id: params.userId,
    type: params.type,
    title: params.title,
    body: params.body,
    link: params.link ?? null,
  })
  if (error) console.error('[notifications] failed to create:', error.message)
}

export async function createNotificationsForAllUsers(
  type: NotificationType,
  title: string,
  body: string,
  link?: string
) {
  const adminClient = createAdminClient()
  const { data: profiles } = await adminClient
    .from('profiles')
    .select('id')
    .eq('profile_complete', true)
    .eq('is_active', true)
    .neq('email', 'bizdev91@gmail.com')

  if (!profiles || profiles.length === 0) return

  const notifications = profiles.map(p => ({
    user_id: p.id,
    type,
    title,
    body,
    link: link ?? null,
  }))

  const { error } = await adminClient.from('notifications').insert(notifications)
  if (error) console.error('[notifications] bulk create failed:', error.message)
}
