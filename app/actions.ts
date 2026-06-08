'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import { sendMeetingRequestEmail, sendMeetingAcceptedEmail, sendMeetingDeclinedEmail, sendMeetingRescheduledEmail, sendMatchCreatedEmail, sendAdminAlertEmail, sendWaitlistConfirmationEmail, escapeHtml } from '@/lib/email'
import {
  createIntroRequest,
  approveIntroRequest,
  rejectIntroRequest,
} from '@/lib/introRequests'
import { sendNewMessageEmail } from '@/lib/email'
import { generateOnboardingRecommendations } from '@/lib/generate-recommendations'
import { sendAdminWelcome } from '@/lib/onboarding/welcomeFromAdmin'
import { getEffectiveTier, getMonthlyCredits } from '@/lib/tier-override'
import { buildBidirectionalMatchFilter } from '@/lib/db/filters'

async function getSupabaseAndUser() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return { supabase, user }
}

export async function updateProfile(formData: FormData) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  // Parse expertise - handle both JSON array and comma-separated string
  const expertiseRaw = formData.get('expertise') as string || ''
  let expertise: string[] = []
  if (expertiseRaw) {
    try {
      expertise = JSON.parse(expertiseRaw)
    } catch {
      expertise = expertiseRaw.split(',').map(s => s.trim()).filter(Boolean)
    }
  }
  const introPref = (formData.get('intro_preferences') as string || '')
    .split(',').map(s => s.trim()).filter(Boolean)

  // open_to_mentorship is derived from mentorship_role. mentorship_role is the
  // user-facing/editable field; open_to_mentorship is what the matching engine
  // reads (lib/generate-recommendations.ts). Keeping them in sync on write is
  // what makes mentorship matching actually function.
  const mentorshipRole = (formData.get('mentorship_role') as string) || null
  const openToMentorship = mentorshipRole != null && ['Mentor', 'Mentee', 'Both'].includes(mentorshipRole)

  console.log('[completeOnboarding] About to upsert profile data')
  
  // Use admin client to bypass RLS
  const adminClient = createAdminClient()
  
  const { error } = await adminClient.from('profiles').upsert({
    id: user.id,
    email: user.email,
    email_verified: true,  // User received invite via email, so email is verified
    email_verified_at: new Date().toISOString(),
    full_name: formData.get('full_name') as string || null,
    title: formData.get('title') as string || null,
    company: formData.get('company') as string || null,
    location: formData.get('location') as string || null,
    bio: formData.get('bio') as string || null,
    expertise,
    intro_preferences: introPref,
    linkedin_url: formData.get('linkedin_url') as string || null,
    twitter_url: formData.get('twitter_url') as string || null,
    website_url: formData.get('website_url') as string || null,
    seniority: formData.get('seniority') as string || null,
    role_type: formData.get('role_type') as string || null,
    mentorship_role: mentorshipRole,
    open_to_mentorship: openToMentorship,
    updated_at: new Date().toISOString(),
  })

  if (error) return { error: error.message }
  revalidatePath('/dashboard/profile')
  return { success: true }
}

export async function requestIntroduction(targetId: string) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  const { error } = await supabase.from('intro_requests').insert({
    requester_id: user.id,
    target_user_id: targetId,
  })

  if (error) return { error: error.message }
  revalidatePath('/dashboard/introductions')
  return { success: true }
}

export async function submitIntroRequest(targetUserId: string, note?: string) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: target } = await supabase
    .from('profiles')
    .select('account_status')
    .eq('id', targetUserId)
    .maybeSingle()

  if (!target || target.account_status !== 'active') {
    return { error: 'This member is no longer active' }
  }

  const result = await createIntroRequest(user.id, user.email ?? '', targetUserId, note)
  if (result.error) return { error: result.error, code: (result as any).code }
  revalidatePath('/dashboard/introductions')
  return { success: true, introRequestId: result.introRequestId }
}

export async function adminApproveIntro(requestId: string) {
  const { user } = await getSupabaseAndUser()
  if (!user || user.email !== 'bizdev91@gmail.com') return { error: 'Not authorized' }
  const result = await approveIntroRequest(requestId)
  if (result.error) return { error: result.error }
  revalidatePath('/dashboard/admin')
  return { success: true, status: (result as any).status ?? 'approved' }
}

export async function adminRejectIntro(requestId: string) {
  const { user } = await getSupabaseAndUser()
  if (!user || user.email !== 'bizdev91@gmail.com') return { error: 'Not authorized' }
  const result = await rejectIntroRequest(requestId)
  if (result.error) return { error: result.error }
  revalidatePath('/dashboard/admin')
  return { success: true }
}



export async function completeOnboarding(formData: FormData) {
  console.log('[completeOnboarding] START - function called')
  const { supabase, user } = await getSupabaseAndUser()
  console.log('[completeOnboarding] User:', user?.email)
  if (!user) return { error: 'Not authenticated' }

  const introPref = (formData.get('intro_preferences') as string || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  const purposes = (formData.get('purposes') as string || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  // Parse expertise - handle both JSON array and comma-separated string
  const expertiseRaw = formData.get('expertise') as string || ''
  let expertise: string[] = []
  if (expertiseRaw) {
    try {
      expertise = JSON.parse(expertiseRaw)
    } catch {
      expertise = expertiseRaw.split(',').map(s => s.trim()).filter(Boolean)
    }
  }

  const city = (formData.get('city') as string || '').trim()
  const state = (formData.get('state') as string || '').trim()
  const location = city && state ? `${city}, ${state}` : city || state || null

  console.log('[completeOnboarding] About to upsert profile data')

  // Use admin client to bypass RLS
  const adminClient = createAdminClient()

  // Asymmetric founding flag: only stamp profiles.is_founding_member=true when
  // the invite was sent with markAsFounding. If false/undefined we omit the
  // field from the upsert so an existing true value is preserved on re-onboard.
  const markAsFounding = (user as any).user_metadata?.markAsFounding === true
  const foundingFields = markAsFounding
    ? { is_founding_member: true, founding_member_expires_at: null as string | null }
    : {}

  const { error } = await adminClient.from('profiles').upsert({
    id: user.id,
    email: user.email,
    email_verified: true,  // User received invite via email, so email is verified
    email_verified_at: new Date().toISOString(),
    full_name: (formData.get('full_name') as string) || null,
    title: (formData.get('title') as string) || null,
    company: (formData.get('company') as string) || null,
    city: city || null,
    state: state || null,
    location: location,
    role_type: (formData.get('role_type') as string) || null,
    seniority: (formData.get('seniority') as string) || null,
    expertise: expertise,
    bio: (formData.get('bio') as string) || null,
    avatar_url: (formData.get('avatar_url') as string) || null,
    looking_for: (formData.get('looking_for') as string) || null,
    intro_preferences: introPref,
    purposes: purposes,
    meeting_format_preference: (formData.get('meeting_format_preference') as string) || 'both',
    geographic_scope: (formData.get('geographic_scope') as string) || 'us-wide',
    profile_complete: true,
    updated_at: new Date().toISOString(),
    ...foundingFields,
  }, { onConflict: 'email' })

  if (error) {
    console.error('[completeOnboarding] error:', error.message)
    return { error: error.message }
  }

  // Generate initial recommendations for new user
  try {
    const result = await generateOnboardingRecommendations(user.id)
    console.log('[completeOnboarding] Generated recommendations:', result.count)
  } catch (err) {
    console.error('[completeOnboarding] Error generating recommendations:', err)
  }

  // Assign initial credits — tier-aware. Read the just-upserted profile to
  // determine effective tier (honors any pre-existing founding flag, plus the
  // one we may have just set above).
  try {
    const { data: profileForTier } = await adminClient
      .from('profiles')
      .select('subscription_tier, is_founding_member, founding_member_expires_at')
      .eq('id', user.id)
      .single()

    const effectiveTier = getEffectiveTier(profileForTier || {})
    const creditFloor = getMonthlyCredits(effectiveTier)

    const { data: existingCredits } = await adminClient
      .from('meeting_credits')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!existingCredits) {
      const { error: creditsError } = await adminClient
        .from('meeting_credits')
        .insert({
          user_id: user.id,
          free_credits: creditFloor,
          premium_credits: 0,
          balance: creditFloor,
          lifetime_earned: creditFloor,
        })
      if (creditsError) {
        console.error('[completeOnboarding] Error assigning credits:', creditsError)
      } else {
        await adminClient.from('credit_transactions').insert({
          user_id: user.id,
          amount: creditFloor,
          type: 'credit',
          note: markAsFounding ? 'founding_signup_bonus' : 'signup_bonus',
        })
        console.log('[completeOnboarding] Assigned credits to new user', { tier: effectiveTier, amount: creditFloor })
      }
    } else {
      console.log('[completeOnboarding] Credits already present, skipping assignment')
    }
  } catch (err) {
    console.error('[completeOnboarding] Error in credits assignment:', err)
  }

  // Fire admin welcome introduction (idempotent, non-blocking on failure)
  try {
    const welcome = await sendAdminWelcome(user.id)
    if (welcome.created) {
      console.log('[completeOnboarding] Admin welcome sent:', welcome.conversationId)
    } else {
      console.log('[completeOnboarding] Admin welcome skipped:', welcome.reason)
    }
  } catch (err) {
    console.error('[completeOnboarding] Admin welcome error (non-blocking):', err)
  }

  revalidatePath('/dashboard')
  return { success: true }
}

export async function saveAvatarUrl(avatarUrl: string) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  const { error } = await supabase
    .from('profiles')
    .update({ avatar_url: avatarUrl })
    .eq('id', user.id)

  if (error) {
    console.error('[saveAvatarUrl] error:', error.message)
    return { error: error.message }
  }

  revalidatePath('/dashboard/profile')

  
  revalidatePath('/dashboard')
  return { success: true }
}

export async function updateIntroStatus(id: string, status: 'accepted' | 'declined') {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  if (status === 'declined') {
    const { error } = await supabase
      .from('intro_requests')
      .update({ status: 'declined', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('target_user_id', user.id)
    if (error) return { error: error.message }
    revalidatePath('/dashboard/introductions')
    return { success: true, status: 'declined' }
  }

  // Accepting — fetch the request to find the requester
  const { data: intro, error: fetchErr } = await supabase
    .from('intro_requests')
    .select('id, requester_id, target_user_id, is_admin_initiated')
    .eq('id', id)
    .eq('target_user_id', user.id)
    .single()

  if (fetchErr || !intro) return { error: 'Introduction not found.' }

  // Charge both users + create match + create conversation atomically via the
  // RPC. Same path as express-interest mutual completion (commit 663265f).
  // p_user_a = accepter (current user); p_user_b = requester.
  const adminClient = createAdminClient()
  const { data: rpcRows, error: rpcError } = await adminClient.rpc(
    'consume_credits_and_create_match',
    {
      p_user_a: user.id,
      p_user_b: intro.requester_id,
      p_admin_facilitated: Boolean(intro.is_admin_initiated),
    }
  )

  if (rpcError) {
    console.error('[updateIntroStatus] RPC error:', rpcError)
    return { error: 'Could not complete connection. Please try again.' }
  }

  const rpcResult = rpcRows?.[0]
  if (!rpcResult) {
    return { error: 'Could not complete connection. Please try again.' }
  }

  if (rpcResult.error_code === 'insufficient_credits_a') {
    return { error: 'You need 1 free credit to connect.' }
  }

  if (rpcResult.error_code === 'insufficient_credits_b') {
    return { error: "Connection can't complete right now. We'll let you know when it can." }
  }

  // duplicate_match falls through — match already exists from a prior flow.
  // RPC rolled back its own no-op deducts. Mark the intro accepted anyway —
  // the user-visible outcome is they're connected.

  // Mark intro_request as accepted
  const { error: updateErr } = await supabase
    .from('intro_requests')
    .update({
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      credit_charged: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)

  if (updateErr) return { error: updateErr.message }

  revalidatePath('/dashboard/introductions')
  revalidatePath('/dashboard/messages')
  return { success: true, status: 'accepted' }
}

export async function adminAdjustCredits(userId: string, delta: number, reason: string) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user || user.email !== 'bizdev91@gmail.com') return { error: 'Not authorized' }

  const { data: current } = await supabase
    .from('meeting_credits')
    .select('balance')
    .eq('user_id', userId)
    .single()

  const newBalance = Math.max(0, (current?.balance ?? 0) + delta)

  const { error: updateErr } = await supabase
    .from('meeting_credits')
    .upsert({ user_id: userId, balance: newBalance }, { onConflict: 'user_id' })

  if (updateErr) return { error: updateErr.message }

  await supabase.from('credit_transactions').insert({
    user_id: userId,
    amount: delta,
    description: reason || `Manual admin adjustment (${delta > 0 ? '+' : ''}${delta})`,
  })

  revalidatePath('/dashboard/admin')
  return { success: true, newBalance }
}

export async function adminGenerateBatch() {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user || user.email !== 'bizdev91@gmail.com') return { error: 'Not authorized' }

  // Deactivate any existing active batches
  await supabase
    .from('introduction_batches')
    .update({ status: 'closed' })
    .eq('status', 'active')

  // Get the highest batch number
  const { data: lastBatch } = await supabase
    .from('introduction_batches')
    .select('batch_number')
    .order('batch_number', { ascending: false })
    .limit(1)
    .single()

  const nextNumber = (lastBatch?.batch_number ?? 0) + 1

  // Create the new batch
  const { data: batch, error: batchErr } = await supabase
    .from('introduction_batches')
    .insert({ batch_number: nextNumber, status: 'active' })
    .select('id')
    .single()

  if (batchErr || !batch) return { error: batchErr?.message ?? 'Failed to create batch' }

  // Load all profiles with role_type
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, role_type, seniority')
    .not('full_name', 'is', null)

  if (!profiles || profiles.length < 2) return { error: 'Not enough profiles to match' }

  // Complementary role mapping
  const COMPLEMENTARY: Record<string, string[]> = {
    investor_vc:            ['executive_csuite', 'legal_tech_startup', 'finance_professional'],
    executive_csuite:       ['investor_vc', 'strategy_consulting', 'government_policy'],
    in_house_counsel:       ['legal_operations', 'compliance_risk', 'law_firm_attorney'],
    law_firm_attorney:      ['in_house_counsel', 'legal_operations', 'executive_csuite', 'investor_vc', 'finance_professional'],
    legal_operations:       ['in_house_counsel', 'legal_tech_startup', 'strategy_consulting'],
    finance_professional:   ['investor_vc', 'executive_csuite', 'strategy_consulting'],
    healthcare_professional:['government_policy', 'executive_csuite', 'investor_vc'],
    government_policy:      ['government_affairs', 'regulatory_affairs', 'executive_csuite'],
    government_affairs:     ['government_policy', 'regulatory_affairs', 'law_firm_attorney'],
    regulatory_affairs:     ['government_affairs', 'compliance_risk', 'in_house_counsel'],
    compliance_risk:        ['regulatory_affairs', 'in_house_counsel', 'privacy_data'],
    privacy_data:           ['compliance_risk', 'legal_tech_startup', 'in_house_counsel'],
    legal_tech_startup:     ['investor_vc', 'legal_operations', 'in_house_counsel'],
    strategy_consulting:    ['executive_csuite', 'finance_professional', 'legal_operations'],
    other:                  [],
  }

  // STEP 1: Generate mutual pairs (not individual suggestions)
  interface Pair {
    userA: string
    userB: string
    reasonA: string // why userA should meet userB
    reasonB: string // why userB should meet userA
    score: number   // higher = better match
  }

  const pairs: Pair[] = []
  const userSuggestionCount: Record<string, number> = {}

  // Generate all possible pairs with scores
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      const userA = profiles[i]
      const userB = profiles[j]

      const aPreferred = COMPLEMENTARY[userA.role_type ?? ''] ?? []
      const bPreferred = COMPLEMENTARY[userB.role_type ?? ''] ?? []

      const aLikesB = aPreferred.includes(userB.role_type ?? '')
      const bLikesA = bPreferred.includes(userA.role_type ?? '')

      // Score: 2 points if mutual complementary, 1 point if one-way, 0 if neither
      const score = (aLikesB ? 1 : 0) + (bLikesA ? 1 : 0)

      const reasonA = aLikesB
        ? `${userB.role_type?.replace(/_/g, ' ')} professionals often find strong alignment with your background.`
        : `Expanding your network across disciplines can open unexpected doors.`

      const reasonB = bLikesA
        ? `${userA.role_type?.replace(/_/g, ' ')} professionals often find strong alignment with your background.`
        : `Expanding your network across disciplines can open unexpected doors.`

      pairs.push({ userA: userA.id, userB: userB.id, reasonA, reasonB, score })
    }
  }

  // STEP 2: Sort pairs by score (best matches first)
  pairs.sort((a, b) => b.score - a.score)

  // STEP 3: Greedily select pairs (users limited to 3 suggestions each)
  const suggestions: { batch_id: string; recipient_id: string; suggested_id: string; reason: string }[] = []

  for (const pair of pairs) {
    const countA = userSuggestionCount[pair.userA] ?? 0
    const countB = userSuggestionCount[pair.userB] ?? 0

    // Skip if either user already has 3 suggestions
    if (countA >= 3 || countB >= 3) continue

    // Add BOTH directions atomically
    suggestions.push({
      batch_id: batch.id,
      recipient_id: pair.userA,
      suggested_id: pair.userB,
      reason: pair.reasonA,
    })
    suggestions.push({
      batch_id: batch.id,
      recipient_id: pair.userB,
      suggested_id: pair.userA,
      reason: pair.reasonB,
    })

    userSuggestionCount[pair.userA] = countA + 1
    userSuggestionCount[pair.userB] = countB + 1
  }

  if (suggestions.length > 0) {
    const adminClient = createAdminClient()
    await adminClient.from('batch_suggestions').insert(suggestions)
  }

  revalidatePath('/dashboard/introductions')
  revalidatePath('/dashboard/admin')
  return { success: true, batchNumber: nextNumber, suggestionCount: suggestions.length }
}

export async function sendMessage(conversationId: string, content: string) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  console.log('[sendMessage] conversationId:', conversationId, 'sender_id:', user.id)

  // Insert the message
  const { error } = await supabase.from('messages').insert({
    conversation_id: conversationId,
    sender_id: user.id,
    content,
  })

  console.log('[sendMessage] insert error:', JSON.stringify(error))

  if (error) return { error: error.message }

  // Get sender's name
  const { data: senderProfile } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', user.id)
    .single()

  // Get conversation to find the match
  const { data: conversation } = await supabase
    .from('conversations')
    .select('match_id')
    .eq('id', conversationId)
    .single()

  if (conversation?.match_id) {
    // Get the match to find the other user
    const { data: match } = await supabase
      .from('matches')
      .select('user_a_id, user_b_id')
      .eq('id', conversation.match_id)
      .single()

    if (match) {
      // Determine recipient (the user who is NOT the sender)
      const recipientId = match.user_a_id === user.id ? match.user_b_id : match.user_a_id

      // Get recipient's profile
      const { data: recipientProfile } = await supabase
        .from('profiles')
        .select('full_name, email')
        .eq('id', recipientId)
        .single()

      // Send email notification
      if (recipientProfile?.email && senderProfile?.full_name) {
        try {
          await sendNewMessageEmail(
            recipientProfile.email,
            recipientProfile.full_name || 'there',
            senderProfile.full_name,
            content
          )
          console.log('[sendMessage] email sent to:', recipientProfile.email)
        } catch (emailError) {
          console.error('[sendMessage] failed to send email:', emailError)
          // Don't fail the message send if email fails
        }
      }
    }
  }

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

export async function submitWaitlist(data: {
  fullName: string
  email: string
  title: string
  company: string
  roleType: string
  linkedinUrl?: string
  meetingInterests?: string
  referral: string
}) {
  const supabase = createClient()
  
  const hasLinkedIn = data.linkedinUrl && data.linkedinUrl.trim().length > 0
  const verification_status = 'pending_review'
  const verification_method = hasLinkedIn ? 'linkedin' : 'none'
  
  const { error } = await supabase.from('waitlist').insert({
    full_name: data.fullName,
    email: data.email,
    title: data.title || null,
    company: data.company || null,
    role_type: data.roleType || null,
    linkedin_url: data.linkedinUrl || null,
    meeting_interests: data.meetingInterests || null,
    referral_source: data.referral || null,
    status: 'pending',
    verification_status: verification_status,
    verification_method: verification_method,
  })
  if (error) {
    if (error.code === '23505') return { error: 'This email is already on the waitlist.' }
    return { error: error.message }
  }
  const alertResult = await sendAdminAlertEmail(
    `New waitlist signup: ${escapeHtml(data.fullName)}`,
    `
      <h2 style="color: #1B2850; margin-bottom: 24px;">New waitlist signup</h2>
      <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;"><strong>Name:</strong> ${escapeHtml(data.fullName)}</p>
      <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;"><strong>Email:</strong> ${escapeHtml(data.email)}</p>
      <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;"><strong>Title:</strong> ${escapeHtml(data.title)}</p>
      <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;"><strong>Company:</strong> ${escapeHtml(data.company)}</p>
      <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;"><strong>LinkedIn:</strong> ${escapeHtml(data.linkedinUrl)}</p>
      <p style="color: #334155; font-size: 16px; line-height: 1.6; margin-bottom: 16px;"><strong>Referral:</strong> ${escapeHtml(data.referral)}</p>
    `
  )
  if (!alertResult.success) {
    console.error('[submitWaitlist] admin alert failed:', alertResult.error)
  }
  // SA2 mitigation: disabled public-facing waitlist confirmation email for V1.
  // The submitter's email is not verified at submit time, so sending confirmation
  // mail to a caller-controlled address is an outbound-spam / sender-reputation
  // attack vector. Re-enable when verified-email or rate-limiting exists.
  // See product doc §15 / §19 item 10.
  // const confirmResult = await sendWaitlistConfirmationEmail(data.email, data.fullName)
  // if (!confirmResult.success) {
  //   console.error('[waitlist-confirmation] email failed:', confirmResult.error)
  // }
  return { success: true }
}
// NOTE: this server action is currently NOT wired to the AdminWaitlistClient UI;
// the live invite flow is POST /api/admin/send-invite. Kept here with the same
// tier-aware credit logic so a re-enable doesn't regress to the hardcoded 3.
export async function adminSendWaitlistInvite(id: string, markAsFounding = false) {
  try {
    console.log('[invite] function called, id:', id)
    const { supabase, user } = await getSupabaseAndUser()
    console.log('[invite] auth check — user email:', user?.email ?? 'null')
    if (!user || user.email !== 'bizdev91@gmail.com') {
      console.error('[invite] not authorized — user:', user?.email ?? 'null')
      return { error: 'Not authorized' }
    }

    console.log('[invite] fetching waitlist entry:', id)

    const { data: entry, error: entryError } = await supabase
      .from('waitlist')
      .select('full_name, email, status')
      .eq('id', id)
      .single()

    if (entryError) {
      console.error('[invite] failed to fetch entry:', entryError.message)
      return { error: 'Entry not found' }
    }
    if (!entry) return { error: 'Entry not found' }

    console.log('[invite] function called for:', entry.email)

    // Generate a random temporary password and create (or update) the user account directly.
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const tempPassword = 'Andrel-' + Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('')

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
    console.log('[invite] SUPABASE_SERVICE_ROLE_KEY set:', !!serviceKey, '| prefix:', serviceKey.slice(0, 12))

    try {
      const adminClient = createAdminClient()

      const { data: createdUser, error: createError } = await adminClient.auth.admin.createUser({
        email: entry.email,
        password: tempPassword,
        email_confirm: true,
      })

      if (createError) {
        const alreadyExists =
          createError.message.toLowerCase().includes('already been registered') ||
          createError.message.toLowerCase().includes('already exists')

        if (alreadyExists) {
          // User exists — find their auth UUID via profiles table and reset their password
          console.log('[invite] user already exists, resetting password...')
          const { data: profileRow } = await supabase
            .from('profiles')
            .select('id')
            .eq('email', entry.email)
            .single()

          if (!profileRow?.id) {
            console.error('[invite] could not find existing user in profiles by email')
            return { error: 'User already exists but could not be found — contact support' }
          }

          const { error: updateError } = await adminClient.auth.admin.updateUserById(
            profileRow.id,
            { password: tempPassword }
          )
          if (updateError) {
            console.error('[invite] updateUserById error:', updateError.message)
            return { error: `Could not reset user password: ${updateError.message}` }
          }
          console.log('[invite] password reset for existing user:', entry.email)
        } else {
          console.error('[invite] createUser FULL error:', JSON.stringify(createError, null, 2))
          return { error: `Could not create user account: ${createError.message}` }
        }
      } else {
        console.log('[invite] new user created:', entry.email)

        const newUserId = createdUser?.user?.id

        // Tier-aware: if invited as founding, stamp the flag + seed founding floor.
        const profileSeed: Record<string, unknown> = {
          id: newUserId,
          password_reset_required: true,
          email: entry.email,
          full_name: entry.full_name,
          email_verified: true,
          email_verified_at: new Date().toISOString(),
          verification_status: 'pending',
          trust_score: 50,
        }
        if (markAsFounding) {
          profileSeed.is_founding_member = true
          profileSeed.founding_member_expires_at = null
        }
        await adminClient.from('profiles').insert(profileSeed)
        console.log('[invite] created profile for:', entry.email, { markAsFounding })

        if (newUserId) {
          const tier = markAsFounding ? 'founding' : 'free'
          const creditFloor = getMonthlyCredits(tier)
          await adminClient.from('meeting_credits').upsert({
            user_id: newUserId,
            free_credits: creditFloor,
            premium_credits: 0,
            balance: creditFloor,
            lifetime_earned: creditFloor,
          })
          await adminClient.from('credit_transactions').insert({
            user_id: newUserId,
            amount: creditFloor,
            type: 'credit',
            note: markAsFounding ? 'founding_signup_bonus' : 'signup_bonus',
          })
          console.log('[invite] seeded credits for:', entry.email, { tier, amount: creditFloor })
        }
      }
    } catch (err: any) {
      console.error('[invite] admin operation threw:', err.message)
      return { error: `Could not set up user account: ${err.message}` }
    }

    console.log('[invite] about to send invite email to:', entry.email)
    const { sendInviteEmail } = await import('@/lib/email')
    const result = await sendInviteEmail(entry.email, entry.full_name ?? 'there', tempPassword)
    console.log('[invite] Resend done — success:', result.success, 'error:', result.error ?? 'none')

    if (!result.success) return { error: result.error ?? 'Failed to send email' }

    // Mark as approved + invited
    await supabase
      .from('waitlist')
      .update({ status: 'invited', approved_at: new Date().toISOString() })
      .eq('id', id)

    revalidatePath('/dashboard/admin')
    return { success: true }
  } catch (error: any) {
    console.error('[invite] FAILED with unexpected error:', error?.message ?? error)
    return { error: `Unexpected error: ${error?.message ?? 'unknown'}` }
  }
}

export async function adminApproveWaitlist(id: string) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user || user.email !== 'bizdev91@gmail.com') return { error: 'Not authorized' }
  const { error } = await supabase
    .from('waitlist')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', id)
  if (error) return { error: error.message }
  revalidatePath('/dashboard/admin')
  return { success: true }
}

export async function adminDeclineWaitlist(id: string) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user || user.email !== 'bizdev91@gmail.com') return { error: 'Not authorized' }
  const { error } = await supabase
    .from('waitlist')
    .update({ status: 'declined' })
    .eq('id', id)
  if (error) return { error: error.message }
  revalidatePath('/dashboard/admin')
  return { success: true }
}

export async function scheduleMeeting(formData: FormData) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  const date = formData.get('date') as string
  const time = formData.get('time') as string
  const timezoneOffset = parseInt(formData.get('timezone_offset') as string || '0')
  // Parse time in user's timezone and convert to UTC
  let scheduled_at: string | null = null
  if (date && time) {
    const [year, month, day] = date.split('-').map(Number)
    const [hours, minutes] = time.split(':').map(Number)
    const localDate = new Date(Date.UTC(year, month - 1, day, hours, minutes))
    // Subtract the timezone offset to get UTC
    scheduled_at = new Date(localDate.getTime() + timezoneOffset * 60000).toISOString()
  }

  const recipientId = (formData.get('recipient_id') as string || '').trim()
  if (!recipientId) return { error: 'Please select who you are meeting with.' }
  if (!scheduled_at) return { error: 'Please provide a valid date and time.' }

  // DEBUG: Log what we're receiving
  console.log('[scheduleMeeting] format from formData:', formData.get('format'))
  console.log('[scheduleMeeting] location from formData:', formData.get('location'))
  console.log('[scheduleMeeting] purpose from formData:', formData.get('purpose'))
  console.log('[scheduleMeeting] title from formData:', formData.get('title'))

  const { error } = await supabase.from('meetings').insert({
    requester_id: user.id,
    recipient_id: recipientId,
    purpose: (formData.get('title') as string || '').trim() || (formData.get('purpose') as string),
    purpose_category: (formData.get('purpose') as string) || null,
    format: formData.get('format') as string || 'virtual',
    status: 'requested',
    scheduled_at,
    duration_minutes: parseInt(formData.get('duration_minutes') as string || '30'),
    location: (formData.get('location') as string) || null,
    notes: (formData.get('notes') as string) || null,
    zoom_link: (formData.get('zoom_link') as string) || null,
  })

  if (error) return { error: error.message }
  
  // Create notification for recipient
  const { data: requesterProfile } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', user.id)
    .single()
  
  const requesterName = requesterProfile?.full_name || user.email
  
  const adminClient = createAdminClient()
  const notifInsert = await adminClient.from('notifications').insert({
    user_id: recipientId,
    type: 'meeting_request',
    title: 'New meeting request',
    body: `${requesterName} wants to meet with you`,
    link: '/dashboard/meetings',
    created_at: new Date().toISOString()
  })
  
  console.log('[scheduleMeeting] Notification insert result:', JSON.stringify(notifInsert))
  
  if (notifInsert.error) {
    console.error('[scheduleMeeting] Notification error:', notifInsert.error)
    return { error: `Meeting created but notification failed: ${notifInsert.error.message}` }
  }

  // Send email notification
  const { data: recipientProfile } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', recipientId)
    .single()

  console.log('[scheduleMeeting] Recipient profile:', recipientProfile)
  if (recipientProfile?.email) {
    const meetingDate = new Date(scheduled_at).toLocaleDateString('en-US', { 
      weekday: 'long', 
      month: 'long', 
      day: 'numeric' 
    })
    const meetingTime = new Date(scheduled_at).toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      timeZoneName: 'short'
    })
    
    try {
      await sendMeetingRequestEmail(
        recipientProfile.email,
        recipientProfile.full_name || 'there',
        requesterName,
        meetingDate,
        meetingTime,
        (formData.get('title') as string || '').trim() || (formData.get('purpose') as string) || undefined
      )
      console.log('[scheduleMeeting] Email sent successfully to:', recipientProfile.email)
    } catch (emailError) {
      console.error('[scheduleMeeting] Email error:', emailError)
    }
  }
  
  revalidatePath('/dashboard/meetings')
  return { success: true }
}

export async function passOnSuggestion(rowId: string, permanent: boolean) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  await supabase
    .from('batch_suggestions')
    .update({ status: permanent ? 'hidden_permanent' : 'passed' })
    .eq('id', rowId)
    .eq('recipient_id', user.id)

  return { success: true }
}

export async function acceptMeeting(meetingId: string) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  // Get meeting to check if there are proposed changes
  const { data: meeting } = await supabase
    .from('meetings')
    .select('requester_id, recipient_id, proposed_scheduled_at, proposed_duration_minutes, proposed_format, proposed_location, proposed_zoom_link, proposed_notes')
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found' }

  // Build update object
  const updates: any = { status: 'confirmed' }
  
  // If there are proposed changes, apply them
  if (meeting.proposed_scheduled_at) {
    updates.scheduled_at = meeting.proposed_scheduled_at
    if (meeting.proposed_duration_minutes !== null) updates.duration_minutes = meeting.proposed_duration_minutes
    if (meeting.proposed_format !== null) updates.format = meeting.proposed_format
    if (meeting.proposed_location !== null) updates.location = meeting.proposed_location
    if (meeting.proposed_zoom_link !== null) updates.zoom_link = meeting.proposed_zoom_link
    if (meeting.proposed_notes !== null) updates.notes = meeting.proposed_notes
    
    // Clear proposed fields
    updates.proposed_scheduled_at = null
    updates.proposed_duration_minutes = null
    updates.proposed_format = null
    updates.proposed_location = null
    updates.proposed_zoom_link = null
    updates.proposed_notes = null
  }

  const { error } = await supabase
    .from('meetings')
    .update(updates)
    .eq('id', meetingId)

  if (error) return { error: error.message }
  
  // Send notification and email
  if (meeting) {
    const otherUserId = meeting.requester_id === user.id ? meeting.recipient_id : meeting.requester_id
    const adminClient = createAdminClient()
    await adminClient.from('notifications').insert({
      user_id: otherUserId,
      type: 'meeting_accepted',
      title: 'Meeting confirmed',
      body: 'Your meeting request was accepted',
      link: '/dashboard/meetings',
      created_at: new Date().toISOString()
    })

    // Send email
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('id', [user.id, otherUserId])

    const accepterProfile = profiles?.find(p => p.id === user.id)
    const otherProfile = profiles?.find(p => p.id === otherUserId)

    if (otherProfile?.email && accepterProfile) {
      const { data: updatedMeeting } = await supabase
        .from('meetings')
        .select('scheduled_at')
        .eq('id', meetingId)
        .single()

      if (updatedMeeting) {
        const meetingDate = new Date(updatedMeeting.scheduled_at).toLocaleDateString('en-US', { 
          weekday: 'long', 
          month: 'long', 
          day: 'numeric' 
        })
        const meetingTime = new Date(updatedMeeting.scheduled_at).toLocaleTimeString('en-US', { 
          hour: 'numeric', 
          minute: '2-digit',
          timeZoneName: 'short'
        })

        try {
          await sendMeetingAcceptedEmail(
            otherProfile.email,
            otherProfile.full_name || 'there',
            accepterProfile.full_name || user.email || 'Someone',
            meetingDate,
            meetingTime
          )
        } catch (emailError) {
          console.error('[acceptMeeting] Email error:', emailError)
        }
      }
    }
  }
  
  revalidatePath('/dashboard/meetings')
  return { success: true }
}

export async function declineMeeting(meetingId: string) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  // Get meeting to check if declining a reschedule or initial request
  const { data: meeting } = await supabase
    .from('meetings')
    .select('requester_id, recipient_id, status, proposed_scheduled_at')
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found' }

  // If there's a proposed reschedule, decline it but keep meeting confirmed
  const isRescheduleDecline = meeting.proposed_scheduled_at !== null
  const newStatus = isRescheduleDecline ? 'reschedule_declined' : 'declined'
  
  const updates: any = { status: newStatus }
  
  // If declining a reschedule, clear proposed fields
  if (isRescheduleDecline) {
    updates.proposed_scheduled_at = null
    updates.proposed_duration_minutes = null
    updates.proposed_format = null
    updates.proposed_location = null
    updates.proposed_zoom_link = null
    updates.proposed_notes = null
  }

  const { error } = await supabase
    .from('meetings')
    .update(updates)
    .eq('id', meetingId)

  if (error) return { error: error.message }
  
  if (meeting) {
    const otherUserId = meeting.requester_id === user.id ? meeting.recipient_id : meeting.requester_id
    const adminClient = createAdminClient()
    await adminClient.from('notifications').insert({
      user_id: otherUserId,
      type: 'meeting_declined',
      title: 'Meeting declined',
      body: 'Your meeting request was declined',
      link: '/dashboard/meetings',
      created_at: new Date().toISOString()
    })

    // Send email
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, email')
      .in('id', [user.id, otherUserId])

    const declinerProfile = profiles?.find(p => p.id === user.id)
    const otherProfile = profiles?.find(p => p.id === otherUserId)

    if (otherProfile?.email && declinerProfile) {
      try {
        await sendMeetingDeclinedEmail(
          otherProfile.email,
          otherProfile.full_name || 'there',
          declinerProfile.full_name || user.email || 'Someone'
        )
      } catch (emailError) {
        console.error('[declineMeeting] Email error:', emailError)
      }
    }
  }
  
  revalidatePath('/dashboard/meetings')
  return { success: true }
}

export async function deleteMeeting(meetingId: string) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  // First check if user is either requester or recipient
  const { data: meeting } = await supabase
    .from('meetings')
    .select('requester_id, recipient_id')
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found' }
  if (meeting.requester_id !== user.id && meeting.recipient_id !== user.id) {
    return { error: 'Not authorized to delete this meeting' }
  }

  const { error } = await supabase
    .from('meetings')
    .delete()
    .eq('id', meetingId)

  if (error) return { error: error.message }
  revalidatePath('/dashboard/meetings')
  return { success: true }
}

export async function rescheduleMeeting(meetingId: string, formData: FormData) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  // Check authorization
  const { data: meeting } = await supabase
    .from('meetings')
    .select('requester_id, recipient_id')
    .eq('id', meetingId)
    .single()

  if (!meeting) return { error: 'Meeting not found' }
  if (meeting.requester_id !== user.id && meeting.recipient_id !== user.id) {
    return { error: 'Not authorized' }
  }

  const date = formData.get('date') as string
  const time = formData.get('time') as string
  const timezoneOffset = parseInt(formData.get('timezone_offset') as string || '0')
  // Parse time in user's timezone and convert to UTC
  let scheduled_at: string | null = null
  if (date && time) {
    const [year, month, day] = date.split('-').map(Number)
    const [hours, minutes] = time.split(':').map(Number)
    const localDate = new Date(Date.UTC(year, month - 1, day, hours, minutes))
    // Subtract the timezone offset to get UTC
    scheduled_at = new Date(localDate.getTime() + timezoneOffset * 60000).toISOString()
  }

  if (!scheduled_at) return { error: 'Please provide a valid date and time.' }

  const { error } = await supabase
    .from('meetings')
    .update({
      proposed_scheduled_at: scheduled_at,
      proposed_duration_minutes: parseInt(formData.get('duration_minutes') as string || '30'),
      proposed_format: formData.get('format') as string || 'virtual',
      proposed_location: (formData.get('location') as string) || null,
      proposed_zoom_link: (formData.get('zoom_link') as string) || null,
      proposed_notes: (formData.get('notes') as string) || null,
      status: 'reschedule_requested',
    })
    .eq('id', meetingId)

  if (error) return { error: error.message }

  // Notify the other party
  const otherUserId = meeting.requester_id === user.id ? meeting.recipient_id : meeting.requester_id
  const adminClient = createAdminClient()
  await adminClient.from('notifications').insert({
    user_id: otherUserId,
    type: 'meeting_request',
    title: 'Meeting rescheduled',
    body: `A meeting has been rescheduled`,
    link: '/dashboard/meetings',
    created_at: new Date().toISOString()
  })

  // Send email
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, full_name, email')
    .in('id', [user.id, otherUserId])

  const reschedulerProfile = profiles?.find(p => p.id === user.id)
  const otherProfile = profiles?.find(p => p.id === otherUserId)

  if (otherProfile?.email && reschedulerProfile && scheduled_at) {
    const newDate = new Date(scheduled_at).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric'
    })
    const newTime = new Date(scheduled_at).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    })
    try {
      await sendMeetingRescheduledEmail(
        otherProfile.email,
        otherProfile.full_name || 'there',
        reschedulerProfile.full_name || user.email || 'Someone',
        newDate,
        newTime,
        (formData.get('notes') as string) || undefined
      )
    } catch (emailError) {
      console.error('[rescheduleMeeting] Email error:', emailError)
    }
  }

  revalidatePath('/dashboard/meetings')
  return { success: true }
}

// ── ADMIN: Force Match ─────────────────────────────────────────────────────
export async function adminForceMatch(userAId: string, userBId: string, skipCredits: boolean = true) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user || user.email !== 'bizdev91@gmail.com') return { error: 'Not authorized' }

  // Check if match already exists
  const { data: existing } = await supabase
    .from('matches')
    .select('id')
    .or(buildBidirectionalMatchFilter(userAId, userBId))
    .single()

  if (existing) return { error: 'Match already exists' }

  // Create match
  const { data: match, error: matchError } = await supabase
    .from('matches')
    .insert({
      user_a_id: userAId,
      user_b_id: userBId,
      status: 'active',
      admin_facilitated: true,
      admin_notes: 'Admin force match'
    })
    .select()
    .single()

  if (matchError) return { error: matchError.message }

  // Create conversation
  await supabase.from('conversations').insert({
    match_id: match.id
  })

  // Get profiles for notifications
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, full_name, email, title, company')
    .in('id', [userAId, userBId])

  const profileA = profiles?.find(p => p.id === userAId)
  const profileB = profiles?.find(p => p.id === userBId)

  // Create notifications for both users
  if (profileA && profileB) {
    const adminClient = createAdminClient()
    await adminClient.from('notifications').insert([
      {
        user_id: userAId,
        type: 'new_connection',
        title: 'New Connection',
        body: `You're now connected with ${profileB.full_name}`,
        link: '/dashboard/network',
        created_at: new Date().toISOString()
      },
      {
        user_id: userBId,
        type: 'new_connection',
        title: 'New Connection',
        body: `You're now connected with ${profileA.full_name}`,
        link: '/dashboard/network',
        created_at: new Date().toISOString()
      }
    ])

    // Send emails
    if (profileA.email) {
      try {
        await sendMatchCreatedEmail(
          profileA.email,
          profileA.full_name || 'there',
          profileB.full_name || 'New Connection',
          profileB.title,
          profileB.company
        )
      } catch (e) {
        console.error('Email error:', e)
      }
    }

    if (profileB.email) {
      try {
        await sendMatchCreatedEmail(
          profileB.email,
          profileB.full_name || 'there',
          profileA.full_name || 'New Connection',
          profileA.title,
          profileA.company
        )
      } catch (e) {
        console.error('Email error:', e)
      }
    }
  }

  revalidatePath('/dashboard/admin')
  return { success: true, matchId: match.id }
}

// ── ADMIN: Quick User Edit ──────────────────────────────────────────────────
export async function adminUpdateUser(userId: string, updates: {
  tier?: string
  credits?: number
  verification_status?: string
  is_priority?: boolean
  boost_score?: number
  account_status?: string
  current_status?: string
  launch_cohort?: string | null
}) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user || user.email !== 'bizdev91@gmail.com') return { error: 'Not authorized' }

  const profileUpdates: any = {}
  if (updates.tier !== undefined) profileUpdates.subscription_tier = updates.tier
  if (updates.launch_cohort !== undefined) profileUpdates.launch_cohort = updates.launch_cohort
  if (updates.verification_status !== undefined) profileUpdates.verification_status = updates.verification_status
  if (updates.is_priority !== undefined) profileUpdates.is_priority = updates.is_priority
  if (updates.boost_score !== undefined) profileUpdates.boost_score = updates.boost_score
  if (updates.account_status !== undefined) profileUpdates.account_status = updates.account_status
  if (updates.current_status !== undefined) profileUpdates.current_status = updates.current_status

  if (Object.keys(profileUpdates).length > 0) {
    const { error } = await supabase
      .from('profiles')
      .update(profileUpdates)
      .eq('id', userId)

    if (error) return { error: error.message }
  }

  // Update credits if provided
  if (updates.credits !== undefined) {
    const { error } = await supabase
      .from('meeting_credits')
      .upsert({
        user_id: userId,
        balance: updates.credits
      }, { onConflict: 'user_id' })

    if (error) return { error: error.message }
  }

  revalidatePath('/dashboard/admin')
  return { success: true }
}

// Idempotent grant flow for Founding Member status. Email fires exactly once
// per user (the first time is_founding_member is true and the sent_at column
// is null). Removing the status preserves sent_at so the audit trail survives.
// Manual resend path: nullify profiles.founding_member_email_sent_at via
// Supabase Dashboard, then re-grant from the admin UI.
export async function adminSetFoundingMember(userId: string, isFoundingMember: boolean) {
  const { supabase, user } = await getSupabaseAndUser()
  if (!user || user.email !== 'bizdev91@gmail.com') return { error: 'Not authorized' }

  const { data: current, error: readError } = await supabase
    .from('profiles')
    .select('id, full_name, email, is_founding_member, founding_member_email_sent_at')
    .eq('id', userId)
    .maybeSingle()

  if (readError) return { error: readError.message }
  if (!current) return { error: 'Profile not found' }

  if (!isFoundingMember) {
    // Removal: drop the flag, preserve sent_at as audit trail.
    const { error } = await supabase
      .from('profiles')
      .update({ is_founding_member: false })
      .eq('id', userId)
    if (error) return { error: error.message }
    revalidatePath('/dashboard/admin')
    return { success: true, emailSent: false }
  }

  // Grant. Send the email only on the first grant (sent_at IS NULL).
  if (current.founding_member_email_sent_at) {
    const { error } = await supabase
      .from('profiles')
      .update({ is_founding_member: true })
      .eq('id', userId)
    if (error) return { error: error.message }
    revalidatePath('/dashboard/admin')
    return { success: true, emailSent: false }
  }

  let emailSent = false
  if (current.email) {
    const { sendFoundingMemberEmail } = await import('@/lib/email')
    const result = await sendFoundingMemberEmail(current.email, current.full_name || 'there')
    if (!result.success) {
      // Don't write the timestamp if the email failed — the next save will retry.
      console.error('[adminSetFoundingMember] email failed for', userId, result.error)
      return { error: `Email failed: ${result.error || 'unknown error'}` }
    }
    emailSent = true
  } else {
    // No email on file. Still grant the status; admin can manually resend later.
    console.warn('[adminSetFoundingMember] granting without email — no profile.email for', userId)
  }

  const { error } = await supabase
    .from('profiles')
    .update({
      is_founding_member: true,
      founding_member_email_sent_at: emailSent ? new Date().toISOString() : null,
    })
    .eq('id', userId)
  if (error) return { error: error.message }

  revalidatePath('/dashboard/admin')
  return { success: true, emailSent }
}

