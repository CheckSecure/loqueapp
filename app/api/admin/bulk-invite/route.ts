import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendSecureInviteEmail } from '@/lib/email'
import { lookupAuthUsersByEmail } from '@/lib/invitations'
import { sendSecureInvite, type SecureInviteDeps } from '@/lib/invitations/secureInvite'
import { claimInviteDelivery, markDeliveryAccepted, markDeliveryFailed } from '@/lib/invitations/delivery'
import { invitationsMode, canSendInvitation, INVITATIONS_PAUSED_MESSAGE } from '@/lib/invitations/featureGate'
import { getSiteUrl, getRecoveryRedirectUrl } from '@/lib/config/siteUrl'
import { isValidFullName, normalizeFullName } from '@/lib/validation/fullName'

const ADMIN_EMAIL = 'bizdev91@gmail.com'
const MAX_BATCH = 100
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i

interface ParsedEntry {
  name: string
  email: string
}

interface InvalidEntry {
  raw: string
  reason: string
}

interface BatchDefaults {
  isFoundingMember: boolean
  professionType: string | null
}

// ---------------------------------------------------------------------------
// Parse one line of pasted text into a name + email pair.
// Accepted formats:
//   email@domain.com
//   First Last email@domain.com
//   First Last, email@domain.com
// Returns null if no valid email can be extracted.
// ---------------------------------------------------------------------------
function parseLine(raw: string): ParsedEntry | null {
  const line = raw.trim()
  if (!line) return null

  // Comma-separated: "Name, email" or "email, Name" (we look for the token
  // containing @)
  if (line.includes(',')) {
    const parts = line.split(',').map(p => p.trim())
    const emailPart = parts.find(p => EMAIL_RE.test(p))
    const namePart = parts.find(p => !EMAIL_RE.test(p) && p.length > 0)
    if (emailPart) {
      return { email: emailPart.toLowerCase(), name: namePart ?? '' }
    }
    return null
  }

  // Space-separated: last token is assumed to be email if it looks like one
  const tokens = line.split(/\s+/)
  const last = tokens[tokens.length - 1]
  if (EMAIL_RE.test(last)) {
    const name = tokens.slice(0, -1).join(' ').trim()
    return { email: last.toLowerCase(), name }
  }

  return null
}

// ---------------------------------------------------------------------------
// Parse the full textarea text into ready/invalid buckets.
// ---------------------------------------------------------------------------
function parseText(text: string): { entries: ParsedEntry[]; invalid: InvalidEntry[] } {
  const lines = text.split('\n')
  const entries: ParsedEntry[] = []
  const invalid: InvalidEntry[] = []
  const seen = new Set<string>()

  for (const raw of lines) {
    if (!raw.trim()) continue
    const parsed = parseLine(raw)
    if (!parsed) {
      invalid.push({ raw: raw.trim(), reason: 'No valid email found' })
      continue
    }
    if (seen.has(parsed.email)) {
      invalid.push({ raw: raw.trim(), reason: `Duplicate in paste: ${parsed.email}` })
      continue
    }
    // A provided name must be a real first + last name (shared authority). An
    // email-only line (no name) is still allowed — the member supplies a validated
    // name at onboarding — but a present one-word name is rejected, never stored.
    if (parsed.name && !isValidFullName(parsed.name)) {
      invalid.push({ raw: raw.trim(), reason: 'Name must include a first and last name' })
      continue
    }
    parsed.name = normalizeFullName(parsed.name)
    seen.add(parsed.email)
    entries.push(parsed)
  }

  return { entries, invalid }
}

// ---------------------------------------------------------------------------
// Deduplicate a list of parsed entries against profiles + waitlist.
// Returns four categorised lists.
// ---------------------------------------------------------------------------
async function categorise(entries: ParsedEntry[], adminClient: ReturnType<typeof createAdminClient>) {
  if (entries.length === 0) {
    return {
      ready_to_invite: [] as ParsedEntry[],
      already_member: [] as ParsedEntry[],
      already_waitlisted: [] as ParsedEntry[],
    }
  }

  const emails = entries.map(e => e.email)

  const [{ data: profileRows }, { data: waitlistRows }] = await Promise.all([
    adminClient.from('profiles').select('email').in('email', emails),
    adminClient.from('waitlist').select('email').in('email', emails),
  ])

  const memberEmails = new Set((profileRows ?? []).map((r: any) => r.email?.toLowerCase()))
  const waitlistEmails = new Set((waitlistRows ?? []).map((r: any) => r.email?.toLowerCase()))

  const ready_to_invite: ParsedEntry[] = []
  const already_member: ParsedEntry[] = []
  const already_waitlisted: ParsedEntry[] = []

  for (const entry of entries) {
    if (memberEmails.has(entry.email)) {
      already_member.push(entry)
    } else if (waitlistEmails.has(entry.email)) {
      already_waitlisted.push(entry)
    } else {
      ready_to_invite.push(entry)
    }
  }

  return { ready_to_invite, already_member, already_waitlisted }
}

// ---------------------------------------------------------------------------
// POST handler — action=preview | action=execute
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  // Auth gate
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const action: 'preview' | 'execute' = body.action
  const text: string = body.text ?? ''
  const defaults: BatchDefaults = {
    isFoundingMember: Boolean(body.defaults?.isFoundingMember),
    professionType: body.defaults?.professionType ?? null,
  }

  if (action !== 'preview' && action !== 'execute') {
    return NextResponse.json({ error: 'action must be preview or execute' }, { status: 400 })
  }

  const { entries, invalid } = parseText(text)

  if (entries.length + invalid.length > MAX_BATCH) {
    return NextResponse.json(
      { error: `Batch size limited to ${MAX_BATCH}. Please send in chunks.` },
      { status: 400 }
    )
  }

  const adminClient = createAdminClient()
  const { ready_to_invite, already_member, already_waitlisted } = await categorise(entries, adminClient)

  // ── PREVIEW ──────────────────────────────────────────────────────────────
  if (action === 'preview') {
    return NextResponse.json({
      ready_to_invite,
      already_member,
      already_waitlisted,
      invalid,
    })
  }

  // ── EXECUTE ──────────────────────────────────────────────────────────────
  // Per-invitee ordering (mitigates Trap #23 for bulk path):
  //   1. Generate temp password
  //   2. Send email
  //   3. ONLY on email success: createUser
  //   4. Insert waitlist row + apply batch defaults

  type RowResult = {
    email: string
    name: string
    status: 'sent' | 'email_failed' | 'db_failed' | 'skipped'
    error?: string
  }

  const results: RowResult[] = []

  // ROLLOUT-MODE GATE. Preview (above) is always allowed; EXECUTE is gated:
  //   off  → reject the whole batch (503, nothing sent);
  //   test → process ONLY allowlisted rows; every other row is reported as skipped BEFORE any
  //          waitlist insert, Auth lookup, delivery claim, or provider call;
  //   on   → normal.
  const mode = invitationsMode()
  if (mode === 'off') {
    return NextResponse.json({ paused: true, message: INVITATIONS_PAUSED_MESSAGE, sent: 0, results: [] }, { status: 503 })
  }

  // SECURE, PASSWORDLESS bulk invite: each row inserts its waitlist row first (visible as
  // "invitation not sent" if delivery fails), then the shared helper mints the auth user via
  // generateLink({type:'invite'}) — NO temp password — and emails a scanner-resistant set-password
  // link, recording delivery. invited_at is stamped only on provider acceptance.
  const siteUrl = getSiteUrl()
  const recoverUrl = getRecoveryRedirectUrl()
  const mkDeps = (waitlistId: string, rowEmail: string): SecureInviteDeps => ({
    siteUrl,
    lookupAuth: (e) => lookupAuthUsersByEmail(adminClient, e),
    hasProfile: async (uid) => { const { data } = await adminClient.from('profiles').select('id').eq('id', uid).maybeSingle(); return !!data },
    claimDelivery: (purpose, authUserId) => claimInviteDelivery(adminClient, { waitlistId, authUserId, email: rowEmail, purpose }),
    markAccepted: (id, msgId, authUserId) => markDeliveryAccepted(adminClient, id, msgId, authUserId),
    markFailed: (id, errorClass) => markDeliveryFailed(adminClient, id, errorClass),
    generateLink: async (type, e) => {
      // Consistent with the single invite: founding-member metadata via the generateLink
      // `data` option on the first-invite link only (consumed at onboarding).
      const options: any = { redirectTo: recoverUrl }
      if (defaults.isFoundingMember && type === 'invite') options.data = { markAsFounding: true }
      const { data, error } = await adminClient.auth.admin.generateLink({ type, email: e, options } as any)
      const ht = (data as any)?.properties?.hashed_token
      if (error || !ht) throw new Error(error?.message || 'generateLink failed')
      return { hashedToken: ht, userId: (data as any)?.user?.id ?? null }
    },
    sendEmail: (a) => sendSecureInviteEmail({ to: a.to, toName: a.toName, link: a.link, purpose: a.purpose, idempotencyKey: a.idempotencyKey }),
  })

  for (const { email, name } of ready_to_invite) {
    // TEST-MODE ALLOWLIST GATE — the FIRST thing per row, before any Auth lookup, waitlist
    // insert, delivery claim, or provider call. In 'on' mode canSendInvitation is always true;
    // in 'test' mode a non-allowlisted row is reported skipped and NOTHING happens for it.
    if (!canSendInvitation(email)) {
      results.push({ email, name, status: 'skipped', error: 'not on the test allowlist (invitation test mode)' })
      continue
    }
    // BLOCKER 7 FIX: classify BEFORE inserting the waitlist row, so an already-active or
    // duplicate/ambiguous account never gets a spurious new waitlist row.
    let pre
    try { pre = await lookupAuthUsersByEmail(adminClient, email) } catch { results.push({ email, name, status: 'db_failed', error: 'auth lookup failed' }); continue }
    const activated = !!pre.user && (!!pre.user.last_sign_in_at || !!(await adminClient.from('profiles').select('id').eq('id', pre.user.id).maybeSingle()).data)
    if (pre.count > 1) { results.push({ email, name, status: 'skipped', error: 'duplicate/ambiguous account — manual review' }); continue }
    if (pre.count === 1 && activated) { results.push({ email, name, status: 'skipped', error: 'already an active account' }); continue }

    const { data: wl, error: wlErr } = await adminClient
      .from('waitlist')
      .insert({ email, full_name: name || null, status: 'invited', referral_source: 'direct_invite', role_type: defaults.professionType ?? null })
      .select('id')
      .single()
    if (wlErr || !wl) {
      console.error(`[bulk-invite] waitlist insert failed for ${email}:`, wlErr?.message)
      results.push({ email, name, status: 'db_failed', error: wlErr?.message })
      continue
    }

    const r = await sendSecureInvite(mkDeps(wl.id, email), { email, fullName: name || null, waitlistId: wl.id })
    if (r.state === 'active' || r.state === 'ambiguous' || r.state === 'pending' || r.state === 'needs_review' || r.state === 'unavailable') {
      // Neutral non-send outcomes (already active/ambiguous, an in-flight claim, a past-window
      // claim needing review, or delivery tracking unavailable → fail closed). No invited_at.
      results.push({ email, name, status: 'skipped', error: r.message })
      continue
    }
    if (!r.ok) {
      results.push({ email, name, status: 'email_failed', error: r.message })
      continue // retryable; the row stays visible as "invitation not sent"
    }

    await adminClient.from('waitlist').update({ invited_at: new Date().toISOString() }).eq('id', wl.id)

    if (defaults.isFoundingMember && r.authUserId) {
      const { error: foundingError } = await adminClient.from('profiles').update({ is_founding_member: true }).eq('id', r.authUserId)
      if (foundingError) console.warn(`[bulk-invite] founding-member flag not set for ${email} (profile may not exist yet):`, foundingError.message)
    }

    results.push({ email, name, status: 'sent' })
  }

  const sent = results.filter(r => r.status === 'sent').length
  const email_failed = results.filter(r => r.status === 'email_failed').length
  const db_failed = results.filter(r => r.status === 'db_failed').length

  return NextResponse.json({
    sent,
    email_failed,
    db_failed,
    total: results.length,
    results,
  })
}
