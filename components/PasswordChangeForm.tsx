'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Eye, EyeOff, Loader2, CheckCircle, Shield, AlertTriangle } from 'lucide-react'

export default function PasswordChangeForm() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    if (newPassword.length < 8) { setError('New password must be at least 8 characters'); return }
    if (newPassword !== confirmPassword) { setError('Passwords do not match'); return }
    setSaving(true)
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user?.email) { setError('Not authenticated'); setSaving(false); return }
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: user.email, password: currentPassword })
    if (signInError) { setError('Current password is incorrect'); setSaving(false); return }
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword })
    setSaving(false)
    if (updateError) { setError(updateError.message); return }
    setSuccess(true)
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setTimeout(() => setSuccess(false), 4000)
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-[#1B2850]" />
          <h2 className="text-sm font-semibold text-slate-900">Change Password</h2>
        </div>
      </div>
      <form onSubmit={handleChangePassword} className="px-6 py-5 space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Current password</label>
          <div className="relative">
            <input type={showCurrent ? 'text' : 'password'} value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required placeholder="Enter current password" className="w-full px-3.5 py-2.5 pr-10 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition" />
            <button type="button" onClick={() => setShowCurrent(!showCurrent)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              {showCurrent ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">New password</label>
          <div className="relative">
            <input type={showNew ? 'text' : 'password'} value={newPassword} onChange={e => setNewPassword(e.target.value)} required placeholder="At least 8 characters" className="w-full px-3.5 py-2.5 pr-10 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition" />
            <button type="button" onClick={() => setShowNew(!showNew)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Confirm new password</label>
          <div className="relative">
            <input type={showConfirm ? 'text' : 'password'} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required placeholder="Re-enter new password" className="w-full px-3.5 py-2.5 pr-10 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition" />
            <button type="button" onClick={() => setShowConfirm(!showConfirm)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 px-4 py-3 rounded-lg">{error}</p>}
        {success && (
          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 px-4 py-3 rounded-lg">
            <CheckCircle className="w-4 h-4 flex-shrink-0" />
            Password updated successfully.
          </div>
        )}
        <button type="submit" disabled={saving} className="flex items-center justify-center gap-2 bg-[#1B2850] text-white text-sm font-semibold px-5 py-2.5 rounded-lg hover:bg-[#162040] transition-colors disabled:opacity-60">
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          {saving ? 'Updating...' : 'Update Password'}
        </button>
      </form>
    </div>
  )
}
