'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import pool from '@/lib/db'

async function getAuthUser() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function updateProfile(formData: FormData) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated' }

  const expertise = (formData.get('expertise') as string || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  const introPref = (formData.get('intro_preferences') as string || '')
    .split(',').map(s => s.trim()).filter(Boolean)

  await pool.query(
    `UPDATE profiles SET
       full_name = $2, role = $3, company = $4, location = $5, bio = $6,
       expertise = $7, intro_preferences = $8, open_to_intros = $9,
       linkedin_url = $10, twitter_url = $11, website_url = $12, updated_at = now()
     WHERE id = $1`,
    [
      user.id,
      formData.get('full_name') as string || null,
      formData.get('role') as string || null,
      formData.get('company') as string || null,
      formData.get('location') as string || null,
      formData.get('bio') as string || null,
      expertise,
      introPref,
      formData.get('open_to_intros') === 'true',
      formData.get('linkedin_url') as string || null,
      formData.get('twitter_url') as string || null,
      formData.get('website_url') as string || null,
    ]
  )

  revalidatePath('/dashboard/profile')
  return { success: true }
}

export async function requestIntroduction(targetId: string) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated' }

  try {
    await pool.query(
      `INSERT INTO introductions (requester_id, target_id) VALUES ($1, $2)
       ON CONFLICT (requester_id, target_id) DO NOTHING`,
      [user.id, targetId]
    )
    revalidatePath('/dashboard/introductions')
    return { success: true }
  } catch (err: any) {
    return { error: err.message }
  }
}

export async function updateIntroStatus(id: string, status: 'accepted' | 'declined') {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated' }

  await pool.query(
    `UPDATE introductions SET status = $1, updated_at = now()
     WHERE id = $2 AND target_id = $3`,
    [status, id, user.id]
  )
  revalidatePath('/dashboard/introductions')
  return { success: true }
}

export async function sendMessage(conversationId: string, content: string) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated' }

  try {
    await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1, $2, $3)`,
      [conversationId, user.id, content]
    )
    revalidatePath('/dashboard/messages')
    return { success: true }
  } catch (err: any) {
    return { error: err.message }
  }
}

export async function createConversation(otherUserId: string) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated' }

  try {
    const { rows } = await pool.query(
      `INSERT INTO conversations DEFAULT VALUES RETURNING id`
    )
    const convId = rows[0].id
    await pool.query(
      `INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
      [convId, user.id, otherUserId]
    )
    revalidatePath('/dashboard/messages')
    return { conversationId: convId }
  } catch (err: any) {
    return { error: err.message }
  }
}

export async function scheduleMeeting(formData: FormData) {
  const user = await getAuthUser()
  if (!user) return { error: 'Not authenticated' }

  try {
    await pool.query(
      `INSERT INTO meetings (title, organizer_id, attendee_id, scheduled_at, duration_minutes, meeting_type, location)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        formData.get('title') as string,
        user.id,
        formData.get('attendee_id') as string || null,
        formData.get('scheduled_at') as string,
        parseInt(formData.get('duration_minutes') as string || '30'),
        formData.get('meeting_type') as string || 'video',
        formData.get('location') as string || null,
      ]
    )
    revalidatePath('/dashboard/meetings')
    return { success: true }
  } catch (err: any) {
    return { error: err.message }
  }
}
