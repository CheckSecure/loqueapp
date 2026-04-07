'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Loader2, CheckCircle, Mail, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react'

export default function EmailChangeForm() {
  const [isOpen, setIsOpen] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [emailPassword, setEmailPassword] = useState('')
  const [emailSaving, setEmailSaving] = useState(false)
  const [emailSuccess, setEmailSuccess] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)

  const handleChangeEmail = async (e: React.FormEvent) => {
    e.preventDefault()
    setEmailError(null)
    setEmailSuccess(false)
    if (!newEmail || !newEmail.includes('@')) { setEmailError('Please enter a valid email address'); return }
    if (!emailPassword) { setEmailError('Please enter your current password to confirm'); return }
    setEmailSaving(true)
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user?.email) { setEmailError('Not authenticated'); setEmailSaving(false); return }
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: emailPassword,
    })
    if (signInError) { setEmailError('Incorrect password'); setEmailSaving(false); return }
    const { error: updateError } = await supabase.auth.updateUser({ email: newEmail })
    if (updateError) { setEmailError(updateError.message); setEmailSaving(false); return }
    await supabase.from('profiles').update({ email: newEmail }).eq('id', user.id)
    setEmailSuccess(true)
    setNewEmail('')
    setEmailPassword('')
    setEmailSaving(false)
    setTimeout(() => {
      setEmailSuccess(false)
      setIsOpen(false)
    }, 3000)
  }

  if (!isOpen) {
    return (
      <section className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <button
          onClick={() => setIsOpen(true)}
          className="w-full px-6 py-4 flex items-center justify-between hover:bg-slate-50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-[#F5F6FB] rounded-lg flex items-center justify-center">
              <Mail className="w-4 h-4 text-[#1B2850]" />
            </div>
            <div className="text-left">
              <h2 className="text-sm font-semibold text-slate-900">Change Email</h2>
              <p className="text-xs text-slate-400">Update your email address</p>
            </div>
          </div>
          <ChevronDown className="w-5 h-5 text-slate-400" />
        </button>
      </section>
    )
  }

  return (
    <section className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <button
        onClick={() => setIsOpen(false)}
        className="w-full px-6 py-4 flex items-center justify-between border-b border-slate-100 hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-[#F5F6FB] rounded-lg flex items-center justify-center">
            <Mail className="w-4 h-4 text-[#1B2850]" />
          </div>
          <div className="text-left">
            <h2 className="text-sm font-semibold text-slate-900">Change Email</h2>
            <p className="text-xs text-slate-400">Update your email address</p>
          </div>
        </div>
        <ChevronUp className="w-5 h-5 text-slate-400" />
      </button>

      <form onSubmit={handleChangeEmail} className="px-6 py-5 space-y-4">
        {emailSuccess && (
          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 px-4 py-3 rounded-lg">
            <CheckCircle className="w-4 h-4 flex-shrink-0" />
            Check your new email address for a confirmation link.
          </div>
        )}
        {emailError && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-100 px-4 py-3 rounded-lg">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            {emailError}
          </div>
        )}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">New email address</label>
          <input
            type="email"
            value={newEmail}
            onChange={e => setNewEmail(e.target.value)}
            placeholder="new@email.com"
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1.5">Current password (to confirm)</label>
          <input
            type="password"
            value={emailPassword}
            onChange={e => setEmailPassword(e.target.value)}
            placeholder="Enter your current password"
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20 focus:border-[#1B2850]"
          />
        </div>
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={emailSaving}
            className="flex items-center gap-2 px-5 py-2 bg-[#1B2850] text-white text-sm font-semibold rounded-lg hover:bg-[#162040] transition-colors disabled:opacity-60"
          >
            {emailSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {emailSaving ? 'Updating…' : 'Update Email'}
          </button>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="px-5 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  )
}
