console.log('[middleware] file is loading')

import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'

// Force Node.js runtime instead of Edge
export const runtime = 'nodejs'

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
