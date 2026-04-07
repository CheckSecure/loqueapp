import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value
        },
        set(name: string, value: string, options: any) {
          request.cookies.set({ name, value, ...options })
          response = NextResponse.next({
            request: { headers: request.headers },
          })
          response.cookies.set({ name, value, ...options })
        },
        remove(name: string, options: any) {
          request.cookies.set({ name, value: '', ...options })
          response = NextResponse.next({
            request: { headers: request.headers },
          })
          response.cookies.set({ name, value: '', ...options })
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // Require email verification for dashboard access
  if (request.nextUrl.pathname.startsWith('/dashboard')) {
    if (!user) {
      return NextResponse.redirect(new URL('/login', request.url))
    }

    // Check if email is verified
    const { data: profile } = await supabase
      .from('profiles')
      .select('email_verified, profile_complete')
      .eq('id', user.id)
      .single()

    // Allow access to verify-email and onboarding pages even if not complete
    if (!profile?.email_verified && !request.nextUrl.pathname.startsWith('/dashboard/verify-email')) {
      return NextResponse.redirect(new URL('/dashboard/verify-email', request.url))
    }

    // Redirect to onboarding if profile not complete
    if (profile?.email_verified && !profile?.profile_complete && !request.nextUrl.pathname.startsWith('/dashboard/onboarding')) {
      return NextResponse.redirect(new URL('/dashboard/onboarding', request.url))
    }
  }

  return response
}

export const config = {
  matcher: ['/dashboard/:path*']
}
