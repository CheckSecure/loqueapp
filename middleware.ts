import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { dashboardRedirect } from '@/lib/auth/dashboardGate'

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

    // A3: read the caller's OWN gate fields via the self-only RPC (base-table SELECT is revoked).
    const { data: myRows, error: profileError } = await supabase.rpc('get_my_profile')

    // FAIL CLOSED ON ERROR. This previously discarded `error`, so a transient RPC failure produced
    // `profile = null`, which dashboardRedirect reads as "no profile" — and a fully onboarded member
    // was redirected into onboarding by a blip. ZERO ROWS is a real, expected state (a mid-onboarding
    // invitee); an ERROR is not, and the two must never be conflated. On error we let the request
    // through untouched: the page itself re-reads the profile and renders its own retryable state,
    // which is strictly better than sending a complete member somewhere they do not belong.
    if (profileError) {
      console.error(JSON.stringify({ event: 'middleware_profile_rpc_failed', code: (profileError as { code?: string }).code ?? 'unknown' }))
      return response
    }

    const profile = Array.isArray(myRows) ? (myRows[0] ?? null) : (myRows ?? null)

    // Single source of truth for the reset/onboarding routing decision (unit-tested).
    const dest = dashboardRedirect(profile, request.nextUrl.pathname)
    if (dest) {
      return NextResponse.redirect(new URL(dest, request.url))
    }
  }

  return response
}

export const config = {
  matcher: ['/dashboard/:path*']
}
