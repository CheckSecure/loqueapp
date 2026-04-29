// app/api/referrals/submit/route.ts

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// Basic email format check. Does NOT normalize Unicode lookalikes or punycode — V1 accepted gap.
// A determined user could submit visually similar addresses that bypass this check.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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

  const { full_name, email, title, company, referral_note } = body

  // ── Validation 1: required fields ─────────────────────────────────────────
  if (!full_name?.trim() || !email?.trim() || !referral_note?.trim()) {
    return NextResponse.json(
      { ok: false, error: 'full_name, email, and referral_note are required', code: 'MISSING_FIELDS' },
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

  // ── Validation 8: referrer cap ────────────────────────────────────────────
  // Race condition: two concurrent submissions from the same referrer can both pass
  // this check before either insert completes. V1 accepted gap — worst case is 4
  // outstanding referrals instead of 3. No schema change needed to address this.
  const { count: outstandingCount } = await adminClient
    .from('referrals')
    .select('id', { count: 'exact', head: true })
    .eq('referrer_user_id', referrerProfile.id)
    .in('status', ['pending', 'invited'])

  if ((outstandingCount ?? 0) >= 3) {
    return NextResponse.json(
      { ok: false, error: 'You have reached the maximum of 3 outstanding referrals', code: 'CAP_REACHED' },
      { status: 409 }
    )
  }

  // ── Insert: waitlist row ──────────────────────────────────────────────────
  const { data: newWaitlistRow, error: waitlistError } = await adminClient
    .from('waitlist')
    .insert({
      full_name:           full_name.trim(),
      email:               targetEmail,
      title:               title?.trim() || null,
      company:             company?.trim() || null,
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
  const { data: newReferralRow, error: referralError } = await adminClient
    .from('referrals')
    .insert({
      referrer_user_id: referrerProfile.id,
      waitlist_id:      newWaitlistRow.id,
      referral_note:    referral_note.trim(),
    })
    .select('id')
    .single()

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

  return NextResponse.json({
    ok:         true,
    referralId: newReferralRow.id,
    waitlistId: newWaitlistRow.id,
  })
}
