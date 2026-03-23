'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function AuthCallbackPage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const handleCallback = async () => {
      const supabase = createClient()
      const next = searchParams.get('next') ?? '/onboarding'

      // Magic link / invite: Supabase sends access_token + refresh_token as URL hash fragment.
      // Hash fragments are only readable client-side — server route handlers never see them.
      const hash = window.location.hash
      if (hash) {
        const params = new URLSearchParams(hash.replace('#', ''))
        const accessToken = params.get('access_token')
        const refreshToken = params.get('refresh_token')

        if (accessToken && refreshToken) {
          console.log('[auth/callback] hash fragment found, calling setSession')
          const { error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          })
          if (error) {
            console.error('[auth/callback] setSession error:', error.message)
            router.replace('/login?error=session_error')
            return
          }
          console.log('[auth/callback] session set, redirecting to:', next)
          router.replace(next)
          return
        }
      }

      // PKCE code exchange (OAuth / Supabase email confirmation)
      const code = searchParams.get('code')
      if (code) {
        console.log('[auth/callback] code param found, exchanging for session')
        const { error } = await supabase.auth.exchangeCodeForSession(code)
        if (error) {
          console.error('[auth/callback] code exchange error:', error.message)
          router.replace('/login?error=auth_failed')
          return
        }
        router.replace(next)
        return
      }

      // token_hash flow (email OTP)
      const tokenHash = searchParams.get('token_hash')
      const type = searchParams.get('type') as any
      if (tokenHash && type) {
        console.log('[auth/callback] token_hash found, calling verifyOtp')
        const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
        if (error) {
          console.error('[auth/callback] verifyOtp error:', error.message)
          router.replace('/login?error=auth_failed')
          return
        }
        router.replace(next)
        return
      }

      console.error('[auth/callback] no hash, code, or token_hash — redirecting to login')
      router.replace('/login?error=missing_params')
    }

    handleCallback()
  }, [router, searchParams])

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F5F6FB]">
      <p className="text-slate-500 text-sm">Signing you in…</p>
    </div>
  )
}
