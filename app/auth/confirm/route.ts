import { createServerClient } from '@supabase/ssr'
import type { CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const tokenHash = searchParams.get('token_hash')
  const type = (searchParams.get('type') ?? 'invite') as 'invite' | 'recovery' | 'email' | 'signup'

  console.log('[auth/confirm] hit — token_hash present:', !!tokenHash, 'type:', type)

  if (!tokenHash) {
    console.error('[auth/confirm] no token_hash — redirecting to login')
    return NextResponse.redirect(`${origin}/login?error=missing_token`)
  }

  const cookieStore = cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )

  // verifyOtp with a valid invite token_hash creates a new session,
  // overwriting any existing session cookie (e.g. the admin session).
  console.log('[auth/confirm] calling verifyOtp...')
  const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })

  if (error) {
    console.error('[auth/confirm] verifyOtp error:', JSON.stringify(error))
    return NextResponse.redirect(`${origin}/login?error=invite_invalid`)
  }

  console.log('[auth/confirm] session established for:', data.user?.email)
  return NextResponse.redirect(`${origin}/onboarding`)
}
