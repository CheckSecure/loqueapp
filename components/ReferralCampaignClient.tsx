'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'

type Breakdown = {
  totalProfiles: number
  activeMembers: number
  eligible: number
  excludedDeactivated: number
  excludedTestDemo: number
  excludedAdminOperator: number
  excludedOnboarding: number
  excludedInvalidEmail: number
  alreadySent: number
}

type Preview = { breakdown: Breakdown; eligibleCount: number; dedupeColumnPresent: boolean; warning?: string }

const ROWS: Array<[keyof Breakdown, string]> = [
  ['totalProfiles', 'Total profiles'],
  ['activeMembers', 'Active members'],
  ['eligible', 'Eligible recipients'],
  ['excludedDeactivated', 'Excluded — deactivated / not active'],
  ['excludedTestDemo', 'Excluded — test / demo accounts'],
  ['excludedAdminOperator', 'Excluded — admin / operator account'],
  ['excludedOnboarding', 'Excluded — onboarding not complete'],
  ['excludedInvalidEmail', 'Excluded — invalid / missing email'],
  ['alreadySent', 'Skipped — already sent (dedupe)'],
]

export default function ReferralCampaignClient() {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState<'' | 'preview' | 'test' | 'send'>('')
  const [msg, setMsg] = useState('')
  const [confirm, setConfirm] = useState('')

  const loadPreview = async () => {
    setBusy('preview'); setMsg('')
    try {
      const res = await fetch('/api/admin/referral-campaign/preview')
      const data = await res.json()
      if (!res.ok) { setMsg(data.error ?? 'Preview failed'); return }
      setPreview(data)
    } finally { setBusy('') }
  }

  const testSend = async () => {
    setBusy('test'); setMsg('')
    try {
      const res = await fetch('/api/admin/referral-campaign/test-send', { method: 'POST' })
      const data = await res.json()
      setMsg(res.ok ? `Test email sent to ${data.sentTo}.` : (data.error ?? 'Test send failed'))
    } finally { setBusy('') }
  }

  const send = async () => {
    if (confirm !== 'SEND') { setMsg("Type SEND to confirm."); return }
    setBusy('send'); setMsg('')
    try {
      const res = await fetch('/api/admin/referral-campaign/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'SEND' }),
      })
      const data = await res.json()
      if (!res.ok) { setMsg(data.error ?? 'Send failed'); return }
      setMsg(`Sent ${data.sent} / attempted ${data.attempted}. Failed: ${data.failed}.`)
      setConfirm('')
      loadPreview()
    } finally { setBusy('') }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Referral campaign</h1>
        <p className="text-slate-500 text-sm mt-1">
          One-time “Help us grow the Andrel network” email to eligible active members. Idempotent and
          resumable — a member is emailed at most once (dedupe via <code>referral_campaign_sent_at</code>).
        </p>
      </div>

      <button
        onClick={loadPreview}
        disabled={busy !== ''}
        className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-[#1B2850] rounded-lg hover:bg-[#2E4080] disabled:opacity-60"
      >
        {busy === 'preview' && <Loader2 className="w-4 h-4 animate-spin" />} Preview eligibility
      </button>

      {preview && (
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-5 space-y-2">
          {!preview.dedupeColumnPresent && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded px-3 py-2">
              {preview.warning}
            </p>
          )}
          <table className="w-full text-sm">
            <tbody>
              {ROWS.map(([k, label]) => (
                <tr key={k} className="border-b border-slate-50 last:border-0">
                  <td className="py-1.5 text-slate-600">{label}</td>
                  <td className="py-1.5 text-right font-semibold text-slate-900 tabular-nums">{preview.breakdown[k]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={testSend}
          disabled={busy !== ''}
          className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-[#1B2850] bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-60"
        >
          {busy === 'test' && <Loader2 className="w-4 h-4 animate-spin" />} Send test to me
        </button>

        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Type SEND"
          className="px-3 py-2 text-sm border border-slate-200 rounded-lg w-32"
        />
        <button
          onClick={send}
          disabled={busy !== '' || confirm !== 'SEND'}
          className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-60"
        >
          {busy === 'send' && <Loader2 className="w-4 h-4 animate-spin" />} Send campaign
        </button>
      </div>

      {msg && <p className="text-sm text-slate-700">{msg}</p>}
    </div>
  )
}
