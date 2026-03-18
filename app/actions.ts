'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import {
  createIntroRequest,
  approveIntroRequest,
  rejectIntroRequest,
} from '@/lib/introRequests'

async function getSupabaseAndUser() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return { supabase, user }
}

export async function updateProfile(formData: FormData) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  const expertise = (formData.get('expertise') as string || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  const introPref = (formData.get('intro_preferences') as string || '')
    .split(',').map(s => s.trim()).filter(Boolean)

  const { error } = await supabase.from('profiles').upsert({
    id: user.id,
    full_name: formData.get('full_name') as string || null,
    title: formData.get('title') as string || null,
    company: formData.get('company') as string || null,
    location: formData.get('location') as string || null,
    bio: formData.get('bio') as string || null,
    expertise,
    intro_preferences: introPref,
    open_to_intros: formData.get('open_to_intros') === 'true',
    linkedin_url: formData.get('linkedin_url') as string || null,
    twitter_url: formData.get('twitter_url') as string || null,
    website_url: formData.get('website_url') as string || null,
    seniority: formData.get('seniority') as string || null,
    role_type: formData.get('role_type') as string || null,
    mentorship_role: formData.get('mentorship_role') as string || null,
    updated_at: new Date().toISOString(),
  })

  if (error) return { error: error.message }
  revalidatePath('/dashboard/profile')
  return { success: true }
}

export async function requestIntroduction(targetId: string) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  const { error } = await supabase.from('introductions').insert({
    requester_id: user.id,
    target_id: targetId,
  })

  if (error) return { error: error.message }
  revalidatePath('/dashboard/introductions')
  return { success: true }
}

export async function submitIntroRequest(targetUserId: string, note?: string) {
  const { user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }
  const result = await createIntroRequest(user.id, user.email ?? '', targetUserId, note)
  if (result.error) return { error: result.error }
  revalidatePath('/dashboard/introductions')
  return { success: true }
}

export async function adminApproveIntro(requestId: string) {
  const { user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }
  const result = await approveIntroRequest(requestId)
  if (result.error) return { error: result.error }
  revalidatePath('/dashboard/admin')
  return { success: true }
}

export async function adminRejectIntro(requestId: string) {
  const { user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }
  const result = await rejectIntroRequest(requestId)
  if (result.error) return { error: result.error }
  revalidatePath('/dashboard/admin')
  return { success: true }
}

export async function updateIntroStatus(id: string, status: 'accepted' | 'declined') {
  const { supabase, user } = await getSupabaseAndUser()
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
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  console.log('[sendMessage] conversationId:', conversationId, 'sender_id:', user.id)

  const { error } = await supabase.from('messages').insert({
    conversation_id: conversationId,
    sender_id: user.id,
    content,
  })

  console.log('[sendMessage] insert error:', JSON.stringify(error))

  if (error) return { error: error.message }
  revalidatePath('/dashboard/messages')
  return { success: true }
}

export async function createConversation(otherUserId: string) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .insert({})
    .select('id')
    .single()

  if (convErr || !conv) return { error: convErr?.message }

  await supabase.from('conversation_participants').insert([
    { conversation_id: conv.id, user_id: user.id },
    { conversation_id: conv.id, user_id: otherUserId },
  ])

  revalidatePath('/dashboard/messages')
  return { conversationId: conv.id }
}

export async function saveOnboardingPreferences(prefs: {
  who_to_meet: string[]
  preferred_seniority: string[]
  reasons_to_connect: string[]
  geographic_preference: string
  open_to_virtual: boolean
  open_to_in_person: boolean
  mentorship_topics: string[]
  meeting_cadence: string
}) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  const { error } = await supabase.from('user_preferences').upsert({
    user_id: user.id,
    ...prefs,
    onboarding_completed: true,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' })

  if (error) return { error: error.message }
  revalidatePath('/dashboard/introductions')
  return { success: true }
}

export async function scheduleMeeting(formData: FormData) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  const date = formData.get('date') as string
  const time = formData.get('time') as string
  const scheduled_at = date && time ? new Date(`${date}T${time}:00`).toISOString() : null

  const recipientId = (formData.get('recipient_id') as string || '').trim()
  if (!recipientId) return { error: 'Please select who you are meeting with.' }
  if (!scheduled_at) return { error: 'Please provide a valid date and time.' }

  const { error } = await supabase.from('meetings').insert({
    requester_id: user.id,
    recipient_id: recipientId,
    purpose: (formData.get('title') as string || '').trim() || (formData.get('purpose') as string),
    format: formData.get('format') as string || 'virtual',
    status: 'requested',
    scheduled_at,
    duration_minutes: parseInt(formData.get('duration_minutes') as string || '30'),
    notes: (formData.get('notes') as string) || null,
    zoom_link: (formData.get('zoom_link') as string) || null,
  })

  if (error) return { error: error.message }
  revalidatePath('/dashboard/meetings')
  return { success: true }
}
