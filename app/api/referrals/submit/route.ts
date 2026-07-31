// app/api/referrals/submit/route.ts

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logRecommendationEvent } from '@/lib/analytics/recommendationEvents'
import { isMissingColumnError } from '@/lib/db/isMissingColumn'

// Basic email format check. Does NOT normalize Unicode lookalikes or punycode — V1 accepted gap.
// A determined user could submit visually similar addresses that bypass this check.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// LinkedIn (and any profile URL) must be a well-formed http(s) URL. Optional field —
// only validated when a value is present. Kept permissive on host so linkedin.com,
// www.linkedin.com, and country subdomains all pass.
function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export async function POST(req: Request) {

  // ── Auth gate ─────────────────────────────────────────────────────────────
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json(
      { ok: false, error: 'Not authenticated', code: 'UNAUTHORIZED' },
      { status: 401 }
    )
  }

  const { data: referrerProfile } = await supabase
    .from('profiles')
    .select('id, email, account_status')
    .eq('id', user.id)
    .single()

  if (!referrerProfile) {
    return NextResponse.json(
      { ok: false, error: 'Profile not found', code: 'PROFILE_NOT_FOUND' },
      { status: 500 }
    )
  }

  // Supabase auth sessions remain valid after deactivation — must check account_status explicitly.
  if (referrerProfile.account_status !== 'active') {
    return NextResponse.json(
      { ok: false, error: 'Your account is not active', code: 'REFERRER_INACTIVE' },
      { status: 403 }
    )
  }

  // ── Body parsing ──────────────────────────────────────────────────────────
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid request body', code: 'INVALID_BODY' },
      { status: 400 }
    )
  }

  const { full_name, email, title, company, linkedin_url, relationship, referral_note, consent } = body

  // ── Validation 1: required fields ─────────────────────────────────────────
  // referral_note ("why") is REQUIRED and must contain at least one non-whitespace
  // character — public.referrals enforces CHECK(length(trim(referral_note)) > 0), so
  // a blank/whitespace-only note would violate it. We reject here, BEFORE the waitlist
  // row is created, so a bad note never leaves an orphaned waitlist entry. relationship
  // stays optional.
  if (!full_name?.trim() || !email?.trim() || !referral_note?.trim()) {
    return NextResponse.json(
      { ok: false, error: 'full_name, email, and a non-empty referral_note are required', code: 'MISSING_FIELDS' },
      { status: 400 }
    )
  }

  const targetEmail = email.trim()

  // ── Validation 2: email format ────────────────────────────────────────────
  if (!EMAIL_REGEX.test(targetEmail)) {
    return NextResponse.json(
      { ok: false, error: 'Invalid email address', code: 'INVALID_EMAIL' },
      { status: 400 }
    )
  }

  // ── Validation 3: self-referral ───────────────────────────────────────────
  // Case-insensitive ASCII comparison only — Unicode lookalike normalization is a V1 accepted gap.
  if (targetEmail.toLowerCase() === referrerProfile.email.toLowerCase()) {
    return NextResponse.json(
      { ok: false, error: 'You cannot refer yourself', code: 'SELF_REFERRAL' },
      { status: 400 }
    )
  }

  // ── Validation 4: referral_note length ────────────────────────────────────
  if (referral_note.trim().length > 2000) {
    return NextResponse.json(
      { ok: false, error: 'Referral note is too long (max 2000 characters)', code: 'NOTE_TOO_LONG' },
      { status: 400 }
    )
  }

  // ── Validation 4b: LinkedIn URL format (optional field) ────────────────────
  if (linkedin_url?.trim() && !isValidHttpUrl(linkedin_url.trim())) {
    return NextResponse.json(
      { ok: false, error: 'Please enter a valid LinkedIn URL (including https://)', code: 'INVALID_LINKEDIN' },
      { status: 400 }
    )
  }

  const adminClient = createAdminClient()

  // ── Validation 5: existing active user ───────────────────────────────────
  // Deactivated user emails are allowed — treated as fresh applicants per V1 spec.
  const { data: existingMember } = await adminClient
    .from('profiles')
    .select('id')
    .ilike('email', targetEmail)
    .neq('account_status', 'deactivated')
    .maybeSingle()

  if (existingMember) {
    return NextResponse.json(
      { ok: false, error: 'This person is already a member', code: 'EMAIL_ALREADY_MEMBER' },
      { status: 409 }
    )
  }

  // ── Validations 6+7: waitlist existence and prior rejection ───────────────
  // If a waitlist row exists for this email, check whether it is the result of a
  // previously-rejected referral. This gives a more specific error message
  // (REFERRAL_PREVIOUSLY_REJECTED) than the generic EMAIL_ON_WAITLIST.
  const { data: existingWaitlistRow } = await adminClient
    .from('waitlist')
    .select('id')
    .ilike('email', targetEmail)
    .maybeSingle()

  if (existingWaitlistRow) {
    const { data: rejectedRef } = await adminClient
      .from('referrals')
      .select('id')
      .eq('waitlist_id', existingWaitlistRow.id)
      .eq('status', 'rejected')
      .maybeSingle()

    if (rejectedRef) {
      return NextResponse.json(
        { ok: false, error: 'This referral was previously reviewed and is not eligible for re-referral', code: 'REFERRAL_PREVIOUSLY_REJECTED' },
        { status: 409 }
      )
    }

    return NextResponse.json(
      { ok: false, error: 'This email is already on the waitlist', code: 'EMAIL_ON_WAITLIST' },
      { status: 409 }
    )
  }

  // NOTE: There is intentionally NO nomination-quantity cap. Members and admins
  // may submit unlimited nominations (no lifetime or concurrent-pending limit).
  // Per-email de-duplication (Validations 5–7 above, case-insensitive via ilike)
  // still prevents the same person being nominated twice; abuse is handled only
  // by infrastructure-level rate limiting, never a product count.

  // ── Insert: waitlist row ──────────────────────────────────────────────────
  const { data: newWaitlistRow, error: waitlistError } = await adminClient
    .from('waitlist')
    .insert({
      full_name:           full_name.trim(),
      email:               targetEmail,
      title:               title?.trim() || null,
      company:             company?.trim() || null,
      linkedin_url:        linkedin_url?.trim() || null,
      referral_source:     'referral',
      status:              'pending',
      verification_status: 'pending_review',
      verification_method: 'none',
    })
    .select('id')
    .single()

  if (waitlistError || !newWaitlistRow) {
    // 23505 = unique_violation: race condition where another request inserted this email
    // between our check and this insert — surface as a user-facing duplicate error.
    if (waitlistError?.code === '23505') {
      return NextResponse.json(
        { ok: false, error: 'This email is already on the waitlist', code: 'EMAIL_ON_WAITLIST' },
        { status: 409 }
      )
    }
    return NextResponse.json(
      { ok: false, error: 'Failed to create waitlist entry', code: 'WAITLIST_INSERT_FAILED' },
      { status: 500 }
    )
  }

  // ── Insert: referrals row ─────────────────────────────────────────────────
  // All application-layer checks have passed. The only remaining failure mode is a
  // DB connectivity error. If this insert fails, the waitlist row above is orphaned.
  //
  // Cleanup query for orphaned waitlist rows:
  //   SELECT * FROM waitlist WHERE referral_source = 'referral'
  //   AND id NOT IN (SELECT waitlist_id FROM referrals);
  // referral_note is required and validated non-empty above (Validation 1), so the
  // trimmed value always satisfies referrals' CHECK(length(trim(referral_note)) > 0).
  const baseReferral = {
    referrer_user_id: referrerProfile.id,
    waitlist_id:      newWaitlistRow.id,
    referral_note:    referral_note.trim(),
  }

  // Optional, migration-gated columns:
  //   relationship               → migration 036
  //   referrer_consent_to_share  → migration 037 (privacy: only true when the member
  //                                explicitly ticked the consent box; default false)
  // Fail open PER COLUMN: if a column's migration isn't applied, PostgREST reports a
  // missing column (42703 / PGRST204) naming it — drop only that column and retry, so
  // consent still persists even if 036 alone is unapplied (and vice versa).
  const optionalCols: Record<string, unknown> = {
    relationship: relationship?.trim() || null,
    referrer_consent_to_share: consent === true,
  }
  let payload: Record<string, unknown> = { ...baseReferral, ...optionalCols }
  let insertRes = await adminClient.from('referrals').insert(payload).select('id').single()
  for (let i = 0; i < Object.keys(optionalCols).length && isMissingColumnError(insertRes.error); i++) {
    const missing = Object.keys(optionalCols).find((k) => (insertRes.error?.message || '').includes(k))
    if (!missing) break
    delete payload[missing]
    insertRes = await adminClient.from('referrals').insert(payload).select('id').single()
  }

  const { data: newReferralRow, error: referralError } = insertRes

  if (referralError || !newReferralRow) {
    console.error('[referrals/submit] ORPHAN_WAITLIST — waitlist row created but referrals insert failed', {
      waitlistId:     newWaitlistRow.id,
      referrerUserId: referrerProfile.id,
      error:          referralError?.message,
    })
    return NextResponse.json(
      { ok: false, error: 'Failed to record referral', code: 'REFERRAL_INSERT_FAILED' },
      { status: 500 }
    )
  }

  logRecommendationEvent('recommendation_submitted', {
    referralId: newReferralRow.id,
    waitlistId: newWaitlistRow.id,
    referrerUserId: referrerProfile.id,
  })

  return NextResponse.json({
    ok:         true,
    referralId: newReferralRow.id,
    waitlistId: newWaitlistRow.id,
  })
}
