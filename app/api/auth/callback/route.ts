import { createServerClient } from '@supabase/ssr'
import type { CookieOptions } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeEmail } from '@/lib/auth/normalizeEmail'

/**
 * Best-effort: reconcile the denormalized profiles.email mirror to the now-verified auth email after a
 * successful auth callback (covers the email-change confirmation landing). service_role write scoped to
 * the session user's own row. Browser UPDATE on profiles is revoked (migration 055). Never blocks/throws.
 */
async function mirrorAuthEmail(supabase: ReturnType<typeof createServerClient>) {
  try {
    const { data: { user } } = await supabase.auth.getUser()
    const email = normalizeEmail(user?.email ?? '')
    if (!user || !email) return
    const admin = createAdminClient()
    const { data: current } = await admin.from('profiles').select('email').eq('id', user.id).maybeSingle()
    if (current && normalizeEmail(current.email ?? '') === email) return // already in sync
    await admin.from('profiles').update({ email, updated_at: new Date().toISOString() }).eq('id', user.id)
  } catch (e: any) {
    console.error('[auth/callback] email mirror non-fatal:', e?.name || 'error')
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const origin = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '') || new URL(request.url).origin
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as 'invite' | 'recovery' | 'email' | 'signup' | null
  const next = searchParams.get('next') ?? '/onboarding'

  const response = NextResponse.redirect(`${origin}${next}`)

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      console.log('[auth/callback] code exchange success, redirecting to:', next)
      await mirrorAuthEmail(supabase)
      return response
    }
    console.error('[auth/callback] code exchange error:', error.message)
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    if (!error) {
      console.log('[auth/callback] token_hash verify success, redirecting to:', next)
      await mirrorAuthEmail(supabase)
      return response
    }
    console.error('[auth/callback] token_hash verify error:', error.message)
  }

  console.error('[auth/callback] no valid code or token_hash — redirecting to login')
  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
