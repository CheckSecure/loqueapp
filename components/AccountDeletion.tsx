'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Loader2, AlertTriangle } from 'lucide-react'

export default function AccountDeletion() {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE') return
    setDeleting(true)
    const supabase = createClient()
    await supabase.rpc('delete_user_account')
    await supabase.auth.signOut()
    window.location.href = '/'
  }

  return (
    <div className="bg-white rounded-2xl border border-red-100 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-red-100">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-500" />
          <h2 className="text-sm font-semibold text-red-600">Danger Zone</h2>
        </div>
      </div>
      <div className="px-6 py-5">
        <p className="text-sm text-slate-500 mb-4">Permanently delete your account, profile, matches, and messages. This cannot be undone.</p>
        {!showDeleteConfirm ? (
          <button onClick={() => setShowDeleteConfirm(true)} className="px-4 py-2 text-sm font-semibold text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
            Delete My Account
          </button>
        ) : (
          <div className="p-4 bg-red-50 border border-red-200 rounded-xl space-y-3">
            <p className="text-sm font-semibold text-red-700">Are you sure? This is permanent.</p>
            <p className="text-xs text-red-500">Type DELETE to confirm.</p>
            <input
              type="text"
              value={deleteConfirmText}
              onChange={e => setDeleteConfirmText(e.target.value)}
              placeholder="Type DELETE"
              className="w-full px-3 py-2 border border-red-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-400 bg-white"
            />
            <div className="flex gap-3">
              <button onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmText('') }} className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
                Cancel
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deleteConfirmText !== 'DELETE' || deleting}
                className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-40"
              >
                {deleting && <Loader2 className="w-3 h-3 animate-spin" />}
                {deleting ? 'Deleting...' : 'Permanently Delete Account'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
