'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Sparkles } from 'lucide-react'

/**
 * BatchActionsBar
 *
 * Renders the action bar at the top of the batch review page.
 * Currently: "Generate replacements" button visible when at least one
 * suggestion in the batch has status='dropped'.
 *
 * Server page passes droppedCount and batchId as props. Button calls
 * /api/admin/batch/[batchId]/generate-replacements then refreshes the
 * page so the new generated suggestions appear in their recipient
 * groups.
 */
export default function BatchActionsBar({
  batchId,
  droppedCount,
}: {
  batchId: string
  droppedCount: number
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleGenerate = async () => {
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      const res = await fetch(`/api/admin/batch/${batchId}/generate-replacements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || 'Failed to generate replacements')
        setBusy(false)
        return
      }
      const created = data?.replacementsCreated ?? 0
      const filled = data?.recipientsFilled ?? 0
      const needing = data?.recipientsNeedingFill ?? 0
      if (created === 0) {
        setResult('No strong replacements found for any dropped slots.')
      } else if (filled < needing) {
        setResult(`Added ${created} replacement${created === 1 ? '' : 's'} for ${filled} of ${needing} recipients. ${needing - filled} had no strong matches available.`)
      } else {
        setResult(`Added ${created} replacement${created === 1 ? '' : 's'} across ${filled} recipient${filled === 1 ? '' : 's'}.`)
      }
      router.refresh()
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (droppedCount === 0) return null

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">
            {droppedCount} dropped suggestion{droppedCount === 1 ? '' : 's'}
          </p>
          <p className="text-xs text-slate-600 mt-0.5">
            Click below to fill dropped slots with replacement matches. Replacements remain editable until you approve the batch.
          </p>
        </div>
        <button
          onClick={handleGenerate}
          disabled={busy}
          className="flex-shrink-0 inline-flex items-center gap-2 px-4 py-2 bg-[#1B2850] text-white text-sm font-semibold rounded-lg hover:bg-[#162040] disabled:opacity-60"
        >
          {busy ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Generating
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              Generate replacements
            </>
          )}
        </button>
      </div>
      {result ? (
        <p className="text-xs text-slate-700 mt-3">{result}</p>
      ) : null}
      {error ? (
        <p className="text-xs text-red-600 mt-3">{error}</p>
      ) : null}
    </div>
  )
}
