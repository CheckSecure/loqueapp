'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { Mail, CheckCircle, Loader2 } from 'lucide-react'

export default function VerifyEmailPage() {
  const [status, setStatus] = useState<'checking' | 'unverified' | 'verified'>('checking')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    checkVerification()
  }, [])

  async function checkVerification() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      router.push('/login')
      return
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('email_verified')
      .eq('id', user.id)
      .single()

    if (profile?.email_verified) {
      setStatus('verified')
      setTimeout(() => router.push('/dashboard'), 1500)
    } else {
      setStatus('unverified')
    }
  }

  async function sendVerificationEmail() {
    setSending(true)
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: (await supabase.auth.getUser()).data.user?.email!
    })
    setSending(false)
    if (!error) setSent(true)
  }

  if (status === 'checking') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F6FB]">
        <Loader2 className="w-8 h-8 text-slate-400 animate-spin" />
      </div>
    )
  }

  if (status === 'verified') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F5F6FB]">
        <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md text-center">
          <CheckCircle className="w-16 h-16 text-green-600 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-slate-900 mb-2">Email Verified!</h1>
          <p className="text-slate-600">Redirecting to your dashboard...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F5F6FB] px-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full">
        <Mail className="w-16 h-16 text-[#C4922A] mx-auto mb-6" />
        <h1 className="text-2xl font-bold text-slate-900 mb-3 text-center">Verify Your Email</h1>
        <p className="text-slate-600 mb-6 text-center">
          Please check your inbox and click the verification link to access your Andrel dashboard.
        </p>
        
        {sent ? (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
            <p className="text-sm text-green-800 text-center">
              ✓ Verification email sent! Check your inbox.
            </p>
          </div>
        ) : (
          <button
            onClick={sendVerificationEmail}
            disabled={sending}
            className="w-full flex items-center justify-center gap-2 bg-[#1B2850] hover:bg-[#2E4080] text-white font-semibold py-3 rounded-lg transition-colors disabled:opacity-60"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
            {sending ? 'Sending...' : 'Resend Verification Email'}
          </button>
        )}

        <button
          onClick={checkVerification}
          className="w-full mt-3 text-sm text-slate-500 hover:text-slate-700 font-medium"
        >
          I've verified my email
        </button>
      </div>
    </div>
  )
}
