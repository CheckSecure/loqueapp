import { createServerClient } from '@supabase/ssr'
import type { CookieOptions } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as 'invite' | 'recovery' | 'email' | 'signup' | null
  const next = searchParams.get('next') ?? '/onboarding'

  const response = NextResponse.redirect(`${origin}${next}`)

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
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

  // PKCE code exchange (standard OAuth / magic link flow)
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      console.log('[auth/callback] code exchange success, redirecting to:', next)
      return response
    }
    console.error('[auth/callback] code exchange error:', error.message)
  }

  // token_hash flow (email OTP, password reset — invites now use /auth/confirm)
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    if (!error) {
      console.log('[auth/callback] token_hash verify success, redirecting to:', next)
      return response
    }
    console.error('[auth/callback] token_hash verify error:', error.message)
  }

  console.error('[auth/callback] no valid code or token_hash — redirecting to login')
  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
