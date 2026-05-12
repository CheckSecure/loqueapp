'use client'

import { useState } from 'react'
import { Loader2, Send, Eye, CheckCircle, XCircle, AlertCircle, Users, Clock } from 'lucide-react'

interface ParsedEntry {
  name: string
  email: string
}

interface InvalidEntry {
  raw: string
  reason: string
}

interface PreviewResult {
  ready_to_invite: ParsedEntry[]
  already_member: ParsedEntry[]
  already_waitlisted: ParsedEntry[]
  invalid: InvalidEntry[]
}

interface RowResult {
  email: string
  name: string
  status: 'sent' | 'email_failed' | 'db_failed'
  error?: string
}

interface ExecuteResult {
  sent: number
  email_failed: number
  db_failed: number
  total: number
  results: RowResult[]
}

type Phase = 'compose' | 'previewing' | 'previewed' | 'executing' | 'done'

export default function BulkInviteClient() {
  const [text, setText] = useState('')
  const [isFoundingMember, setIsFoundingMember] = useState(false)
  const [professionType, setProfessionType] = useState('')
  const [phase, setPhase] = useState<Phase>('compose')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [executeResult, setExecuteResult] = useState<ExecuteResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const defaults = {
    isFoundingMember,
    professionType: professionType.trim() || null,
  }

  async function handlePreview() {
    setError(null)
    setPhase('previewing')
    try {
      const res = await fetch('/api/admin/bulk-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', text, defaults }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Preview failed'); setPhase('compose'); return }
      setPreview(data)
      setPhase('previewed')
    } catch (e: any) {
      setError(e.message ?? 'Network error')
      setPhase('compose')
    }
  }

  async function handleExecute() {
    setError(null)
    setPhase('executing')
    try {
      const res = await fetch('/api/admin/bulk-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'execute', text, defaults }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Execute failed'); setPhase('previewed'); return }
      setExecuteResult(data)
      setPhase('done')
    } catch (e: any) {
      setError(e.message ?? 'Network error')
      setPhase('previewed')
    }
  }

  function handleReset() {
    setText('')
    setPreview(null)
    setExecuteResult(null)
    setError(null)
    setPhase('compose')
  }

  const busy = phase === 'previewing' || phase === 'executing'

  return (
    <div className="space-y-6">

      {/* Input area — locked after execute */}
      {phase !== 'done' && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-slate-900">Paste invite list</h2>
            <p className="text-xs text-slate-500 mt-1">
              One entry per line. Accepted formats: <code className="bg-slate-100 px-1 rounded">email@domain.com</code> · <code className="bg-slate-100 px-1 rounded">First Last email@domain.com</code> · <code className="bg-slate-100 px-1 rounded">First Last, email@domain.com</code>
            </p>
          </div>
          <div className="px-6 py-4">
            <textarea
              value={text}
              onChange={e => { setText(e.target.value); if (phase === 'previewed') setPhase('compose') }}
              disabled={busy}
              rows={10}
              placeholder={'alice@firm.com\nBob Smith bob@corp.com\nCarol Jones, carol@co.com'}
              className="w-full font-mono text-sm border border-slate-200 rounded-xl px-4 py-3 resize-y focus:outline-none focus:ring-2 focus:ring-brand-navy/20 disabled:opacity-60 text-slate-800 placeholder-slate-400"
            />
          </div>

          {/* Batch defaults */}
          <div className="px-6 pb-4 flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isFoundingMember}
                onChange={e => setIsFoundingMember(e.target.checked)}
                disabled={busy}
                className="w-4 h-4 rounded border-slate-300 accent-brand-navy"
              />
              Founding member
            </label>
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-700 shrink-0">Profession type</label>
              <input
                type="text"
                value={professionType}
                onChange={e => setProfessionType(e.target.value)}
                disabled={busy}
                placeholder="attorney, executive, consultant…"
                className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-navy/20 disabled:opacity-60 w-52"
              />
            </div>
          </div>

          {/* Preview button */}
          <div className="px-6 pb-5 flex items-center gap-3">
            <button
              onClick={handlePreview}
              disabled={busy || !text.trim()}
              className="flex items-center gap-2 px-5 py-2.5 bg-slate-800 text-white text-sm font-semibold rounded-xl hover:bg-slate-700 transition-colors disabled:opacity-50"
            >
              {phase === 'previewing' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
              Preview
            </button>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        </div>
      )}

      {/* Preview results */}
      {preview && phase !== 'done' && (
        <div className="space-y-4">
          <PreviewSection
            title="Ready to invite"
            count={preview.ready_to_invite.length}
            items={preview.ready_to_invite.map(e => `${e.name ? e.name + ' — ' : ''}${e.email}`)}
            variant="ready"
          />
          {preview.already_member.length > 0 && (
            <PreviewSection
              title="Already a member"
              count={preview.already_member.length}
              items={preview.already_member.map(e => e.email)}
              variant="skip"
            />
          )}
          {preview.already_waitlisted.length > 0 && (
            <PreviewSection
              title="Already on waitlist"
              count={preview.already_waitlisted.length}
              items={preview.already_waitlisted.map(e => e.email)}
              variant="skip"
            />
          )}
          {preview.invalid.length > 0 && (
            <PreviewSection
              title="Invalid / unparseable"
              count={preview.invalid.length}
              items={preview.invalid.map(e => `${e.raw} — ${e.reason}`)}
              variant="error"
            />
          )}

          {/* Send button — only if there are rows to send */}
          {preview.ready_to_invite.length > 0 && (
            <div className="flex items-center gap-3">
              <button
                onClick={handleExecute}
                disabled={phase === 'executing'}
                className="flex items-center gap-2 px-6 py-2.5 bg-brand-navy text-white text-sm font-semibold rounded-xl hover:bg-[#14203d] transition-colors disabled:opacity-60"
              >
                {phase === 'executing'
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</>
                  : <><Send className="w-4 h-4" /> Send {preview.ready_to_invite.length} invite{preview.ready_to_invite.length !== 1 ? 's' : ''}</>
                }
              </button>
              {phase === 'executing' && (
                <p className="text-sm text-slate-500 flex items-center gap-1.5">
                  <Clock className="w-4 h-4" /> Sending serialised — may take 15–30s for large batches
                </p>
              )}
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          )}

          {preview.ready_to_invite.length === 0 && (
            <p className="text-sm text-slate-500">No new invites to send — all entries are already members, waitlisted, or invalid.</p>
          )}
        </div>
      )}

      {/* Execute results */}
      {executeResult && phase === 'done' && (
        <div className="space-y-4">
          {/* Summary banner */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm px-6 py-5">
            <div className="flex items-center gap-3 mb-4">
              <CheckCircle className="w-5 h-5 text-green-500 shrink-0" />
              <h2 className="text-sm font-semibold text-slate-900">Batch complete</h2>
            </div>
            <div className="grid grid-cols-3 gap-4 text-center">
              <Stat label="Sent" value={executeResult.sent} color="text-green-600" />
              <Stat label="Email failed" value={executeResult.email_failed} color={executeResult.email_failed > 0 ? 'text-amber-600' : 'text-slate-400'} />
              <Stat label="DB failed" value={executeResult.db_failed} color={executeResult.db_failed > 0 ? 'text-red-600' : 'text-slate-400'} />
            </div>
          </div>

          {/* Per-row failures for copy/retry */}
          {executeResult.results.filter(r => r.status !== 'sent').length > 0 && (
            <div className="bg-white rounded-2xl border border-amber-100 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-amber-100">
                <h3 className="text-sm font-semibold text-amber-800">Failed rows — copy to retry</h3>
                <p className="text-xs text-amber-600 mt-1">Email-failed rows had no auth user created and can be retried safely. DB-failed rows had emails sent — see logs.</p>
              </div>
              <ul className="divide-y divide-slate-100">
                {executeResult.results.filter(r => r.status !== 'sent').map(r => (
                  <li key={r.email} className="px-6 py-3 flex items-start gap-3">
                    <span className={`mt-0.5 shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${r.status === 'email_failed' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>
                      {r.status === 'email_failed' ? 'email failed' : 'db failed'}
                    </span>
                    <div>
                      <p className="text-sm font-mono text-slate-800">{r.email}{r.name ? ` (${r.name})` : ''}</p>
                      {r.error && <p className="text-xs text-slate-500 mt-0.5">{r.error}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            onClick={handleReset}
            className="text-sm text-slate-500 hover:text-slate-700 underline"
          >
            Start new batch
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PreviewSection({
  title, count, items, variant
}: {
  title: string
  count: number
  items: string[]
  variant: 'ready' | 'skip' | 'error'
}) {
  const colors = {
    ready: { header: 'bg-green-50 border-green-100', badge: 'bg-green-100 text-green-700', icon: <CheckCircle className="w-4 h-4 text-green-500" />, text: 'text-slate-700' },
    skip: { header: 'bg-slate-50 border-slate-100', badge: 'bg-slate-100 text-slate-500', icon: <Users className="w-4 h-4 text-slate-400" />, text: 'text-slate-500' },
    error: { header: 'bg-red-50 border-red-100', badge: 'bg-red-100 text-red-600', icon: <XCircle className="w-4 h-4 text-red-400" />, text: 'text-red-600' },
  }[variant]

  return (
    <div className={`bg-white rounded-2xl border shadow-sm overflow-hidden`}>
      <div className={`px-5 py-3 border-b ${colors.header} flex items-center gap-2`}>
        {colors.icon}
        <span className="text-sm font-semibold text-slate-800">{title}</span>
        <span className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded-full ${colors.badge}`}>{count}</span>
      </div>
      {count > 0 && (
        <ul className="px-5 py-3 space-y-1">
          {items.map((item, i) => (
            <li key={i} className={`text-sm font-mono ${colors.text}`}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-xs text-slate-500 mt-0.5">{label}</p>
    </div>
  )
}
