'use client'

import { useState } from 'react'
import { Search, CheckCircle2, XCircle, AlertTriangle, Loader2, ExternalLink } from 'lucide-react'

export default function MatchInspectorClient() {
  const [inputA, setInputA] = useState('')
  const [inputB, setInputB] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [actionPending, setActionPending] = useState(null)
  const [confirmAction, setConfirmAction] = useState(null)

  async function handleInspect(e) {
    if (e) e.preventDefault()
    setLoading(true); setError(null); setResult(null)
    try {
      const res = await fetch('/api/admin/inspect-pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userA: inputA, userB: inputB })
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Inspection failed'); return }
      setResult(data)
    } catch (err) {
      setError((err && err.message) || 'Unexpected error')
    } finally { setLoading(false) }
  }

  async function runAction(endpoint, payload, label) {
    setActionPending(label); setError(null)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || (label + ' failed')); return }
      // Refresh inspection after action
      await handleInspect()
    } catch (err) {
      setError((err && err.message) || 'Unexpected error')
    } finally { setActionPending(null); setConfirmAction(null) }
  }

  function renderIdentityCard(u, label) {
    if (!u) return (<div className="p-4 rounded-xl border border-red-200 bg-red-50 text-sm text-red-700">User {label} not found</div>)
    return (
      <div className="p-4 rounded-xl border border-slate-200 bg-white">
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">User {label}</div>
        <div className="text-sm font-semibold text-slate-900">{u.full_name || '(no name)'}</div>
        <div className="text-xs text-slate-500 mt-0.5">{u.email || '(no email)'}</div>
        {(u.title || u.company) && (<div className="text-xs text-slate-600 mt-1">{[u.title, u.company].filter(Boolean).join(' at ')}</div>)}
        <div className="flex flex-wrap gap-1.5 mt-3">
          {u.seniority && (<span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-50 border border-slate-100 text-slate-600">{u.seniority}</span>)}
          {u.subscription_tier && (<span className="text-[11px] px-2 py-0.5 rounded-full bg-[#F5F6FB] border border-[#1B2850]/10 text-[#1B2850]">{u.subscription_tier}</span>)}
          {u.profile_complete ? (<span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-100 text-emerald-700">onboarded</span>) : (<span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 border border-amber-100 text-amber-700">incomplete</span>)}
        </div>
        <div className="mt-3 text-[11px] text-slate-400 break-all">id: {u.id}</div>
      </div>
    )
  }

  function pill(pass) {
    return pass
      ? (<span className="inline-flex items-center gap-1 text-emerald-700 text-xs font-semibold"><CheckCircle2 className="w-3.5 h-3.5" /> PASS</span>)
      : (<span className="inline-flex items-center gap-1 text-red-600 text-xs font-semibold"><XCircle className="w-3.5 h-3.5" /> FAIL</span>)
  }

  const rel = result && result.relationship
  const bothFound = result && result.userA && result.userB

  return (
    <div className="space-y-6">
      <form onSubmit={handleInspect} className="flex flex-col md:flex-row gap-3 items-start md:items-end p-4 bg-white rounded-xl border border-slate-200">
        <div className="flex-1 w-full">
          <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1.5">User A (email or UUID)</label>
          <input value={inputA} onChange={(e) => setInputA(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" placeholder="alice@example.com" />
        </div>
        <div className="flex-1 w-full">
          <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1.5">User B (email or UUID)</label>
          <input value={inputB} onChange={(e) => setInputB(e.target.value)} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm" placeholder="bob@example.com" />
        </div>
        <button type="submit" disabled={loading || !inputA || !inputB} className="flex items-center gap-1.5 px-4 py-2 bg-[#1B2850] text-white text-sm font-semibold rounded-lg hover:bg-[#162040] disabled:opacity-50">
          {loading ? (<><Loader2 className="w-4 h-4 animate-spin" /> Inspecting...</>) : (<><Search className="w-4 h-4" /> Inspect Pair</>)}
        </button>
      </form>

      {error && (<div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>)}

      {result && (
        <div className="space-y-6">
          <div className="grid md:grid-cols-2 gap-4">
            {renderIdentityCard(result.userA, 'A')}
            {renderIdentityCard(result.userB, 'B')}
          </div>

          {bothFound && (
            <div className={'p-5 rounded-xl border ' + (result.canBeRecommendedAtoB ? 'border-emerald-200 bg-emerald-50/50' : 'border-red-200 bg-red-50/50')}>
              <div className="flex items-start gap-3">
                <div className={'w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ' + (result.canBeRecommendedAtoB ? 'bg-emerald-100' : 'bg-red-100')}>
                  {result.canBeRecommendedAtoB ? (<CheckCircle2 className="w-5 h-5 text-emerald-700" />) : (<XCircle className="w-5 h-5 text-red-700" />)}
                </div>
                <div className="flex-1">
                  <div className={'text-base font-semibold ' + (result.canBeRecommendedAtoB ? 'text-emerald-900' : 'text-red-900')}>
                    {result.canBeRecommendedAtoB ? 'Eligible to be recommended' : 'Not eligible'}
                  </div>
                  {!result.canBeRecommendedAtoB && result.primaryFailureReason && typeof result.primaryFailureReason === 'string' && result.primaryFailureReason.trim() !== '' && (
                    <div className="text-sm text-red-800 mt-0.5">
                      <span className="font-medium">Primary reason:</span> {result.primaryFailureReason}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {bothFound && (
            <div className="p-5 rounded-xl border border-slate-200 bg-white">
              <h2 className="text-sm font-semibold text-slate-900 mb-3">Relationship State</h2>
              <ul className="text-sm text-slate-700 space-y-1.5">
                <li>Match status: <span className="font-medium">{rel.matchStatus || 'none'}</span></li>
                {rel.matchId && (<li>Match id: <span className="text-xs text-slate-500 font-mono">{rel.matchId}</span></li>)}
                {rel.matchRemovedAt && (<li>Removed at: <span className="text-slate-600">{new Date(rel.matchRemovedAt).toLocaleString()}</span></li>)}
                <li className="flex items-center gap-2 flex-wrap">Conversation exists: <span className="font-medium">{rel.conversationId ? 'yes' : 'no'}</span>{rel.conversationId && (<><span className="text-xs text-slate-500 font-mono">{rel.conversationId}</span><a href={'/dashboard/messages/' + rel.conversationId} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-[#1B2850] hover:text-[#2E4080]"><ExternalLink className="w-3 h-3" /> Open Conversation</a></>)}</li>
                <li>Blocked: <span className="font-medium">{rel.blockByA || rel.blockByB ? (rel.blockByA && rel.blockByB ? 'mutually blocked' : rel.blockByA ? 'A blocked B' : 'B blocked A') : 'no'}</span></li>
                <li>Intro requests between them: <span className="font-medium">{rel.introRequestsCount}</span>{rel.pendingIntroRequests > 0 && (<span className="ml-2 text-amber-700">({rel.pendingIntroRequests} pending)</span>)}</li>
                {rel.adminFacilitated && (<li className="text-[#1B2850]">Admin-facilitated match</li>)}
              </ul>
            </div>
          )}

          {bothFound && (
            <div className="p-5 rounded-xl border border-slate-200 bg-white">
              <h2 className="text-sm font-semibold text-slate-900 mb-3">Recommendation Eligibility</h2>
              <ul className="space-y-2">
                {result.eligibility.map(function(check, idx){ return (
                  <li key={idx} className="flex items-start gap-3 text-sm">
                    <div className="flex-shrink-0 pt-0.5">{pill(check.pass)}</div>
                    <div>
                      <div className="font-medium text-slate-800">{check.name}</div>
                      <div className="text-xs text-slate-500">{check.explanation}</div>
                    </div>
                  </li>
                ) })}
              </ul>

            </div>
          )}

          {bothFound && (
            <div className="p-5 rounded-xl border border-slate-200 bg-white">
              <h2 className="text-sm font-semibold text-slate-900 mb-3">Why they would be introduced</h2>
              {result.insights.length > 0 ? (
                <ul className="text-sm text-slate-700 space-y-1">
                  {result.insights.map(function(ins, idx){ return (<li key={idx} className="flex gap-2"><span className="text-[#C4922A]">&bull;</span>{ins.text}</li>) })}
                </ul>
              ) : (<p className="text-sm text-slate-500">No strong insight signals found.</p>)}
            </div>
          )}

          {bothFound && (
            <div className="p-5 rounded-xl border border-slate-200 bg-white">
              <h2 className="text-sm font-semibold text-slate-900 mb-3">Admin Actions</h2>
              {result.recommendedAction && (
                <div className="text-xs font-semibold text-[#C4922A] uppercase tracking-wider mb-2">Recommended action</div>
              )}
              <div className="flex flex-wrap gap-2">
                {(rel.blockByA || rel.blockByB) && (
                  <button onClick={function(){ setConfirmAction('unblock') }} disabled={actionPending !== null} className={'px-3 py-2 text-sm rounded-lg disabled:opacity-50 ' + (result.recommendedAction === 'unblock' ? 'font-semibold text-white bg-amber-700 hover:bg-amber-800 ring-2 ring-[#C4922A]/40' : 'font-medium border border-amber-300 text-amber-800 bg-amber-50 hover:bg-amber-100')}>Remove Block</button>
                )}
                {rel.matchStatus === 'removed' && (
                  <button onClick={function(){ setConfirmAction('restore') }} disabled={actionPending !== null} className={'px-3 py-2 text-sm rounded-lg disabled:opacity-50 ' + (result.recommendedAction === 'restore' ? 'font-semibold text-white bg-[#1B2850] hover:bg-[#162040] ring-2 ring-[#C4922A]/40' : 'font-medium border border-slate-300 text-slate-700 bg-white hover:bg-slate-50')}>Restore Removed Match</button>
                )}
                {rel.matchStatus !== 'active' && !rel.blockByA && !rel.blockByB && (
                  <button onClick={function(){ setConfirmAction('create') }} disabled={actionPending !== null} className={'px-3 py-2 text-sm rounded-lg disabled:opacity-50 ' + (result.recommendedAction === 'create' ? 'font-semibold text-white bg-[#1B2850] hover:bg-[#162040] ring-2 ring-[#C4922A]/40' : 'font-medium border border-slate-300 text-slate-700 bg-white hover:bg-slate-50')}>Propose Introduction</button>
                )}
                {rel.matchId && !rel.conversationId && (
                  <button onClick={function(){ setConfirmAction('createconv') }} disabled={actionPending !== null} className={'px-3 py-2 text-sm rounded-lg disabled:opacity-50 ' + (result.recommendedAction === 'createconv' ? 'font-semibold text-white bg-[#1B2850] hover:bg-[#162040] ring-2 ring-[#C4922A]/40' : 'font-medium border border-slate-300 text-slate-700 bg-white hover:bg-slate-50')}>Create Missing Conversation</button>
                )}
              </div>
              {confirmAction && (
                <div className="mt-4 p-3 border border-amber-200 bg-amber-50/60 rounded-lg">
                  <div className="flex items-start gap-2 mb-3">
                    <AlertTriangle className="w-4 h-4 text-amber-700 mt-0.5" />
                    <div className="text-sm text-amber-900">
                      {confirmAction === 'unblock' && 'Remove block between these users? Either user can re-block later.'}
                      {confirmAction === 'restore' && 'Restore removed match? Both users will see each other in their network again.'}
                      {confirmAction === 'create' && 'Propose an introduction between these two members? They will each have the opportunity to accept or pass.'}
                      {confirmAction === 'createconv' && 'Create missing conversation for this match?'}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={function(){ setConfirmAction(null) }} disabled={actionPending !== null} className="px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-lg disabled:opacity-50">Cancel</button>
                    <button
                      onClick={function(){
                        if (confirmAction === 'unblock') runAction('/api/admin/unblock', { userIdA: result.userA.id, userIdB: result.userB.id }, 'Unblock')
                        else if (confirmAction === 'restore' && rel.matchId) runAction('/api/admin/restore-match', { matchId: rel.matchId }, 'Restore')
                        else if (confirmAction === 'create') runAction('/api/admin/admin-create-match', { userIdA: result.userA.id, userIdB: result.userB.id }, 'Create')
                        else if (confirmAction === 'createconv' && rel.matchId) runAction('/api/admin/create-conversation-for-match', { matchId: rel.matchId }, 'CreateConv')
                      }}
                      disabled={actionPending !== null}
                      className="px-3 py-1.5 text-sm font-semibold text-white bg-amber-700 hover:bg-amber-800 rounded-lg disabled:opacity-50"
                    >
                      {actionPending ? 'Running...' : 'Confirm'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
