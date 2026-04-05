console.log('[middleware] file is loading - DISABLED FOR DEPLOYMENT')

import { NextResponse } from 'next/server'

// Middleware temporarily disabled - allow all requests through
export function middleware() {
  return NextResponse.next()
}

export const config = {
  matcher: [],  // Don't run on any routes
}
