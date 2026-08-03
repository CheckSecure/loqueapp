'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

type Ranked = { name: string | null; email: string | null; count: number }
type Analytics = {
  includeInternal: boolean
  summary: {
    eligibleToReceive: number; originalSent: number; campaignParticipants: number
    campaignAttributedRecommendations: number; allTimeParticipatingMembers: number
    allTimeRecommendations: number; membersWithMultipleRecommendations: number
    invitationsFromCampaign: number; activatedFromCampaign: number
  }
  funnel: { available: boolean; sent: number; recommended: number; recommendations: number; invited: number; joined: number; pct: { recommended: number | null; invited: number | null; joined: number | null } }
  derived: { participationRate: number | null; avgCampaignRecsPerParticipant: number | null; medianDaysToFirstRec: number | null; topCampaignRecommenders: Ranked[]; topAllTimeRecommenders: Ranked[] }
  members: Array<{ full_name: string | null; email: string | null; campaignSentAt: string | null; campaignRecCount: number; allTimeRecCount: number; firstCampaignRecAt: string | null; latestRecAt: string | null; campaignInvitations: number; campaignActivations: number }>
}

const SUMMARY: Array<[keyof Analytics['summary'], string]> = [
  ['eligibleToReceive', 'Eligible to receive original'],
  ['originalSent', 'Original campaign sent'],
  ['campaignParticipants', 'Campaign participants'],
  ['campaignAttributedRecommendations', 'Campaign-attributed recs'],
  ['allTimeParticipatingMembers', 'All-time participating members'],
  ['allTimeRecommendations', 'All-time recommendations'],
  ['membersWithMultipleRecommendations', 'Members w/ multiple recs'],
  ['invitationsFromCampaign', 'Invitations (campaign)'],
  ['activatedFromCampaign', 'Activated (campaign)'],
]

const d = (s: string | null) => (s ? s.slice(0, 10) : '—')
const p = (n: number | null) => (n == null ? 'Not available yet' : `${n}%`)

export default function ReferralCampaignAnalytics() {
  const [data, setData] = useState<Analytics | null>(null)
  const [includeInternal, setIncludeInternal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = async (internal: boolean) => {
    setBusy(true); setErr('')
    try {
      const res = await fetch(`/api/admin/referral-campaign/analytics${internal ? '?include=internal' : ''}`)
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Failed to load analytics'); return }
      setData(json)
    } finally { setBusy(false) }
  }
  useEffect(() => { load(includeInternal) }, [includeInternal])

  const csvHref = `/api/admin/referral-campaign/analytics?format=csv${includeInternal ? '&include=internal' : ''}`

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h2 className="text-xl font-bold text-slate-900">Referral campaign — analytics</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={includeInternal} onChange={(e) => setIncludeInternal(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Include internal/test activity
          </label>
          <a href={csvHref} className="px-3 py-1.5 text-xs font-semibold text-[#1B2850] bg-white border border-slate-200 rounded-lg hover:bg-slate-50">Export CSV</a>
        </div>
      </div>
      <p className="text-xs text-slate-500 -mt-3">Read-only. Campaign-attributed = recommendations submitted <strong>after</strong> that member’s campaign email. All-time = every recommendation, regardless of timing.</p>

      {busy && <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {data && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-3">
            {SUMMARY.map(([k, label]) => (
              <div key={k} className="bg-white rounded-xl border border-slate-100 p-3 text-center">
                <div className="text-2xl font-bold text-slate-900 tabular-nums">{data.summary[k]}</div>
                <div className="text-[11px] text-slate-500 mt-0.5 leading-tight">{label}</div>
              </div>
            ))}
          </div>

          {/* Funnel */}
          <div className="bg-white rounded-xl border border-slate-100 p-5">
            <h3 className="text-sm font-bold text-slate-900 mb-3">Campaign funnel</h3>
            {!data.funnel.available ? (
              <p className="text-sm text-slate-500">Not available yet — no members have been sent the original campaign.</p>
            ) : (
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between"><span>Original campaign sent</span><span className="font-semibold tabular-nums">{data.funnel.sent}</span></div>
                <div className="flex justify-between text-slate-600"><span>↳ Recommended someone after receiving it</span><span className="font-semibold tabular-nums">{data.funnel.recommended} <span className="text-slate-400">({p(data.funnel.pct.recommended)})</span></span></div>
                <div className="flex justify-between text-slate-600"><span>↳ Recommended nominees invited</span><span className="font-semibold tabular-nums">{data.funnel.invited} <span className="text-slate-400">({p(data.funnel.pct.invited)})</span></span></div>
                <div className="flex justify-between text-slate-600"><span>↳ Recommended nominees joined Andrel</span><span className="font-semibold tabular-nums">{data.funnel.joined} <span className="text-slate-400">({p(data.funnel.pct.joined)})</span></span></div>
                <p className="text-[11px] text-slate-400 pt-1">Invited/Joined percentages are relative to the {data.funnel.recommendations} campaign-attributed recommendations / invitations respectively.</p>
              </div>
            )}
          </div>

          {/* Derived metrics */}
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="bg-white rounded-xl border border-slate-100 p-4 text-sm space-y-1.5">
              <div className="flex justify-between"><span className="text-slate-600">Participation rate</span><span className="font-semibold">{p(data.derived.participationRate)}</span></div>
              <div className="flex justify-between"><span className="text-slate-600">Avg campaign recs / participant</span><span className="font-semibold">{data.derived.avgCampaignRecsPerParticipant ?? 'Not available yet'}</span></div>
              <div className="flex justify-between"><span className="text-slate-600">Median days: email → first rec</span><span className="font-semibold">{data.derived.medianDaysToFirstRec ?? 'Not available yet'}</span></div>
            </div>
            <div className="bg-white rounded-xl border border-slate-100 p-4 text-sm">
              <p className="text-slate-600 font-semibold mb-1">Top campaign recommenders</p>
              {data.derived.topCampaignRecommenders.length ? data.derived.topCampaignRecommenders.map((r, i) => (
                <div key={i} className="flex justify-between"><span className="truncate">{r.name || r.email}</span><span className="font-semibold tabular-nums">{r.count}</span></div>
              )) : <p className="text-slate-400 text-xs">None yet</p>}
              <p className="text-slate-600 font-semibold mt-3 mb-1">Top all-time recommenders</p>
              {data.derived.topAllTimeRecommenders.length ? data.derived.topAllTimeRecommenders.map((r, i) => (
                <div key={i} className="flex justify-between"><span className="truncate">{r.name || r.email}</span><span className="font-semibold tabular-nums">{r.count}</span></div>
              )) : <p className="text-slate-400 text-xs">None yet</p>}
            </div>
          </div>

          {/* Per-member table */}
          <div className="bg-white rounded-xl border border-slate-100 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 border-b border-slate-100">
                  {['Name', 'Email', 'Sent', 'Campaign recs', 'All-time recs', 'First campaign rec', 'Latest rec', 'Invites', 'Activated'].map((h) => (
                    <th key={h} className="text-left font-semibold px-3 py-2 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.members.length === 0 && <tr><td colSpan={9} className="px-3 py-4 text-center text-slate-400">No referrers yet</td></tr>}
                {data.members.map((m, i) => (
                  <tr key={i} className="border-b border-slate-50 last:border-0">
                    <td className="px-3 py-2 whitespace-nowrap">{m.full_name || '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500">{m.email}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{d(m.campaignSentAt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.campaignRecCount}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.allTimeRecCount}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{d(m.firstCampaignRecAt)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{d(m.latestRecAt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.campaignInvitations}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.campaignActivations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
