'use client'

import { useEffect, useRef, useState } from 'react'
import { Briefcase, MapPin, X, UserMinus, Ban, MessageSquare, Calendar, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

const AVATAR_COLORS = [
  'bg-[#1B2850]', 'bg-[#2E4080]', 'bg-amber-500', 'bg-rose-500',
  'bg-cyan-600', 'bg-teal-600', 'bg-pink-500', 'bg-slate-600',
]

function pickColor(id) {
  const s = id || ''
  let n = 0
  for (let i = 0; i < s.length; i++) n = n + s.charCodeAt(i)
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}

function getInitials(name) {
  const parts = (name || '?').split(' ')
  const letters = []
  for (let i = 0; i < parts.length && letters.length < 2; i++) {
    if (parts[i][0]) letters.push(parts[i][0])
  }
  return letters.join('').toUpperCase()
}

function normalizeLocation(profile) {
  const city = (profile.city || '').trim()
  const state = (profile.state || '').trim()
  if (city && state) return city + ', ' + state
  if (city) return city
  if (state) return state
  const loc = (profile.location || '').trim()
  return loc || null
}

function cleanLabel(value) {
  if (!value) return null
  const v = String(value).trim()
  if (!v) return null
  if (/\s/.test(v)) return v
  const parts = v.replace(/[-_]+/g, ' ').split(' ')
  const out = []
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i]
    out.push(w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  }
  return out.join(' ')
}

function asStringArray(value) {
  const out = []
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const x = value[i]
      if (typeof x === 'string' && x.trim().length > 0) out.push(x)
    }
    return out
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    if (trimmed.charAt(0) === '[' && trimmed.charAt(trimmed.length - 1) === ']') {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) {
          for (let i = 0; i < parsed.length; i++) {
            const x = parsed[i]
            if (typeof x === 'string' && x.trim().length > 0) out.push(x)
          }
          return out
        }
      } catch (e) {}
      return []
    }
    const pieces = trimmed.split(',')
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i].trim()
      if (p) out.push(p)
    }
    return out
  }
  return []
}

export default function ConnectionDetailModal({ matchId, profile, connectedAt, matchInsights, conversationId, onClose }) {
  const [actionMode, setActionMode] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const router = useRouter()
  const dialogRef = useRef(null)

  useEffect(function() {
    function handleKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return function() { document.removeEventListener('keydown', handleKey) }
  }, [onClose])

  const avatarColor = pickColor(profile.id)
  const initials = getInitials(profile.full_name)
  const connectedDate = connectedAt ? new Date(connectedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null

  const location = normalizeLocation(profile)
  const purposes = asStringArray(profile.purposes)
  const introPrefs = asStringArray(profile.intro_preferences)
  const interests = asStringArray(profile.interests)
  const expertise = asStringArray(profile.expertise)
  const seniority = cleanLabel(profile.seniority)
  const openToMentorship = profile.open_to_mentorship === true
  const openToBusiness = profile.open_to_business_solutions === true
  const linkedin = (typeof profile.linkedin_url === 'string' && profile.linkedin_url.trim()) ? profile.linkedin_url.trim() : null

  async function handleRemove() {
    setSubmitting(true); setError(null)
    try {
      const res = await fetch('/api/network/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ matchId: matchId }) })
      if (!res.ok) { const d = await res.json().catch(function(){ return {} }); setError(d.error || 'Failed to remove connection'); setSubmitting(false); return }
      onClose(); router.refresh()
    } catch (err) { setError((err && err.message) || 'Unexpected error'); setSubmitting(false) }
  }

  async function handleBlock() {
    setSubmitting(true); setError(null)
    try {
      const res = await fetch('/api/network/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ matchId: matchId }) })
      if (!res.ok) { const d = await res.json().catch(function(){ return {} }); setError(d.error || 'Failed to block user'); setSubmitting(false); return }
      onClose(); router.refresh()
    } catch (err) { setError((err && err.message) || 'Unexpected error'); setSubmitting(false) }
  }

  async function handleMessageClick(e) {
    e.preventDefault()
    if (conversationId) {
      onClose()
      router.push('/dashboard/messages/' + conversationId)
      return
    }
    try {
      const res = await fetch('/api/conversations/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: matchId })
      })
      if (!res.ok) { onClose(); router.push('/dashboard/messages'); return }
      const data = await res.json()
      onClose()
      if (data.conversationId) router.push('/dashboard/messages/' + data.conversationId)
      else router.push('/dashboard/messages')
    } catch (err) {
      onClose()
      router.push('/dashboard/messages')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm" onClick={function(e){ if (e.target === e.currentTarget) onClose() }} role="dialog" aria-modal="true">
      <div ref={dialogRef} className="bg-white rounded-2xl shadow-xl max-w-xl w-full max-h-[92vh] overflow-hidden flex flex-col">
        <div className="relative px-8 pt-8 pb-6 border-b border-slate-100">
          <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 w-9 h-9 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"><X className="w-4 h-4" /></button>
          <div className="flex flex-col items-center text-center">
            {profile.avatar_url ? (<img src={profile.avatar_url} alt={profile.full_name} className="w-28 h-28 rounded-full object-cover mb-4 shadow-sm" />) : (<div className={'w-28 h-28 rounded-full ' + avatarColor + ' flex items-center justify-center text-white text-3xl font-bold mb-4 shadow-sm'}>{initials}</div>)}
            <h2 className="text-xl font-semibold text-slate-900">{profile.full_name || 'Connection'}</h2>
            {(profile.title || profile.company) && (<div className="flex items-center gap-1 text-sm text-slate-600 mt-1.5"><Briefcase className="w-3.5 h-3.5 flex-shrink-0" /><span>{[profile.title, profile.company].filter(Boolean).join(' at ')}</span></div>)}
            {location && (<div className="flex items-center gap-1 text-sm text-slate-500 mt-1"><MapPin className="w-3.5 h-3.5 flex-shrink-0" /><span>{location}</span></div>)}
            {connectedDate && (<p className="text-xs text-slate-400 mt-3">Connected {connectedDate}</p>)}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-8 py-6 space-y-6">
          {matchInsights && matchInsights.length > 0 && (<section><h3 className="text-[11px] font-semibold text-[#C4922A] uppercase tracking-wider mb-2">Why you were matched</h3><ul className="text-sm text-slate-700 space-y-1">{matchInsights.map(function(ins, idx){ return (<li key={idx} className="flex items-start gap-2"><span className="text-[#C4922A] mt-0.5">&bull;</span><span>{ins.text}</span></li>) })}</ul></section>)}
          {profile.bio && (<section><h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">About</h3><p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">{profile.bio}</p></section>)}
          {purposes.length > 0 && (<section><h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">What they&apos;re looking to do</h3><div className="flex flex-wrap gap-1.5">{purposes.map(function(p){ return (<span key={p} className="text-xs px-2.5 py-1 rounded-full bg-[#FDF3E3] text-[#C4922A] border border-[#C4922A]/20">{p}</span>) })}</div></section>)}
          {introPrefs.length > 0 && (<section><h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Open to meeting</h3><div className="flex flex-wrap gap-1.5">{introPrefs.map(function(p){ return (<span key={p} className="text-xs px-2.5 py-1 rounded-full bg-[#F5F6FB] text-[#1B2850] border border-[#1B2850]/10">{p}</span>) })}</div></section>)}
          {(openToMentorship || openToBusiness) && (<section><ul className="text-sm text-slate-600 space-y-1">{openToMentorship && (<li className="flex items-center gap-2"><span className="w-1 h-1 rounded-full bg-slate-400" />Open to mentorship</li>)}{openToBusiness && (<li className="flex items-center gap-2"><span className="w-1 h-1 rounded-full bg-slate-400" />Open to business opportunities</li>)}</ul></section>)}
          {(seniority || expertise.length > 0) && (<section><h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Professional context</h3>{seniority && (<p className="text-sm text-slate-700 mb-2">{seniority}</p>)}{expertise.length > 0 && (<div className="flex flex-wrap gap-1.5">{expertise.slice(0, 12).map(function(tag){ return (<span key={tag} className="text-xs px-2.5 py-1 rounded-full bg-slate-50 text-slate-600 border border-slate-100">{tag}</span>) })}</div>)}</section>)}
          {interests.length > 0 && (<section><h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Interests</h3><p className="text-sm text-slate-600">{interests.join(' \u00b7 ')}</p></section>)}
          {linkedin && (<section><a href={linkedin} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-[#1B2850] hover:text-[#2E4080] transition-colors"><ExternalLink className="w-3.5 h-3.5" />View LinkedIn</a></section>)}
          {actionMode === 'remove' && (<section className="bg-amber-50/60 border border-amber-200 rounded-xl p-4"><p className="text-sm font-semibold text-amber-900 mb-1">Remove from your network?</p><p className="text-xs text-amber-900/80 leading-relaxed">You won&apos;t see each other in your network, but you may be reintroduced in the future. Your past conversation stays intact.</p></section>)}
          {actionMode === 'block' && (<section className="bg-red-50 border border-red-200 rounded-xl p-4"><p className="text-sm font-semibold text-red-900 mb-1">Block this user?</p><p className="text-xs text-red-900/80 leading-relaxed">You will not see each other again on Andrel. Existing conversations will be hidden. This is stronger than remove.</p></section>)}
          {error && (<p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>)}
        </div>
        <div className="px-8 py-5 border-t border-slate-100 bg-slate-50/50 space-y-3">
          {actionMode === null && (<><div className="flex gap-2"><button type="button" onClick={handleMessageClick} className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-[#1B2850] text-white text-sm font-semibold rounded-lg hover:bg-[#162040] transition-colors"><MessageSquare className="w-4 h-4" /> Message</button><Link href={`/dashboard/meetings?schedule=1&with=${profile.id}`} className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 border border-slate-200 text-slate-700 text-sm font-semibold rounded-lg bg-white hover:bg-slate-50 transition-colors"><Calendar className="w-4 h-4" /> Schedule</Link></div><div className="flex gap-3 justify-center pt-2 border-t border-slate-200/70"><button onClick={function(){ setActionMode('remove') }} className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 transition-colors px-2 py-1"><UserMinus className="w-3.5 h-3.5" /> Remove from network</button><span className="text-slate-200" aria-hidden="true">\u00b7</span><button onClick={function(){ setActionMode('block') }} className="flex items-center gap-1.5 text-xs font-medium text-red-600/80 hover:text-red-700 transition-colors px-2 py-1"><Ban className="w-3.5 h-3.5" /> Block user</button></div></>)}
          {actionMode === 'remove' && (<div className="flex gap-2 justify-end"><button onClick={function(){ setActionMode(null); setError(null) }} disabled={submitting} className="px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50">Cancel</button><button onClick={handleRemove} disabled={submitting} className="px-4 py-2.5 text-sm font-semibold text-white bg-amber-700 hover:bg-amber-800 rounded-lg transition-colors disabled:opacity-50">{submitting ? 'Removing...' : 'Confirm remove'}</button></div>)}
          {actionMode === 'block' && (<div className="flex gap-2 justify-end"><button onClick={function(){ setActionMode(null); setError(null) }} disabled={submitting} className="px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50">Cancel</button><button onClick={handleBlock} disabled={submitting} className="px-4 py-2.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50">{submitting ? 'Blocking...' : 'Confirm block'}</button></div>)}
        </div>
      </div>
    </div>
  )
}
