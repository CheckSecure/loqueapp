import { createServerClient } from '@supabase/ssr'
import type { CookieOptions } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  console.log('[auth/confirm] route hit, url:', request.url)

  try {
    const { searchParams, origin } = new URL(request.url)
    const tokenHash = searchParams.get('token_hash')
    const type = (searchParams.get('type') ?? 'invite') as 'invite' | 'recovery' | 'email' | 'signup'

    console.log('[auth/confirm] token_hash present:', !!tokenHash, 'type:', type)

    if (!tokenHash) {
      console.error('[auth/confirm] no token_hash — redirecting to login')
      return NextResponse.redirect(`${origin}/login?error=missing_token`)
    }

    // Build the redirect response first so session cookies can be written onto it.
    // Writing to next/headers cookies() in a Route Handler does NOT produce Set-Cookie
    // headers — cookies must be set directly on the response object.
    const response = NextResponse.redirect(`${origin}/onboarding`)

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

    console.log('[auth/confirm] calling verifyOtp...')
    const otpResult = await Promise.race([
      supabase.auth.verifyOtp({ token_hash: tokenHash, type }),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 10_000)),
    ])

    if (otpResult === null) {
      console.error('[auth/confirm] verifyOtp timed out after 10s')
      return NextResponse.redirect(`${origin}/login?error=timeout`)
    }

    const { data, error } = otpResult

    if (error) {
      console.error('[auth/confirm] verifyOtp error:', JSON.stringify(error))
      return NextResponse.redirect(`${origin}/login?error=invite_invalid`)
    }

    // Return the pre-built response — it now carries the new session cookies in
    // its Set-Cookie headers, replacing any existing admin session in the browser.
    console.log('[auth/confirm] session established for:', data.user?.email)
    return response
  } catch (err: any) {
    console.error('[auth/confirm] unhandled error:', err?.message ?? err)
    return NextResponse.redirect(`${new URL(request.url).origin}/login?error=server_error`)
  }
}
