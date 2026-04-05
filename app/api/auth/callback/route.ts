import { createServerClient } from '@supabase/ssr'
import type { CookieOptions } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const origin = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '') || new URL(request.url).origin
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as 'invite' | 'recovery' | 'email' | 'signup' | null
  const next = searchParams.get('next') ?? '/onboarding'

  const response = NextResponse.redirect(`${origin}${next}`)

  const supabase = createServerClient(
    'https://cyjyutmtsovfnnbbluxc.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5anl1dG10c292Zm5uYmJsdXhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3OTc2ODIsImV4cCI6MjA4OTM3MzY4Mn0.-_yAw3vfssLwS0CGSZLCrrFlTsfGtXHPQmUOtQoF6S4',
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
      return response
    }
    console.error('[auth/callback] code exchange error:', error.message)
  }

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
