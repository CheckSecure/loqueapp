console.log('[middleware] file is loading')

import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export async function middleware(request: NextRequest) {
  console.log('[middleware] function called for:', request.nextUrl.pathname)

  const { pathname } = request.nextUrl

  if (!pathname.startsWith('/dashboard/admin')) {
    return NextResponse.next()
  }

  console.log('[middleware] /dashboard/admin route hit — checking auth')

  const response = NextResponse.next()

  try {
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

    const {
      data: { user },
    } = await supabase.auth.getUser()

    console.log('[middleware] user email:', user?.email)

    if (!user || user.email !== ADMIN_EMAIL) {
      console.log('[middleware] BLOCKING non-admin — redirecting')
      return NextResponse.redirect(new URL('/dashboard/introductions', request.url))
    }

    console.log('[middleware] admin confirmed — allowing through')
    return response
  } catch (err) {
    console.error('[middleware] ERROR in auth check — blocking:', err)
    return NextResponse.redirect(new URL('/dashboard/introductions', request.url))
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
