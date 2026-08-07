import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeEmail } from '@/lib/auth/normalizeEmail'
import { getRecoveryRedirectUrl } from '@/lib/config/siteUrl'

/**
 * Server-side password-recovery request logic — shared by the member route
 * (/api/auth/request-reset) and the admin tool (/api/admin/send-password-reset).
 *
 * Design invariants:
 *  - auth.users is the identity AUTHORITY: recovery works for any auth user, with or
 *    without a profiles row (Chika's class: invited, confirmed, never signed in, no profile).
 *  - the email is normalized (trim + lowercase) exactly like login before any lookup/send.
 *  - the recovery email is sent to the CANONICAL auth.users email, not the raw input.
 *  - the scanner-hardened /auth/recover flow + the SAME signInWithOtp method the member
 *    flow already uses are preserved (smallest safe change; recovery architecture unchanged).
 *  - NON-ENUMERATING: callers translate every outcome into one generic member response.
 *  - logging records only SAFE facts (masked email, found yes/no, provider ok, error class) —
 *    never a raw email, token, link, or password.
 */

export type RecoveryOutcome = {
  /** Route-level success. Always true unless an unexpected server fault — callers stay generic. */
  ok: boolean
  /** Whether a recovery send was attempted AND accepted by the provider. */
  sent: boolean
  /** Whether an auth user was found for the address (admin-only detail; never leaked to members). */
  authUserFound: boolean
  /** Coarse provider error class for graceful handling ('rate_limited' | 'provider_error' | 'other'). */
  errorClass?: string
}

const maskEmail = (e: string | null | undefined): string =>
  e ? e.replace(/^(.).*(@.*)$/, (_m, a, b) => `${a}***${b}`) : '∅'

function classifyOtpError(message: string | null | undefined): string {
  const m = (message ?? '').toLowerCase()
  if (m.includes('rate') || m.includes('limit') || m.includes('too many')) return 'rate_limited'
  if (m.includes('smtp') || m.includes('deliver') || m.includes('send')) return 'provider_error'
  return 'other'
}

function logReset(ctx: string, maskedEmail: string, authUserFound: boolean, providerSuccess: boolean, errorClass?: string) {
  // Structured, PII-safe. No raw email, token, link, or password ever appears here.
  console.log('[reset_request_received]', JSON.stringify({
    ctx, maskedEmail, authUserFound, providerSuccess, errorClass: errorClass ?? null, at: new Date().toISOString(),
  }))
}

/** A plain anon-key client for the actual OTP send (mirrors the member's own client;
 *  no service role, no session persistence). */
function anonClient() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
}

/**
 * Resolve the EXACT stored auth.users email for a normalized address, or null. auth.users
 * has no PostgREST/profiles dependency, so this finds invited-not-onboarded users too.
 * (listUsers has no server-side email filter in the JS client, so we page — bounded.)
 */
export async function findCanonicalAuthEmail(admin: any, normalizedEmail: string): Promise<string | null> {
  if (!normalizedEmail) return null
  let page = 1
  const MAX_PAGES = 50
  while (page <= MAX_PAGES) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) return null
    const users: any[] = (data as any)?.users || []
    const hit = users.find((u) => (u.email || '').toLowerCase() === normalizedEmail)
    if (hit) return hit.email
    if (users.length < 200) break
    page++
  }
  return null
}

async function sendRecovery(canonicalEmail: string): Promise<{ ok: boolean; errorClass?: string }> {
  const { error } = await anonClient().auth.signInWithOtp({
    email: canonicalEmail,
    options: { shouldCreateUser: false, emailRedirectTo: getRecoveryRedirectUrl() },
  })
  return { ok: !error, errorClass: error ? classifyOtpError(error.message) : undefined }
}

/**
 * Member entry point: given a RAW email, normalize, resolve the canonical auth email, and
 * (only if a user exists) send a recovery magic-link. Never throws; always returns an outcome.
 */
export async function requestPasswordRecovery(rawEmail: string, ctx: string = 'member'): Promise<RecoveryOutcome> {
  try {
    const normalized = normalizeEmail(rawEmail)
    if (!normalized) { logReset(ctx, '∅', false, false); return { ok: true, sent: false, authUserFound: false } }
    const canonical = await findCanonicalAuthEmail(createAdminClient(), normalized)
    if (!canonical) { logReset(ctx, maskEmail(normalized), false, false); return { ok: true, sent: false, authUserFound: false } }
    const res = await sendRecovery(canonical)
    logReset(ctx, maskEmail(canonical), true, res.ok, res.errorClass)
    return { ok: true, sent: res.ok, authUserFound: true, errorClass: res.errorClass }
  } catch {
    logReset(ctx, '∅', false, false, 'server_error')
    return { ok: false, sent: false, authUserFound: false, errorClass: 'server_error' }
  }
}

/**
 * Admin entry point: given an auth USER ID, resolve their canonical email and send a
 * recovery magic-link. Uses auth.users directly (no profiles row required), so it works
 * for invited/never-signed-in members. Never returns the token/link.
 */
export async function requestPasswordRecoveryForUserId(userId: string, ctx: string = 'admin'): Promise<RecoveryOutcome> {
  try {
    const admin = createAdminClient()
    const { data, error } = await admin.auth.admin.getUserById(userId)
    const canonical: string | undefined = (data as any)?.user?.email
    if (error || !canonical) { logReset(ctx, '∅', false, false); return { ok: true, sent: false, authUserFound: false } }
    const res = await sendRecovery(canonical)
    logReset(ctx, maskEmail(canonical), true, res.ok, res.errorClass)
    return { ok: true, sent: res.ok, authUserFound: true, errorClass: res.errorClass }
  } catch {
    logReset(ctx, '∅', false, false, 'server_error')
    return { ok: false, sent: false, authUserFound: false, errorClass: 'server_error' }
  }
}
