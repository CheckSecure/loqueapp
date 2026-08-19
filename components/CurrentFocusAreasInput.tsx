'use client'

import { useState } from 'react'
import { X, Plus } from 'lucide-react'
import {
  MAX_FOCUS_AREAS,
  MAX_FOCUS_AREA_LEN,
  SUGGESTED_FOCUS_AREAS,
  normalizeFocusAreas,
} from '@/lib/profile/focusAreas'

/**
 * Current focus areas — optional multi-tag input (suggested + free-text), capped
 * at MAX_FOCUS_AREAS. Serializes to a hidden `current_focus_areas` field as JSON
 * (comma-safe) that the server normalizes. Optional everywhere; never required.
 */
export default function CurrentFocusAreasInput({
  initial = [],
  name = 'current_focus_areas',
  compact = false,
  onChange,
}: {
  initial?: string[]
  name?: string
  compact?: boolean
  /** Controlled mode: called with the tag list whenever it changes (for forms that
   *  build FormData manually, e.g. onboarding). The hidden input still renders. */
  onChange?: (tags: string[]) => void
}) {
  const [tags, setTags] = useState<string[]>(() => normalizeFocusAreas(initial))
  const [draft, setDraft] = useState('')

  const atMax = tags.length >= MAX_FOCUS_AREAS

  function commit(next: string[]) {
    setTags(next)
    onChange?.(next)
  }

  function add(value: string) {
    const v = value.replace(/\s+/g, ' ').trim()
    if (!v || atMax) return
    // Case-insensitive de-dupe, preserve first casing (mirrors server normalize).
    if (tags.some((t) => t.toLowerCase() === v.toLowerCase())) { setDraft(''); return }
    commit([...tags, v.slice(0, MAX_FOCUS_AREA_LEN)])
    setDraft('')
  }

  function remove(t: string) {
    commit(tags.filter((x) => x !== t))
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add(draft)
    } else if (e.key === 'Backspace' && !draft && tags.length) {
      remove(tags[tags.length - 1])
    }
  }

  const remainingSuggestions = SUGGESTED_FOCUS_AREAS.filter(
    (s) => !tags.some((t) => t.toLowerCase() === s.toLowerCase()),
  )

  return (
    <div>
      {/* Serialized value for the form post (comma-safe JSON; server normalizes). */}
      <input type="hidden" name={name} value={JSON.stringify(tags)} />

      {!compact && (
        <>
          <label className="block text-sm font-semibold text-slate-800 mb-1">
            Current focus areas <span className="text-slate-400 font-normal text-xs">optional</span>
          </label>
          <p className="text-xs text-slate-500 mb-2 leading-relaxed">
            What topics, technologies, industries, or policy areas are especially relevant to you right now?
            These can change over time and help Andrel identify more timely and relevant introductions.
          </p>
        </>
      )}

      {/* Selected chips */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full border border-brand-gold/30 bg-brand-gold-soft/50 px-2.5 py-0.5 text-[13px] font-medium text-brand-navy/85"
            >
              {t}
              <button type="button" onClick={() => remove(t)} className="text-brand-navy/50 hover:text-brand-navy" aria-label={`Remove ${t}`}>
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Free-text input */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={MAX_FOCUS_AREA_LEN}
          disabled={atMax}
          placeholder={atMax ? `Up to ${MAX_FOCUS_AREAS} focus areas` : 'Add a focus area, e.g. Nuclear energy'}
          className="flex-1 min-w-0 px-3.5 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1B2850] focus:border-transparent transition disabled:bg-slate-50 disabled:text-slate-400"
        />
        <button
          type="button"
          onClick={() => add(draft)}
          disabled={!draft.trim() || atMax}
          className="inline-flex flex-shrink-0 min-h-[44px] items-center gap-1 px-3 py-2 text-sm font-semibold text-brand-navy border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40"
        >
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>

      {/* Suggested tags */}
      {!atMax && remainingSuggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-1.5 gap-y-5">
          {remainingSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="relative after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-full after:min-w-[44px] after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-[13px] text-slate-600 hover:border-brand-gold/40 hover:text-brand-navy transition-colors"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
