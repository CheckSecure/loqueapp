'use client'

interface UpgradeSuccessScreenProps {
  tier: 'professional' | 'executive'
  onClose: () => void
}

export function UpgradeSuccessScreen({ tier, onClose }: UpgradeSuccessScreenProps) {
  const tierName = tier === 'professional' ? 'Professional' : 'Executive'

  return (
    <div className="fixed inset-0 bg-gradient-to-br from-[#1B2850] to-slate-900 flex items-center justify-center z-50 p-4">
      <div className="max-w-lg w-full text-center">
        {/* Success Icon */}
        <div className="mb-8 flex justify-center">
          <div className="w-20 h-20 bg-emerald-500 rounded-full flex items-center justify-center">
            <svg className="w-12 h-12 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
        </div>

        {/* Main Message */}
        <h1 className="text-4xl font-bold text-white mb-4">
          Your network just expanded
        </h1>
        
        <p className="text-xl text-slate-200 mb-2">
          You're now on the {tierName} plan
        </p>
        
        <p className="text-lg text-slate-300 mb-12">
          You'll start seeing better matches and more introductions right away.
        </p>

        {/* CTA */}
        <button
          onClick={onClose}
          className="px-8 py-4 bg-white text-[#1B2850] font-semibold rounded-lg hover:bg-slate-100 transition text-lg"
        >
          View your introductions
        </button>

        {/* Subtle Note */}
        <p className="text-sm text-slate-400 mt-8">
          Fresh recommendations are being curated for you now
        </p>
      </div>
    </div>
  )
}
