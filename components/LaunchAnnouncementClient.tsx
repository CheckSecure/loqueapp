'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, AlertTriangle, Mail, Send, CheckCircle, XCircle } from 'lucide-react'

type PreviewResponse = {
  eligible: {
    count: number
    sample: Array<{ full_name: string | null; email: string; created_at: string }>
  }
  ineligible_breakdown: {
    already_sent: number
    status_declined: number
    status_invited: number
    already_active_member: number
    operator_account: number
  }
}

type SendResponse = {
  attempted: number
  sent: number
  failed: number
  failures: Array<{ email: string; error: string }>
}

type TestSendStatus =
  | { state: 'idle' }
  | { state: 'sending' }
  | { state: 'success' }
  | { state: 'error'; message: string }

const BREAKDOWN_LABELS: Record<keyof PreviewResponse['ineligible_breakdown'], string> = {
  already_sent: 'Already received the launch announcement',
  status_declined: 'Waitlist status is declined',
  status_invited: 'Already received the temp-password invite email',
  already_active_member: 'Already an active member',
  operator_account: 'Operator account (bizdev91@gmail.com)',
}

export default function LaunchAnnouncementClient({
  lastSentAt,
  sentCount,
}: {
  lastSentAt: string | null
  sentCount: number
}) {
  const router = useRouter()
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [testSend, setTestSend] = useState<TestSendStatus>({ state: 'idle' })
  const [modalOpen, setModalOpen] = useState(false)
  const [confirmInput, setConfirmInput] = useState('')
  const [bulkSending, setBulkSending] = useState(false)
  const [bulkResult, setBulkResult] = useState<SendResponse | null>(null)
  const [bulkError, setBulkError] = useState<string | null>(null)

  const handlePreview = async () => {
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const res = await fetch('/api/admin/launch-announcement/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setPreviewError(body.error || `Preview failed (${res.status}).`)
        setPreview(null)
        return
      }
      const data = (await res.json()) as PreviewResponse
      setPreview(data)
    } catch (err: any) {
      setPreviewError(err?.message || 'Network error.')
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleTestSend = async () => {
    setTestSend({ state: 'sending' })
    try {
      const res = await fetch('/api/admin/launch-announcement/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.success) {
        setTestSend({ state: 'error', message: body.error || `Test send failed (${res.status}).` })
        return
      }
      setTestSend({ state: 'success' })
    } catch (err: any) {
      setTestSend({ state: 'error', message: err?.message || 'Network error.' })
    }
  }

  const handleConfirmedSend = async () => {
    setBulkSending(true)
    setBulkError(null)
    setBulkResult(null)
    try {
      const res = await fetch('/api/admin/launch-announcement/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'SEND' }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setBulkError(body.error || `Send failed (${res.status}).`)
        return
      }
      setBulkResult(body as SendResponse)
      setModalOpen(false)
      setConfirmInput('')
      // Refresh server-component data so the status banner updates.
      router.refresh()
    } catch (err: any) {
      setBulkError(err?.message || 'Network error.')
    } finally {
      setBulkSending(false)
    }
  }

  const eligibleCount = preview?.eligible.count ?? null
  const canOpenSendModal = eligibleCount !== null && eligibleCount > 0 && !bulkSending

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">Launch announcement</h1>
        <p className="text-slate-500 text-sm mt-2 leading-relaxed">
          One-time email to waitlist members announcing the platform is open.
          Separate from the temp-password invite flow.
        </p>
      </div>

      {lastSentAt && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
          <div className="font-semibold">Launch announcement has been sent before.</div>
          <div className="mt-1">
            Last fire: {new Date(lastSentAt).toLocaleString()} · {sentCount} row{sentCount === 1 ? '' : 's'} marked sent. Eligible recipients exclude anyone already marked.
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 space-y-5">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Step 1 — Preview the recipient set</h2>
          <p className="text-xs text-slate-500 mt-1">Read-only. Returns the count and a sample of the first 10 eligible recipients.</p>
          <button
            type="button"
            onClick={handlePreview}
            disabled={previewLoading}
            className="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-white border border-brand-navy text-brand-navy text-sm font-semibold rounded-xl hover:bg-brand-navy hover:text-white transition-colors disabled:opacity-60"
          >
            {previewLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
            Preview recipients
          </button>
          {previewError && <p className="mt-2 text-xs text-red-600">{previewError}</p>}
        </div>

        {preview && (
          <div className="border-t border-slate-100 pt-5 space-y-4">
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-bold text-brand-navy">{preview.eligible.count}</span>
              <span className="text-sm text-slate-500">eligible recipient{preview.eligible.count === 1 ? '' : 's'}</span>
            </div>

            {preview.eligible.count > 0 ? (
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Sample (first 10)</p>
                <ul className="text-sm space-y-1.5 bg-slate-50 border border-slate-100 rounded-lg p-3">
                  {preview.eligible.sample.map((r) => (
                    <li key={r.email} className="flex justify-between gap-3">
                      <span className="text-slate-700">{r.full_name || '(no name)'} · <span className="text-slate-500">{r.email}</span></span>
                      <span className="text-xs text-slate-400 flex-shrink-0">{new Date(r.created_at).toLocaleDateString()}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-slate-500">No eligible recipients right now. Nothing would be sent.</p>
            )}

            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Ineligible breakdown</p>
              <ul className="text-sm space-y-1 text-slate-600">
                {(Object.keys(preview.ineligible_breakdown) as Array<keyof PreviewResponse['ineligible_breakdown']>).map((key) => (
                  <li key={key} className="flex justify-between">
                    <span>{BREAKDOWN_LABELS[key]}</span>
                    <span className="font-medium text-slate-900">{preview.ineligible_breakdown[key]}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Step 2 — Send test to your inbox</h2>
        <p className="text-xs text-slate-500">
          Fires one email to bizdev91@gmail.com so you can eyeball the rendered HTML. Does not touch the waitlist table.
        </p>
        <button
          type="button"
          onClick={handleTestSend}
          disabled={testSend.state === 'sending'}
          className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 text-slate-700 text-sm font-semibold rounded-xl hover:border-brand-navy hover:text-brand-navy transition-colors disabled:opacity-60"
        >
          {testSend.state === 'sending' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Send test email to me
        </button>
        {testSend.state === 'success' && (
          <p className="text-xs text-emerald-700 flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5" /> Test email sent — check your inbox.
          </p>
        )}
        {testSend.state === 'error' && (
          <p className="text-xs text-red-600 flex items-center gap-1.5">
            <XCircle className="w-3.5 h-3.5" /> {testSend.message}
          </p>
        )}
      </div>

      <div className="bg-white rounded-2xl border-2 border-red-200 shadow-sm p-6 space-y-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <h2 className="text-sm font-semibold text-red-900">Step 3 — Send to all eligible recipients</h2>
            <p className="text-xs text-red-700 mt-1">
              Irreversible. Recipients receive a real email. Run preview and test-send first.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          disabled={!canOpenSendModal}
          className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-sm font-semibold rounded-xl hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Send className="w-4 h-4" />
          {eligibleCount === null
            ? 'Run preview first'
            : eligibleCount === 0
              ? 'Nothing to send'
              : `Send to all ${eligibleCount} recipients`}
        </button>
        {bulkError && <p className="text-xs text-red-600">{bulkError}</p>}
      </div>

      {bulkResult && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 space-y-3">
          <h2 className="text-sm font-semibold text-slate-900">Send result</h2>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="bg-slate-50 rounded-lg p-3">
              <div className="text-2xl font-bold text-slate-900">{bulkResult.attempted}</div>
              <div className="text-xs text-slate-500 uppercase tracking-wider mt-1">Attempted</div>
            </div>
            <div className="bg-emerald-50 rounded-lg p-3">
              <div className="text-2xl font-bold text-emerald-700">{bulkResult.sent}</div>
              <div className="text-xs text-emerald-700 uppercase tracking-wider mt-1">Sent</div>
            </div>
            <div className="bg-red-50 rounded-lg p-3">
              <div className="text-2xl font-bold text-red-700">{bulkResult.failed}</div>
              <div className="text-xs text-red-700 uppercase tracking-wider mt-1">Failed</div>
            </div>
          </div>
          {bulkResult.failures.length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Failures</p>
              <ul className="text-xs space-y-1 bg-red-50 border border-red-100 rounded-lg p-3">
                {bulkResult.failures.map((f, i) => (
                  <li key={`${f.email}-${i}`} className="flex justify-between gap-3">
                    <span className="text-slate-700">{f.email}</span>
                    <span className="text-red-600 truncate">{f.error}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50" role="dialog" aria-modal="true">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl space-y-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="text-base font-bold text-slate-900">Confirm bulk send</h3>
                <p className="text-sm text-slate-600 mt-1">
                  You are about to send the launch announcement email to{' '}
                  <strong>{eligibleCount} recipient{eligibleCount === 1 ? '' : 's'}</strong>. This cannot be undone.
                </p>
              </div>
            </div>
            <label className="block">
              <span className="text-xs font-medium text-slate-700">Type <code className="bg-slate-100 px-1.5 py-0.5 rounded text-slate-900">SEND</code> to confirm</span>
              <input
                type="text"
                autoFocus
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                className="mt-1.5 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
                placeholder="SEND"
              />
            </label>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => { setModalOpen(false); setConfirmInput(''); setBulkError(null) }}
                disabled={bulkSending}
                className="px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-xl transition-colors disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmedSend}
                disabled={confirmInput !== 'SEND' || bulkSending}
                className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-sm font-semibold rounded-xl hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {bulkSending && <Loader2 className="w-4 h-4 animate-spin" />}
                Fire bulk send
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
