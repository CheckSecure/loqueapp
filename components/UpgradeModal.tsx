'use client'

import { useRouter } from 'next/navigation'
import { X, Zap } from 'lucide-react'

interface UpgradeModalProps {
  onClose: () => void
}

export default function UpgradeModal({ onClose }: UpgradeModalProps) {
  const router = useRouter()

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="w-10 h-10 rounded-xl bg-[#1B2850] flex items-center justify-center mb-4">
          <Zap className="w-5 h-5 text-white" />
        </div>

        <h2 className="text-lg font-bold text-slate-900 mb-2">Unlock more with Professional</h2>
        <p className="text-sm text-slate-500 leading-relaxed mb-6">
          Professional members receive priority matching, more curated introductions each week, and increased visibility in the network — giving you access to higher-quality connections faster.
        </p>

        <div className="space-y-2 mb-6">
          {[
            'More curated introductions each week',
            'Priority matching with high-value members',
            '15 credits per month',
            'Increased visibility in the network',
          ].map(f => (
            <div key={f} className="flex items-center gap-2.5">
              <div className="w-1.5 h-1.5 rounded-full bg-[#C4922A] flex-shrink-0" />
              <p className="text-sm text-slate-600">{f}</p>
            </div>
          ))}
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
          >
            Maybe later
          </button>
          <button
            onClick={() => router.push('/dashboard/billing')}
            className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-[#1B2850] rounded-lg hover:bg-[#162040] transition-colors"
          >
            Upgrade to Professional
          </button>
        </div>
      </div>
    </div>
  )
}
