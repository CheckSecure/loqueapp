'use client'

interface UpgradeConfirmationModalProps {
  tier: 'professional' | 'executive'
  onClose: () => void
  onConfirm: () => void
}

export function UpgradeConfirmationModal({ tier, onClose, onConfirm }: UpgradeConfirmationModalProps) {
  const tierDetails = {
    professional: {
      name: 'Professional',
      price: '$49',
      credits: '10'
    },
    executive: {
      name: 'Executive',
      price: '$99',
      credits: '20'
    }
  }

  const details = tierDetails[tier]

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-8 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <div className="mb-6">
          <h2 className="text-2xl font-bold text-slate-900 mb-2">
            You're upgrading your access
          </h2>
          <p className="text-slate-600">
            You'll start seeing higher-quality introductions and more opportunities to connect.
          </p>
        </div>

        <div className="bg-slate-50 rounded-xl p-6 mb-6">
          <div className="flex justify-between items-center mb-3">
            <span className="text-slate-700 font-semibold">{details.name} Plan</span>
            <span className="text-2xl font-bold text-slate-900">{details.price}</span>
          </div>
          <div className="text-sm text-slate-500 mb-4">
            Billed monthly
          </div>
          <div className="border-t border-slate-200 pt-4">
            <div className="flex items-center text-sm text-slate-600">
              <svg className="w-5 h-5 text-emerald-600 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {details.credits} introduction credits per month
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <button
            onClick={onConfirm}
            className="w-full py-3 px-6 bg-[#1B2850] text-white font-semibold rounded-lg hover:bg-[#2a3a6b] transition"
          >
            Confirm upgrade
          </button>
          <button
            onClick={onClose}
            className="w-full py-3 px-6 border border-slate-300 text-slate-700 font-semibold rounded-lg hover:bg-slate-50 transition"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
