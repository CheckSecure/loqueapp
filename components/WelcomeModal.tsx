'use client'

import { useEffect, useState } from 'react'

const STORAGE_KEY = 'andrel_welcome_modal_dismissed_v1'

export default function WelcomeModal() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      setVisible(true)
    }
  }, [])

  function dismiss() {
    localStorage.setItem(STORAGE_KEY, '1')
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-8 relative">
        <h2 className="text-2xl font-bold text-slate-900 mb-3">Welcome to Andrel</h2>
        <p className="text-slate-600 text-sm leading-relaxed mb-4">You&apos;re among the first members of the Andrel community, and your participation will help shape the network as it grows.</p>
        <p className="text-slate-600 text-sm leading-relaxed mb-4">Andrel is a curated professional network — not a search platform.</p>
        <p className="text-slate-600 text-sm leading-relaxed mb-4">You&apos;ll receive a small number of curated introductions based on your background, interests, and professional goals.</p>
        <p className="text-slate-600 text-sm leading-relaxed mb-4">If you&apos;re interested in connecting with someone, you can express interest. When interest is mutual, Andrel facilitates the introduction.</p>
        <p className="text-slate-600 text-sm leading-relaxed mb-4">You&apos;ll have a limited number of introduction requests available at any given time. The goal is to encourage thoughtful, high-quality connections rather than volume.</p>
        <p className="text-slate-600 text-sm leading-relaxed mb-6">The goal is simple: connect you with the right people — not more people.</p>
        <button
          onClick={dismiss}
          className="w-full py-3 px-6 bg-[#1B2850] text-white font-semibold rounded-lg hover:bg-[#2a3a6b] transition"
        >
          Got it
        </button>
      </div>
    </div>
  )
}
