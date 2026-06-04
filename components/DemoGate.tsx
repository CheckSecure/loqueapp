'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/Button'

const STORAGE_KEY = 'andrel-demo-unlocked'

const CTA_BASE =
  'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-gold focus-visible:ring-offset-2 px-6 py-3 text-base'
const CTA_PRIMARY = `${CTA_BASE} bg-brand-navy text-white hover:bg-brand-navy-dark`
const CTA_SECONDARY = `${CTA_BASE} bg-white border border-brand-navy text-brand-navy hover:bg-brand-navy hover:text-white`

export default function DemoGate({ videoUrl }: { videoUrl: string | null }) {
  const [mounted, setMounted] = useState(false)
  const [unlocked, setUnlocked] = useState(false)
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setMounted(true)
    if (sessionStorage.getItem(STORAGE_KEY) === 'true') {
      setUnlocked(true)
    }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (loading) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/demo/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        sessionStorage.setItem(STORAGE_KEY, 'true')
        setUnlocked(true)
        setPassword('')
      } else {
        setError('Incorrect password. Please try again.')
      }
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (!mounted || !unlocked) {
    return (
      <div className="w-full max-w-md">
        <p className="text-2xl font-bold text-brand-navy tracking-tight text-center mb-8">Andrel</p>
        <div className="bg-white rounded-2xl p-6 lg:p-8 border border-slate-100 shadow-sm">
          <div className="flex items-center justify-center gap-2 text-brand-gold mb-5">
            <Lock className="w-3.5 h-3.5" />
            <span className="text-xs font-semibold uppercase tracking-[0.2em]">Private demo</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 text-center tracking-tight mb-3">
            Private Demo Access
          </h1>
          <p className="text-sm text-slate-500 text-center leading-relaxed mb-6">
            This demo is available to prospective founding members and invited guests.
          </p>
          <form onSubmit={handleSubmit} className="space-y-3" noValidate>
            <label htmlFor="demo-password" className="sr-only">Password</label>
            <input
              id="demo-password"
              type="password"
              required
              autoFocus
              autoComplete="off"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter access password"
              className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-gold focus:border-transparent transition"
            />
            <div role="alert" aria-live="polite" className="min-h-[1.25rem] text-xs text-red-600 px-1">
              {error}
            </div>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={loading || password.length === 0}
              className="w-full"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              Unlock
            </Button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full max-w-4xl">
      <p className="text-2xl font-bold text-brand-navy tracking-tight text-center mb-8">Andrel</p>
      <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-slate-900 text-center tracking-tight leading-tight mb-4">
        See how <span className="text-brand-gold">Andrel</span> works
      </h1>
      <p className="text-base sm:text-lg text-slate-500 text-center leading-relaxed max-w-2xl mx-auto mb-10">
        Andrel is an invite-only professional network built around thoughtful introductions, mutual interest, and meaningful professional relationships.
      </p>

      <div className="mb-10">
        {videoUrl ? (
          <video
            controls
            preload="metadata"
            src={videoUrl}
            className="w-full rounded-lg shadow-lg"
          />
        ) : (
          <div className="bg-white rounded-2xl p-12 border border-slate-100 shadow-sm text-center">
            <p className="text-sm text-slate-500">Demo video coming soon.</p>
          </div>
        )}
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3">
        <Link href="/" className={CTA_PRIMARY}>
          Join the Waitlist
        </Link>
        <Link href="/" className={CTA_SECONDARY}>
          Request Access
        </Link>
      </div>
    </div>
  )
}
