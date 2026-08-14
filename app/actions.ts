'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeEmail, findAuthUserByEmail, registrationExistingState } from '@/lib/invitations'
import { parseMultiSelectField } from '@/lib/profile/multiSelect'
import { revalidatePath } from 'next/cache'
import { sendMeetingRequestEmail, sendMeetingAcceptedEmail, sendMeetingDeclinedEmail, sendMeetingRescheduledEmail, sendMatchCreatedEmail, sendAdminAlertEmail, sendWaitlistConfirmationEmail, escapeHtml } from '@/lib/email'
import { formatMeetingTimes, normalizeIanaTimeZone } from '@/lib/meetings/formatMeetingTime'
import { isMissingColumnError } from '@/lib/db/isMissingColumn'
import {
  createIntroRequest,
  approveIntroRequest,
  rejectIntroRequest,
} from '@/lib/introRequests'
import { generateOnboardingRecommendations } from '@/lib/generate-recommendations'
import { enqueueOnboardingRetry } from '@/lib/onboarding/retryQueue'
import { promoteIfResolved } from '@/lib/introductions/queue'
import { notifyNewVisibleBatch } from '@/lib/notifications/engagement'
import { sendAdminWelcome } from '@/lib/onboarding/welcomeFromAdmin'
import { getEffectiveTier, getMonthlyCredits } from '@/lib/tier-override'
import { buildBidirectionalMatchFilter } from '@/lib/db/filters'
import { validateSelection, validateSelectionWithCaps } from '@/lib/role-taxonomy'
import { companySlug, isLinkableCompany } from '@/lib/company/slug'
import { resolveCanonicalCompanyLink } from '@/lib/company/canonicalLink'
import { scheduleEnrichment } from '@/lib/company/enrichment/schedule'
import { provisionMemberRecords } from '@/lib/provisioning'
import { validateFullName } from '@/lib/validation/fullName'
import { persistFocusAreas } from '@/lib/profile/focusAreas'
import { sendMessageCore } from '@/lib/messages/sendMessageCore'

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
  // Normalize to a clean string[] via the shared serializer so intro_preferences
  // is ALWAYS stored as an array (accepts the comma-joined form the client sends,
  // and any legacy string). Array-only matcher readers (generate-recommendations)
  // then never silently drop a valid preference set.
  const introPref = parseMultiSelectField(formData.get('intro_preferences'))
  // Goals ("Your goals on Andrel") and personal interests — previously omitted
  // from this upsert, so profile edits silently dropped them. Parsed with the
  // shared normalizer so onboarding and profile-edit stay identical.
  const purposes = parseMultiSelectField(formData.get('purposes'))
  const interests = parseMultiSelectField(formData.get('interests'))

  // open_to_mentorship is derived from mentorship_role. mentorship_role is the
  // user-facing/editable field; open_to_mentorship is what the matching engine
  // reads (lib/generate-recommendations.ts). Keeping them in sync on write is
  // what makes mentorship matching actually function.
  const mentorshipRole = (formData.get('mentorship_role') as string) || null
  const openToMentorship = mentorshipRole != null && ['Mentor', 'Mentee', 'Both'].includes(mentorshipRole)

  // D2 safety: mirror completeOnboarding's required-field gate. Before this,
  // updateProfile had no validation, so /dashboard/profile could clear
  // role_type/seniority/expertise to empty — making the user invisible to the
  // matcher's candidate filter (lib/generate-recommendations.ts:889-894).
  // Messages and field semantics are identical to completeOnboarding.
  const nameCheck = validateFullName(formData.get('full_name') as string)
  if (!nameCheck.ok) return { error: nameCheck.error }
  const roleType = (formData.get('role_type') as string || '').trim()
  const seniority = (formData.get('seniority') as string || '').trim()
  if (!roleType) return { error: 'Please select your professional role' }
  if (!seniority) return { error: 'Please select your seniority level' }
  if (expertise.length === 0) return { error: 'Please select at least one area of expertise' }

  // Phase D: load prior desired_connections so validateSelectionWithCaps can
  // never shrink a user's existing selection below current size on save.
  const adminClient = createAdminClient()
  const { data: priorRow } = await adminClient
    .from('profiles')
    .select('desired_connections')
    .eq('id', user.id)
    .maybeSingle()
  const priorDesired = priorRow?.desired_connections ?? {}

  // Phase C: desired_connections capture-only. Phase D: cap-on-add via
  // validateSelectionWithCaps (5 categories / 15 titles), preserving any
  // existing selection that already exceeds those caps.
  let desiredConnections: ReturnType<typeof validateSelection> = {}
  const desiredConnectionsRaw = formData.get('desired_connections') as string
  if (desiredConnectionsRaw) {
    try { desiredConnections = validateSelectionWithCaps(JSON.parse(desiredConnectionsRaw), priorDesired) }
    catch { desiredConnections = validateSelectionWithCaps({}, priorDesired) }
  }

  console.log('[completeOnboarding] About to upsert profile data')

  // Auto-link the free-text company to its canonical companies.id (one clear match
  // only). Computed BEFORE the upsert so it's atomic. `preserve` (lookup failed) →
  // omit company_id entirely; never blocks onboarding. Never touches `company`.
  const companyLink = await resolveCanonicalCompanyLink(adminClient, (formData.get('company') as string) || null)

  const { error } = await adminClient.from('profiles').upsert({
    id: user.id,
    email: user.email,
    email_verified: true,  // User received invite via email, so email is verified
    email_verified_at: new Date().toISOString(),
    full_name: nameCheck.value,
    title: formData.get('title') as string || null,
    exact_job_title: ((formData.get('exact_job_title') as string) || '').trim() || null,
    company: formData.get('company') as string || null,
    ...(companyLink.action !== 'preserve' && { company_id: companyLink.action === 'set' ? companyLink.companyId : null }),
    location: formData.get('location') as string || null,
    bio: formData.get('bio') as string || null,
    expertise,
    intro_preferences: introPref,
    // Present-only writes (ProfileForm always submits both) — the fix for the
    // dropped-goals/interests bug, and can never wipe a field a caller omits.
    ...(formData.has('purposes') && { purposes }),
    ...(formData.has('interests') && { interests }),
    desired_connections: desiredConnections,
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

  // Current focus areas (optional, soft signal) — a separate best-effort write on
  // its own column that FAILS OPEN if migration 041 isn't applied, so the main
  // profile save never breaks. Present-only: only touched when submitted.
  if (formData.has('current_focus_areas')) {
    await persistFocusAreas(adminClient, user.id, formData.get('current_focus_areas'))
  }

  // Company enters the network here → create + enrich its page record in the
  // background (deduped; never re-runs an already-enriched company).
  const company = (formData.get('company') as string) || ''
  if (isLinkableCompany(company)) {
    scheduleEnrichment(adminClient, companySlug(company), company.trim())
  }

  revalidatePath('/dashboard/profile')
  // Completing the matching-profile fields retires the "Improve your
  // recommendations" card on Introductions too — revalidate it so the reminder
  // disappears immediately after save, not just on the Profile page.
  revalidatePath('/dashboard/introductions')
  return { success: true }
}

export async function requestIntroduction(targetId: string) {
  const { user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  // requester_id is server-derived; write as service_role (browser DML on intro_requests revoked, migration 055).
  const admin = createAdminClient()
  const { error } = await admin.from('intro_requests').insert({
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

  // Normalize to a clean string[] via the shared serializer so intro_preferences
  // is ALWAYS stored as an array (accepts the comma-joined form the client sends,
  // and any legacy string). Array-only matcher readers (generate-recommendations)
  // then never silently drop a valid preference set.
  const introPref = parseMultiSelectField(formData.get('intro_preferences'))
  const purposes = parseMultiSelectField(formData.get('purposes'))
  const interests = parseMultiSelectField(formData.get('interests'))
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

  // Require a real first + last name (shared authority; matches client + all
  // other write paths). Rejects one-word names before the profile is created.
  const nameCheck = validateFullName(formData.get('full_name') as string)
  if (!nameCheck.ok) return { error: nameCheck.error }

  // Server-side validation matching the matcher's candidate filter
  // (lib/generate-recommendations.ts:889-894). Profiles missing these fields
  // would silently fail to appear in other founders' batches.
  const roleType = (formData.get('role_type') as string || '').trim()
  const seniority = (formData.get('seniority') as string || '').trim()
  if (!roleType) return { error: 'Please select your professional role' }
  if (!seniority) return { error: 'Please select your seniority level' }
  if (expertise.length === 0) return { error: 'Please select at least one area of expertise' }

  // Identity gate — applied ONLY on this onboarding-completion write (which sets
  // profile_complete=true), never in updateProfile / profile edits, so existing
  // profile_complete users are never retroactively validated. Trim and require
  // at least 2 visible characters. No value blacklist — legitimate answers like
  // "Independent", "Self-employed", or "Retired" must pass without false positives.
  const title = ((formData.get('title') as string) || '').trim()
  const company = ((formData.get('company') as string) || '').trim()
  if (title.length < 2) return { error: 'Please enter your title or role' }
  if (company.length < 2) return { error: 'Please enter your company or organization' }

  // Use admin client to bypass RLS
  const adminClient = createAdminClient()

  // Phase D: load prior desired_connections so validateSelectionWithCaps can
  // never shrink an existing selection on save.
  const { data: priorRow } = await adminClient
    .from('profiles')
    .select('desired_connections')
    .eq('id', user.id)
    .maybeSingle()
  const priorDesired = priorRow?.desired_connections ?? {}

  // Phase C: desired_connections capture-only. Phase D: cap-on-add at 5 cats / 15 titles.
  let desiredConnections: ReturnType<typeof validateSelection> = {}
  const desiredConnectionsRaw = formData.get('desired_connections') as string
  if (desiredConnectionsRaw) {
    try { desiredConnections = validateSelectionWithCaps(JSON.parse(desiredConnectionsRaw), priorDesired) }
    catch { desiredConnections = validateSelectionWithCaps({}, priorDesired) }
  }

  console.log('[completeOnboarding] About to upsert profile data')

  // Asymmetric founding flag: only stamp profiles.is_founding_member=true when
  // the invite was sent with markAsFounding. If false/undefined we omit the
  // field from the upsert so an existing true value is preserved on re-onboard.
  const markAsFounding = (user as any).user_metadata?.markAsFounding === true
  const foundingFields = markAsFounding
    ? { is_founding_member: true, founding_member_expires_at: null as string | null }
    : {}

  // Auto-link the free-text company to its canonical companies.id (one clear match
  // only). `preserve` (lookup failed) → omit company_id; never blocks onboarding.
  const companyLink = await resolveCanonicalCompanyLink(adminClient, company)

  const { error } = await adminClient.from('profiles').upsert({
    id: user.id,
    email: user.email,
    email_verified: true,  // User received invite via email, so email is verified
    email_verified_at: new Date().toISOString(),
    full_name: nameCheck.value,
    title: title,
    exact_job_title: ((formData.get('exact_job_title') as string) || '').trim() || null,
    company: company,
    ...(companyLink.action !== 'preserve' && { company_id: companyLink.action === 'set' ? companyLink.companyId : null }),
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
    // Present-only: only the surfaces that collect interests submit them, so
    // onboarding without an interests field never overwrites an existing value.
    ...(formData.has('interests') && { interests }),
    desired_connections: desiredConnections,
    meeting_format_preference: (formData.get('meeting_format_preference') as string) || 'both',
    geographic_scope: (formData.get('geographic_scope') as string) || 'us-wide',
    profile_complete: true,
    // Clear the LEGACY provisioning flag on completion so a user who set their password via the
    // secure flow can never be looped back to "Set your password" by the middleware.
    password_reset_required: false,
    updated_at: new Date().toISOString(),
    ...foundingFields,
  }, { onConflict: 'email' })

  if (error) {
    console.error('[completeOnboarding] error:', error.message)
    return { error: error.message }
  }

  // Current focus areas (optional, soft signal) — best-effort, fails open if
  // migration 041 isn't applied. Present-only so onboarding without it is fine.
  if (formData.has('current_focus_areas')) {
    await persistFocusAreas(adminClient, user.id, formData.get('current_focus_areas'))
  }

  // Company enters the network here → create + enrich its page record in the
  // background (deduped; never re-runs an already-enriched company).
  if (isLinkableCompany(company)) {
    scheduleEnrichment(adminClient, companySlug(company), company.trim())
  }

  // Generate initial recommendations for new user. Awaited before the action returns. The generator
  // returns an unambiguous outcome (created / empty_pool / capacity / no_compatible_candidate /
  // ineligible / transient_error) which we log structurally (no identifiers). A non-created outcome
  // is NOT reported as success, but onboarding is never blocked by the absence of a compatible
  // candidate. Recovery for a retryable outcome is a separately-authorized, explicitly-targeted
  // operation (there is no automatic global sweep).
  try {
    const result = await generateOnboardingRecommendations(user.id)
    // Durable retry: enqueue THIS member only when the outcome is retryable. Fail-open, but the log
    // distinguishes a genuinely-scheduled retry from an enqueue failure (never falsely claims durable).
    const durableRetryScheduled = result.retryable ? await enqueueOnboardingRetry(adminClient, user.id, result.outcome) : false
    console.log('[completeOnboarding] recs', JSON.stringify({ outcome: result.outcome, created: result.count, retryable: result.retryable, durableRetryScheduled }))
  } catch (err: any) {
    console.error('[completeOnboarding] recs generation error (non-blocking):', err?.message)
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
  const { user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  // Write only the avatar_url column, scoped to the caller's own row, as service_role (browser UPDATE
  // on profiles is revoked, migration 055).
  const { error } = await createAdminClient()
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

  // Browser DML on intro_requests is revoked (migration 055); write as service_role, scoped to rows the
  // caller is the TARGET of (authorization is the .eq('target_user_id', user.id) filter / the fetch below).
  const adminClient = createAdminClient()

  if (status === 'declined') {
    const { error } = await adminClient
      .from('intro_requests')
      .update({ status: 'declined', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('target_user_id', user.id)
    if (error) return { error: error.message }
    revalidatePath('/dashboard/introductions')
    return { success: true, status: 'declined' }
  }

  // Accepting — fetch the request to find the requester (scoped to the caller as target).
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

  // Mark intro_request as accepted (authorized above: caller is the target of this id). service_role.
  const { error: updateErr } = await adminClient
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
  const { user } = await getSupabaseAndUser()
  if (!user || user.email !== 'bizdev91@gmail.com') return { error: 'Not authorized' }

  // Admin-authorized; write as service_role (browser DML on credit_transactions is revoked, migration 055).
  const adminClient = createAdminClient()
  const { data: current } = await adminClient
    .from('meeting_credits')
    .select('balance')
    .eq('user_id', userId)
    .single()

  const newBalance = Math.max(0, (current?.balance ?? 0) + delta)

  const { error: updateErr } = await adminClient
    .from('meeting_credits')
    .upsert({ user_id: userId, balance: newBalance }, { onConflict: 'user_id' })

  if (updateErr) return { error: updateErr.message }

  await adminClient.from('credit_transactions').insert({
    user_id: userId,
    amount: delta,
    description: reason || `Manual admin adjustment (${delta > 0 ? '+' : ''}${delta})`,
  })

  revalidatePath('/dashboard/admin')
  return { success: true, newBalance }
}

export async function sendMessage(conversationId: string, content: string) {
  const { user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  // Browser INSERT on messages is revoked (migration 055). Authorization + the insert + notification/
  // email run server-side through the SHARED sendMessageCore so this action and /api/messages/send can
  // never diverge: it rejects inactive senders, removed/closed matches, and blocked pairs (generic 403,
  // no side effects). Server actions are same-origin-enforced by Next.js.
  const admin = createAdminClient()
  const result = await sendMessageCore(admin, { senderId: user.id, conversationId, content })
  if (!result.ok) return { error: 'This conversation is unavailable.' }

  revalidatePath('/dashboard/messages')
  return { success: true }
}

export async function createConversation(otherUserId: string) {
  const { user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  // Superseded by POST /api/conversations/create (which enforces the match/removed checks). Kept for
  // compatibility; writes as service_role since browser DML on conversations is revoked (migration 055).
  const admin = createAdminClient()
  const { data: conv, error: convErr } = await admin
    .from('conversations')
    .insert({})
    .select('id')
    .single()

  if (convErr || !conv) return { error: convErr?.message }

  await admin.from('conversation_participants').insert([
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
  // Honeypot field — invisible to humans, often filled by bots. If non-empty
  // we silently return success without inserting or sending mail.
  ch_hp_field?: string
}) {
  // Honeypot: bot filled the hidden field — silently succeed so the bot can't
  // distinguish honeypot from a real submit.
  if (data.ch_hp_field && data.ch_hp_field.trim().length > 0) {
    return { success: true }
  }

  // Require a real first + last name before the waitlist row is created, so a
  // one-word name can never propagate downstream into provisioning/profiles.
  const wlNameCheck = validateFullName(data.fullName)
  if (!wlNameCheck.ok) return { error: wlNameCheck.error }

  // Server-side email format check. The form has type="email" but a direct
  // server-action call can bypass that, and Resend will reject malformed
  // addresses anyway — fail fast with a clean error before the DB insert.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const email = normalizeEmail(data.email)
  if (!email || !EMAIL_RE.test(email)) {
    return { error: 'Please enter a valid email address.' }
  }

  // Re-entry guard: if this email already has a waitlist row, a profile, or an
  // auth user (any case), do NOT create another waitlist row. One generic
  // message for every existing state (no account enumeration).
  const admin = createAdminClient()
  const emailPattern = email.replace(/([\\%_])/g, '\\$1') // escape ILIKE wildcards
  const [{ data: wlExisting }, { data: profExisting }] = await Promise.all([
    admin.from('waitlist').select('id').ilike('email', emailPattern).limit(1),
    admin.from('profiles').select('id').ilike('email', emailPattern).limit(1),
  ])
  let authExists = false
  try {
    authExists = !!(await findAuthUserByEmail(admin, email))
  } catch (e) {
    console.error('[submitWaitlist] auth lookup failed (treating as not-exists):', e)
  }
  const guard = registrationExistingState({
    waitlistExists: !!(wlExisting && wlExisting.length > 0),
    profileExists: !!(profExisting && profExisting.length > 0),
    authExists,
  })
  if (guard.blocked) {
    return { error: guard.message, existing: true }
  }

  const supabase = createClient()

  const hasLinkedIn = data.linkedinUrl && data.linkedinUrl.trim().length > 0
  const verification_status = 'pending_review'
  const verification_method = hasLinkedIn ? 'linkedin' : 'none'
  
  const { error } = await supabase.from('waitlist').insert({
    full_name: wlNameCheck.value,
    email: email,
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
  // Submitter confirmation. Fire-and-forget shape mirrors the admin alert
  // above: a Resend failure is logged but does not fail the user's submit —
  // they're already on the waitlist (DB insert succeeded) and the operator
  // has been notified.
  const confirmResult = await sendWaitlistConfirmationEmail(data.email, data.fullName)
  if (!confirmResult.success) {
    console.error('[submitWaitlist] confirmation email failed:', confirmResult.error)
  }
  return { success: true }
}
// NOTE: this server action is currently NOT wired to the AdminWaitlistClient UI;
// the live invite flow is POST /api/admin/send-invite. Kept here with the same
// tier-aware credit logic so a re-enable doesn't regress to the hardcoded 3.

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

  // Validate the browser IANA timezone (already submitted by the modal) and store
  // it so later emails — the accept/confirmation email in particular — can show the
  // correct local time. scheduled_at is unchanged (canonical UTC); blank/invalid → NULL.
  const scheduledTimezone = normalizeIanaTimeZone(formData.get('timezone') as string)
  const meetingRow = {
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
  }

  // requester_id is server-derived (user.id); write as service_role — browser DML on meetings is
  // revoked (migration 055). Any authenticated member may still request a meeting they initiate.
  const adminClient = createAdminClient()
  let { error } = await adminClient.from('meetings').insert({ ...meetingRow, scheduled_timezone: scheduledTimezone })
  if (error && isMissingColumnError(error)) {
    // Compatibility: the scheduled_timezone migration (027) isn't applied yet —
    // insert without it so meeting creation still works. Apply 027 to enable.
    console.warn('[scheduleMeeting] scheduled_timezone column missing; inserting without it (apply migration 027)')
    ;({ error } = await adminClient.from('meetings').insert(meetingRow))
  }

  if (error) return { error: error.message }

  // Create notification for recipient
  const { data: requesterProfile } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', user.id)
    .single()

  const requesterName = requesterProfile?.full_name || user.email
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
    // UTC is stored/scheduled unchanged; this only formats the email to show the
    // scheduler's local time (same IANA zone the request screen used) AND UTC.
    const { dateLabel, localLabel, utcLabel } = formatMeetingTimes(
      scheduled_at,
      (formData.get('timezone') as string) || null,
    )

    try {
      await sendMeetingRequestEmail(
        recipientProfile.email,
        recipientProfile.full_name || 'there',
        requesterName,
        dateLabel,
        localLabel,
        utcLabel,
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
  const { user } = await getSupabaseAndUser()
  if (!user) return { error: 'Not authenticated' }

  // Recommendations live in the unified queue (intro_requests). Pass = 'passed'
  // (cooldown); permanent = 'hidden_permanent'. Ownership-scoped to the member's own
  // still-visible ('suggested') row.
  const admin = createAdminClient()
  // A RECIPROCAL pair card (pair_id set) must be closed pair-aware, transactionally, so the
  // counterpart's card is neutrally closed too and both members' capacity is released — never two
  // independent client updates. Legacy (non-pair) suggestions keep their existing behavior.
  const { data: passRow } = await admin
    .from('intro_requests')
    .select('id, pair_id, status')
    .eq('id', rowId)
    .eq('requester_id', user.id)
    .maybeSingle()

  if (passRow?.pair_id && passRow.status === 'suggested') {
    await admin.rpc('pass_reciprocal_pair', { p_pair_id: passRow.pair_id, p_passer_id: user.id })
  } else {
    await admin
      .from('intro_requests')
      .update({ status: permanent ? 'hidden_permanent' : 'passed', updated_at: new Date().toISOString() })
      .eq('id', rowId)
      .eq('requester_id', user.id)
      .eq('status', 'suggested')
  }

  // Resolving the active batch's last open recommendation promotes the queued
  // batch (if one is waiting) — reveal only, never generation. When a queued
  // batch becomes visible, announce it (in-app + email), same as a fresh batch.
  const promo = await promoteIfResolved(admin, user.id)
  if (promo.promoted && promo.newActive) {
    await notifyNewVisibleBatch(user.id, promo.newActive)
  }

  revalidatePath('/dashboard/introductions')
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

  // Authorized above (participant); write as service_role (browser DML on meetings revoked, migration 055).
  const { error } = await createAdminClient()
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
      // Read the stored scheduling timezone so the confirmation email shows the
      // meeting's local time + UTC. Falls back to a scheduled_at-only read (→ UTC
      // only) if migration 027 isn't applied yet or the row predates it (NULL).
      let updatedMeeting: { scheduled_at: string; scheduled_timezone?: string | null } | null = null
      const enriched = await supabase
        .from('meetings')
        .select('scheduled_at, scheduled_timezone')
        .eq('id', meetingId)
        .single()
      if (!enriched.error) {
        updatedMeeting = enriched.data as any
      } else {
        const basic = await supabase.from('meetings').select('scheduled_at').eq('id', meetingId).single()
        updatedMeeting = basic.data as any
      }

      if (updatedMeeting) {
        // Local time from the meeting's stored IANA zone (null → UTC-only fallback).
        const { dateLabel, localLabel, utcLabel } = formatMeetingTimes(
          updatedMeeting.scheduled_at,
          updatedMeeting.scheduled_timezone ?? null,
        )

        try {
          await sendMeetingAcceptedEmail(
            otherProfile.email,
            otherProfile.full_name || 'there',
            accepterProfile.full_name || user.email || 'Someone',
            dateLabel,
            localLabel,
            utcLabel
          )
        } catch (emailError) {
          console.error('[acceptMeeting] Email error:', emailError)
        }
      }
    }

    // AUTOMATIC CALENDAR INVITATIONS — a meeting becoming 'confirmed' is the single
    // canonical transition, so the RFC 5545 invite originates HERE (server), not a
    // client button. Best-effort + fully self-contained: if migration 045 isn't applied
    // (calendar_sequence column / meeting_calendar_invites table missing) the whole block
    // fails open and the confirmation + existing email are unaffected. Idempotent via the
    // durable meeting_calendar_invites claim, so retries never double-send.
    try {
      const { data: full } = await adminClient
        .from('meetings')
        .select('id, purpose, scheduled_at, duration_minutes, location, zoom_link, notes, scheduled_timezone, calendar_sequence, requester_id, recipient_id')
        .eq('id', meetingId)
        .single()
      if (full && profiles) {
        // A reschedule being applied is a material update → bump SEQUENCE (same UID).
        let seq = (full as any).calendar_sequence ?? 0
        if (meeting.proposed_scheduled_at) {
          seq = seq + 1
          await adminClient.from('meetings').update({ calendar_sequence: seq }).eq('id', meetingId)
        }
        const requester = profiles.find(p => p.id === (full as any).requester_id)
        const recipient = profiles.find(p => p.id === (full as any).recipient_id)
        const { sendMeetingCalendarInvites } = await import('@/lib/meetings/calendarInvite')
        const { sendCalendarInviteEmail } = await import('@/lib/email')
        await sendMeetingCalendarInvites(
          adminClient,
          {
            id: (full as any).id,
            purpose: (full as any).purpose,
            scheduled_at: (full as any).scheduled_at,
            duration_minutes: (full as any).duration_minutes,
            location: (full as any).location,
            zoom_link: (full as any).zoom_link,
            notes: (full as any).notes,
            scheduled_timezone: (full as any).scheduled_timezone,
            requester: { email: requester?.email, full_name: requester?.full_name },
            recipient: { email: recipient?.email, full_name: recipient?.full_name },
          },
          'REQUEST',
          seq,
          (a) => sendCalendarInviteEmail(a),
        )
      }
    } catch (calErr) {
      console.error('[acceptMeeting] calendar invite error:', (calErr as any)?.message)
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

  // Authorized above (participant); write as service_role (browser DML on meetings revoked, migration 055).
  const { error } = await createAdminClient()
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

  // AUTOMATIC CALENDAR CANCELLATION — send METHOD:CANCEL (same stable UID, next SEQUENCE)
  // to both participants BEFORE the hard delete, but only for a CONFIRMED meeting that had
  // an invite. Best-effort + self-contained: fails open if migration 045 isn't applied, and
  // never blocks the delete. The invite record has no FK to meetings, so it survives.
  try {
    const adminClient = createAdminClient()
    const { data: full } = await adminClient
      .from('meetings')
      .select('id, status, purpose, scheduled_at, duration_minutes, location, zoom_link, notes, scheduled_timezone, calendar_sequence, requester_id, recipient_id')
      .eq('id', meetingId)
      .single()
    if (full && (full as any).status === 'confirmed') {
      const { data: profiles } = await adminClient.from('profiles').select('id, full_name, email').in('id', [(full as any).requester_id, (full as any).recipient_id])
      const requester = profiles?.find(p => p.id === (full as any).requester_id)
      const recipient = profiles?.find(p => p.id === (full as any).recipient_id)
      const seq = ((full as any).calendar_sequence ?? 0) + 1
      const { sendMeetingCalendarInvites } = await import('@/lib/meetings/calendarInvite')
      const { sendCalendarInviteEmail } = await import('@/lib/email')
      await sendMeetingCalendarInvites(
        adminClient,
        {
          id: (full as any).id, purpose: (full as any).purpose, scheduled_at: (full as any).scheduled_at,
          duration_minutes: (full as any).duration_minutes, location: (full as any).location, zoom_link: (full as any).zoom_link,
          notes: (full as any).notes, scheduled_timezone: (full as any).scheduled_timezone,
          requester: { email: requester?.email, full_name: requester?.full_name },
          recipient: { email: recipient?.email, full_name: recipient?.full_name },
        },
        'CANCEL',
        seq,
        (a) => sendCalendarInviteEmail(a),
      )
    }
  } catch (calErr) {
    console.error('[deleteMeeting] calendar cancel error:', (calErr as any)?.message)
  }

  // Authorized above (participant); write as service_role (browser DML on meetings revoked, migration 055).
  const { error } = await createAdminClient()
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

  const rescheduleUpdate: Record<string, any> = {
    proposed_scheduled_at: scheduled_at,
    proposed_duration_minutes: parseInt(formData.get('duration_minutes') as string || '30'),
    proposed_format: formData.get('format') as string || 'virtual',
    proposed_location: (formData.get('location') as string) || null,
    proposed_zoom_link: (formData.get('zoom_link') as string) || null,
    proposed_notes: (formData.get('notes') as string) || null,
    status: 'reschedule_requested',
  }
  // Update the stored timezone to the rescheduler's zone. If the submitted value is
  // missing/invalid, omit the field entirely so the prior stored timezone is preserved.
  const rescheduleTimezone = normalizeIanaTimeZone(formData.get('timezone') as string)
  if (rescheduleTimezone) rescheduleUpdate.scheduled_timezone = rescheduleTimezone

  // Authorized above (caller is a participant); write as service_role — browser DML on meetings is
  // revoked (migration 055).
  const adminClient = createAdminClient()
  let { error } = await adminClient.from('meetings').update(rescheduleUpdate).eq('id', meetingId)
  if (error && rescheduleTimezone && isMissingColumnError(error)) {
    // Compatibility: migration 027 not applied yet — retry without the timezone.
    console.warn('[rescheduleMeeting] scheduled_timezone column missing; updating without it (apply migration 027)')
    const { scheduled_timezone, ...withoutTz } = rescheduleUpdate
    ;({ error } = await adminClient.from('meetings').update(withoutTz).eq('id', meetingId))
  }

  if (error) return { error: error.message }

  // Notify the other party
  const otherUserId = meeting.requester_id === user.id ? meeting.recipient_id : meeting.requester_id
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
    // UTC stays canonical; format the rescheduler's local time (same IANA zone the
    // reschedule screen used) alongside UTC.
    const { dateLabel, localLabel, utcLabel } = formatMeetingTimes(
      scheduled_at,
      (formData.get('timezone') as string) || null,
    )
    try {
      await sendMeetingRescheduledEmail(
        otherProfile.email,
        otherProfile.full_name || 'there',
        reschedulerProfile.full_name || user.email || 'Someone',
        dateLabel,
        localLabel,
        utcLabel,
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

  // Admin-authorized; write as service_role (browser DML on matches/conversations is revoked, migration 055).
  const adminClient = createAdminClient()
  const { data: match, error: matchError } = await adminClient
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
  await adminClient.from('conversations').insert({
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
  const { user } = await getSupabaseAndUser()
  if (!user || user.email !== 'bizdev91@gmail.com') return { error: 'Not authorized' }

  // Admin-authorized privileged writes (tier/account_status/verification/etc). service_role — browser
  // DML on profiles is revoked (migration 055), and these are exactly the fields it must never accept
  // from an ordinary member; only this admin-gated action may set them.
  const admin = createAdminClient()

  const profileUpdates: any = {}
  if (updates.tier !== undefined) profileUpdates.subscription_tier = updates.tier
  if (updates.launch_cohort !== undefined) profileUpdates.launch_cohort = updates.launch_cohort
  if (updates.verification_status !== undefined) profileUpdates.verification_status = updates.verification_status
  if (updates.is_priority !== undefined) profileUpdates.is_priority = updates.is_priority
  if (updates.boost_score !== undefined) profileUpdates.boost_score = updates.boost_score
  if (updates.account_status !== undefined) profileUpdates.account_status = updates.account_status
  if (updates.current_status !== undefined) profileUpdates.current_status = updates.current_status

  if (Object.keys(profileUpdates).length > 0) {
    const { error } = await admin
      .from('profiles')
      .update(profileUpdates)
      .eq('id', userId)

    if (error) return { error: error.message }
  }

  // Update credits if provided
  if (updates.credits !== undefined) {
    const { error } = await admin
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
  const { user } = await getSupabaseAndUser()
  if (!user || user.email !== 'bizdev91@gmail.com') return { error: 'Not authorized' }

  // Admin-authorized; read + write as service_role (browser DML on profiles revoked, migration 055; and
  // the target row may not be discoverable to the admin's own authenticated role).
  const admin = createAdminClient()
  const { data: current, error: readError } = await admin
    .from('profiles')
    .select('id, full_name, email, is_founding_member, founding_member_email_sent_at')
    .eq('id', userId)
    .maybeSingle()

  if (readError) return { error: readError.message }
  if (!current) return { error: 'Profile not found' }

  if (!isFoundingMember) {
    // Removal: drop the flag, preserve sent_at as audit trail.
    const { error } = await admin
      .from('profiles')
      .update({ is_founding_member: false })
      .eq('id', userId)
    if (error) return { error: error.message }
    revalidatePath('/dashboard/admin')
    return { success: true, emailSent: false }
  }

  // Grant. Send the email only on the first grant (sent_at IS NULL).
  if (current.founding_member_email_sent_at) {
    const { error } = await admin
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

  const { error } = await admin
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

