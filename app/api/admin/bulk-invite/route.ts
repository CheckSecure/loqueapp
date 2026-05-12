import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendInviteEmail } from '@/lib/email'
import { randomBytes } from 'crypto'

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
    status: 'sent' | 'email_failed' | 'db_failed'
    error?: string
  }

  const results: RowResult[] = []

  for (const { email, name } of ready_to_invite) {
    const displayName = name || 'there'
    const tempPassword = randomBytes(12).toString('base64url')

    // Step 1: Send invite email — if this fails, do NOT create the auth user.
    const emailResult = await sendInviteEmail(email, displayName, tempPassword)
    if (!emailResult.success) {
      console.error(`[bulk-invite] email failed for ${email}:`, emailResult.error)
      results.push({ email, name, status: 'email_failed', error: emailResult.error })
      continue
    }

    // Step 2: Create auth user (only reached if email succeeded).
    const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
    })

    if (authError) {
      // Email sent but auth creation failed — CRITICAL: user received credentials
      // they cannot use. Admin must manually create the auth row in Supabase
      // Dashboard using the same email (any password; user will reset).
      console.error(`[bulk-invite] CRITICAL: email sent but auth user creation failed for ${email}:`, authError.message)
      results.push({ email, name, status: 'db_failed', error: authError.message })
      continue
    }

    // Step 3: Insert waitlist row with status=invited.
    const { error: waitlistError } = await adminClient.from('waitlist').insert({
      email,
      full_name: name || null,
      status: 'invited',
      invited_at: new Date().toISOString(),
      referral_source: 'direct_invite',
      role_type: defaults.professionType ?? null,
    })

    if (waitlistError) {
      console.error(`[bulk-invite] waitlist insert failed for ${email}:`, waitlistError.message)
      // Auth user created and email sent — treat as sent (partial DB failure;
      // user can log in). Log for manual reconciliation.
      console.error(`[bulk-invite] manual reconciliation needed: auth user created for ${email} but waitlist row missing`)
    }

    // Step 4: Apply founding-member flag to profiles (update is a no-op if the
    // profile row doesn't exist yet — it will be created during onboarding).
    if (defaults.isFoundingMember && authData.user?.id) {
      const { error: foundingError } = await adminClient
        .from('profiles')
        .update({ is_founding_member: true })
        .eq('id', authData.user.id)

      if (foundingError) {
        // Non-fatal: profile row may not exist until onboarding completes.
        // Admin can set is_founding_member manually after the user onboards.
        console.warn(`[bulk-invite] founding-member flag not set for ${email} (profile may not exist yet):`, foundingError.message)
      }
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
