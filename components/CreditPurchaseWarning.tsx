'use client'

import { useState, useEffect } from 'react'

interface CreditCheckResponse {
  currentBalance: number
  creditsToPurchase: number
  balanceAfterPurchase: number
  cap: number
  usableCredits: number
  willExceedCap: boolean
  unusableCredits: number
  warning: string | null
}

export function CreditPurchaseWarning({ 
  creditsAmount, 
  onProceed 
}: { 
  creditsAmount: number
  onProceed: () => void 
}) {
  const [checkResult, setCheckResult] = useState<CreditCheckResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [showWarning, setShowWarning] = useState(false)

  useEffect(() => {
    async function checkPurchase() {
      setLoading(true)
      try {
        const res = await fetch('/api/billing/check-credit-purchase', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creditsToPurchase: creditsAmount })
        })
        const data = await res.json()
        setCheckResult(data)
        
        if (data.willExceedCap) {
          setShowWarning(true)
        } else {
          onProceed()
        }
      } catch (err) {
        console.error('Credit check failed:', err)
        onProceed()
      } finally {
        setLoading(false)
      }
    }
    
    checkPurchase()
  }, [creditsAmount, onProceed])

  if (loading) {
    return <div className="text-sm text-slate-500">Checking purchase...</div>
  }

  if (!showWarning || !checkResult) {
    return null
  }

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">
          <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-amber-900 mb-1">Credit Cap Notice</h3>
          <p className="text-sm text-amber-800 mb-3">{checkResult.warning}</p>
          <div className="text-xs text-amber-700 space-y-1">
            <div>Current balance: <span className="font-medium">{checkResult.currentBalance} credits</span></div>
            <div>After purchase: <span className="font-medium">{checkResult.usableCredits} usable credits</span> (capped at {checkResult.cap})</div>
          </div>
        </div>
      </div>
      
      <div className="mt-4 flex gap-3">
        <button
          onClick={onProceed}
          className="px-4 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-700"
        >
          I Understand, Proceed
        </button>
        <button
          onClick={() => window.history.back()}
          className="px-4 py-2 bg-white text-amber-900 text-sm font-medium rounded-lg border border-amber-200 hover:bg-amber-50"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
