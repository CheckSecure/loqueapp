'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

export async function updateProfile(formData: FormData) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const updates = {
    full_name: formData.get('full_name') as string,
    role: formData.get('role') as string,
    company: formData.get('company') as string,
    location: formData.get('location') as string,
    bio: formData.get('bio') as string,
    linkedin_url: formData.get('linkedin_url') as string,
    twitter_url: formData.get('twitter_url') as string,
    website_url: formData.get('website_url') as string,
    open_to_intros: formData.get('open_to_intros') === 'true',
    expertise: (formData.get('expertise') as string || '').split(',').map(s => s.trim()).filter(Boolean),
    updated_at: new Date().toISOString(),
  }

  const { error } = await supabase.from('profiles').upsert({ id: user.id, ...updates })
  if (error) return { error: error.message }
  revalidatePath('/dashboard/profile')
  return { success: true }
}

export async function requestIntroduction(targetId: string) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { error } = await supabase.from('introductions').insert({
    requester_id: user.id,
    target_id: targetId,
  })
  if (error) return { error: error.message }
  revalidatePath('/dashboard/introductions')
  return { success: true }
}

export async function updateIntroStatus(id: string, status: 'accepted' | 'declined') {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { error } = await supabase
    .from('introductions')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('target_id', user.id)

  if (error) return { error: error.message }
  revalidatePath('/dashboard/introductions')
  return { success: true }
}

export async function sendMessage(conversationId: string, content: string) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { error } = await supabase.from('messages').insert({
    conversation_id: conversationId,
    sender_id: user.id,
    content,
  })
  if (error) return { error: error.message }
  revalidatePath('/dashboard/messages')
  return { success: true }
}

export async function createConversation(otherUserId: string) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: conv, error: convError } = await supabase
    .from('conversations')
    .insert({})
    .select('id')
    .single()

  if (convError || !conv) return { error: convError?.message }

  await supabase.from('conversation_participants').insert([
    { conversation_id: conv.id, user_id: user.id },
    { conversation_id: conv.id, user_id: otherUserId },
  ])

  revalidatePath('/dashboard/messages')
  return { conversationId: conv.id }
}

export async function scheduleMeeting(formData: FormData) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { error } = await supabase.from('meetings').insert({
    organizer_id: user.id,
    title: formData.get('title') as string,
    attendee_id: formData.get('attendee_id') as string || null,
    scheduled_at: formData.get('scheduled_at') as string,
    duration_minutes: parseInt(formData.get('duration_minutes') as string || '30'),
    meeting_type: formData.get('meeting_type') as string || 'video',
    location: formData.get('location') as string || null,
  })
  if (error) return { error: error.message }
  revalidatePath('/dashboard/meetings')
  return { success: true }
}
