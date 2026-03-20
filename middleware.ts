import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (!pathname.startsWith('/dashboard/admin')) {
    return NextResponse.next()
  }

  const response = NextResponse.next()

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
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

    console.log('[middleware] /dashboard/admin — user email:', user?.email)

    if (!user || user.email !== ADMIN_EMAIL) {
      console.log('[middleware] blocking non-admin, redirecting')
      return NextResponse.redirect(new URL('/dashboard/introductions', request.url))
    }

    return response
  } catch (err) {
    console.error('[middleware] auth error, blocking request:', err)
    return NextResponse.redirect(new URL('/dashboard/introductions', request.url))
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
