'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  TERMS_VERSION_LABEL,
  TERMS_EFFECTIVE_DATE,
  PRIVACY_VERSION_LABEL,
  PRIVACY_EFFECTIVE_DATE,
} from '@/lib/legal/terms'

/**
 * Clickwrap acceptance form. Both boxes must be affirmatively checked before the
 * button enables; the server (/api/legal/accept) independently re-verifies, so
 * the client gate is UX, not the security boundary.
 */
export default function AcceptTermsForm({ redirectTo = '/dashboard' }: { redirectTo?: string }) {
  const router = useRouter()
  const [acceptTerms, setAcceptTerms] = useState(false)
  const [acceptPrivacy, setAcceptPrivacy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [signingOut, setSigningOut] = useState(false)
  const bothChecked = acceptTerms && acceptPrivacy

  async function handleSignOut() {
    if (signingOut) return
    setSigningOut(true)
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/')
    router.refresh()
  }

  async function handleSubmit() {
    if (!bothChecked || loading) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/legal/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acceptTerms, acceptPrivacy }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'Something went wrong. Please try again.')
        setLoading(false)
        return
      }
      router.replace(redirectTo)
      router.refresh()
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="space-y-5">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={acceptTerms}
          onChange={(e) => setAcceptTerms(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[#1B2850] focus:ring-[#1B2850]"
        />
        <span className="text-sm text-slate-600">
          I have read and agree to the{' '}
          <Link href="/terms" target="_blank" className="text-[#1B2850] underline">Terms of Service</Link>{' '}
          <span className="text-slate-400">(v{TERMS_VERSION_LABEL}, effective {TERMS_EFFECTIVE_DATE})</span>.
        </span>
      </label>

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={acceptPrivacy}
          onChange={(e) => setAcceptPrivacy(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[#1B2850] focus:ring-[#1B2850]"
        />
        <span className="text-sm text-slate-600">
          I have read and agree to the{' '}
          <Link href="/privacy" target="_blank" className="text-[#1B2850] underline">Privacy Policy</Link>{' '}
          <span className="text-slate-400">(v{PRIVACY_VERSION_LABEL}, effective {PRIVACY_EFFECTIVE_DATE})</span>.
        </span>
      </label>

      {error && <p className="text-sm text-rose-600">{error}</p>}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!bothChecked || loading}
        className="w-full rounded-lg bg-[#1B2850] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#141d3a] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {loading ? 'Saving…' : 'Continue'}
      </button>

      <p className="text-xs text-slate-400 text-center">
        Accepting is required to continue using Andrel. You can sign out below, and you&apos;re
        welcome to{' '}
        <a
          href="mailto:support@andrel.app?subject=Account%20question"
          className="text-slate-500 underline hover:text-[#1B2850]"
        >
          contact us
        </a>{' '}
        with any account questions or deletion requests.
      </p>

      <div className="text-center">
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="text-sm text-slate-500 underline hover:text-[#1B2850] disabled:opacity-50"
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </div>
  )
}
