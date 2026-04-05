import { createServerClient } from '@supabase/ssr'
import type { CookieOptions } from '@supabase/ssr'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  console.log('[auth/confirm] GET called')
  console.log('[auth/confirm] url:', request.url)

  try {
    const { searchParams } = new URL(request.url)
    const origin = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '') || new URL(request.url).origin
    const tokenHash = searchParams.get('token_hash')
    const type = (searchParams.get('type') ?? 'invite') as 'invite' | 'recovery' | 'email' | 'signup'

    console.log('[auth/confirm] token_hash present:', !!tokenHash, 'type:', type)

    if (!tokenHash) {
      console.error('[auth/confirm] no token_hash — redirecting to login')
      return NextResponse.redirect(`${origin}/login?error=missing_token`)
    }

    const response = NextResponse.redirect(`${origin}/onboarding`)

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

    console.log('[auth/confirm] session established for:', data.user?.email)
    return response
  } catch (err: any) {
    console.error('[auth/confirm] unhandled error:', err?.message ?? err)
    return NextResponse.redirect(`${new URL(request.url).origin}/login?error=server_error`)
  }
}
