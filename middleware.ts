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

  if (request.nextUrl.pathname.startsWith('/dashboard')) {
    if (!user) {
      return NextResponse.redirect(new URL('/login', request.url))
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('email_verified, password_reset_required, profile_complete')
      .eq('id', user.id)
      .single()

    // Step 1: Password reset (for invited users)
    if (profile?.email_verified && profile?.password_reset_required && !request.nextUrl.pathname.startsWith('/dashboard/reset-password')) {
      return NextResponse.redirect(new URL('/dashboard/reset-password', request.url))
    }

    // Step 2: Onboarding
    if (profile?.email_verified && !profile?.password_reset_required && !profile?.profile_complete && !request.nextUrl.pathname.startsWith('/dashboard/onboarding')) {
      return NextResponse.redirect(new URL('/dashboard/onboarding', request.url))
    }
  }

  return response
}

export const config = {
  matcher: ['/dashboard/:path*']
}
