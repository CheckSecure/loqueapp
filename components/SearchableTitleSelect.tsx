'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { TITLE_ALIASES, resolveTitlePick, type SearchableTitle } from '@/lib/searchable-titles'
import { titleToCategory } from '@/lib/role-taxonomy'
import { Search, X, ChevronDown, Check } from 'lucide-react'

// Sentinel display label for the "not listed" escape hatch. Selecting it sets
// role_type to the 'Other' taxonomy sentinel (never arbitrary free text), so
// the firewall in lib/searchable-titles.ts stays intact.
const OTHER_LABEL = 'Other (not listed)'

interface SingleProps {
  /** Current stored role_type (must already be in ROLE_CATEGORIES or legacy). */
  roleType: string
  /** Current stored exact_job_title (display override). null = use role_type. */
  exactJobTitle: string | null
  /**
   * Emits the resolved write payload. role_type is ALWAYS a structured value or
   * the 'Other' sentinel — never arbitrary free text. `title` is the derived
   * title label the parent persists to profiles.title: the selected role label
   * for canonical picks, or the trimmed custom role text for 'Other'.
   */
  onChange: (next: { role_type: string; exact_job_title: string | null; title: string }) => void
}

interface MultiProps {
  /** Selected canonical role_type strings (what criteria.role_types stores). */
  values: string[]
  onValuesChange: (values: string[]) => void
}

/**
 * Discriminated union. Omitting `mode` (or mode="single") is the load-bearing
 * single-select used by onboarding + profile edit — unchanged. mode="multiple"
 * is the pill-based multi-select used by opportunity targeting. Existing callers
 * pass no `mode`, so they resolve to SingleProps and are unaffected.
 */
type Props =
  | ({ mode?: 'single' } & SingleProps)
  | ({ mode: 'multiple' } & MultiProps)

export default function SearchableTitleSelect(props: Props) {
  if (props.mode === 'multiple') {
    return <MultiRoleSelect values={props.values} onValuesChange={props.onValuesChange} />
  }
  return (
    <SingleRoleSelect
      roleType={props.roleType}
      exactJobTitle={props.exactJobTitle}
      onChange={props.onChange}
    />
  )
}

/**
 * Searchable role-title combobox for onboarding + profile edit.
 *
 * Two-part state:
 *  - Picker: selects from TITLE_ALIASES (display strings). Resolves to a
 *    structured/legacy role_type via resolveTitlePick.
 *  - Custom-title text input (optional): user can override exact_job_title
 *    with a free-text string while keeping the structured role_type.
 *
 * THE FIREWALL: this component CANNOT write a non-structured value to
 * role_type. The only paths to onChange.role_type are TITLE_ALIASES entries,
 * each of which has its role_type pre-validated against titleToCategory.
 */
function SingleRoleSelect({ roleType, exactJobTitle, onChange }: SingleProps) {
  // Find the TITLE_ALIASES entry whose display matches the user's current display:
  //   - prefer the alias whose role_type === current roleType AND display === exactJobTitle
  //   - fallback: the alias whose role_type matches and display === roleType
  const initial: SearchableTitle | undefined = useMemo(() => {
    if (exactJobTitle) {
      return TITLE_ALIASES.find((e) => e.role_type === roleType && e.display === exactJobTitle)
    }
    return TITLE_ALIASES.find((e) => e.role_type === roleType && e.display === roleType)
  }, [roleType, exactJobTitle])

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [isOther, setIsOther] = useState<boolean>(roleType === 'Other')
  const [pickedDisplay, setPickedDisplay] = useState<string>(
    roleType === 'Other' ? OTHER_LABEL : (initial?.display ?? exactJobTitle ?? roleType ?? '')
  )
  const [customExact, setCustomExact] = useState<string>(
    // Show custom override field only when user has typed an exact title
    // that DOESN'T equal the alias's display string (a true override).
    initial && exactJobTitle && exactJobTitle !== initial.display ? exactJobTitle : ''
  )
  // Required custom role text when 'Other (not listed)' is selected. Populates
  // profiles.title via the parent (not role_type — that stays the 'Other'
  // sentinel). Not prefilled on re-entry: onboarding starts fresh.
  const [customRole, setCustomRole] = useState<string>('')
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return TITLE_ALIASES.slice(0, 50)
    return TITLE_ALIASES
      .filter((e) => e.display.toLowerCase().includes(q) || e.role_type.toLowerCase().includes(q))
      .slice(0, 50)
  }, [query])

  function pickDisplay(display: string) {
    const resolved = resolveTitlePick(display)
    if (!resolved) return // shouldn't happen — display came from filtered list
    setIsOther(false)
    setPickedDisplay(display)
    setQuery('')
    setOpen(false)
    // Reset custom override on a fresh pick
    setCustomExact('')
    // Emit. exact_job_title comes from the alias mapping (null if structured).
    // title = the selected role label so the parent keeps profiles.title populated.
    onChange({ role_type: resolved.role_type, exact_job_title: resolved.exact_job_title, title: display })
  }

  function pickOther() {
    setIsOther(true)
    setPickedDisplay(OTHER_LABEL)
    setQuery('')
    setOpen(false)
    setCustomExact('')
    // role_type is the 'Other' sentinel; title comes from the required custom
    // role field (empty until the user types — the parent enforces >= 2 chars).
    onChange({ role_type: 'Other', exact_job_title: null, title: customRole.trim() })
  }

  function applyCustomRole(text: string) {
    setCustomRole(text)
    const displayOverride = customExact.trim()
    onChange({
      role_type: 'Other',
      exact_job_title: displayOverride.length > 0 ? displayOverride : null,
      title: text.trim(),
    })
  }

  function applyCustomExact(text: string) {
    setCustomExact(text)
    const trimmed = text.trim()
    if (isOther) {
      // 'Other' mode: the display override is independent of the custom role
      // (which drives title). role_type stays the 'Other' sentinel.
      onChange({
        role_type: 'Other',
        exact_job_title: trimmed.length > 0 ? trimmed : null,
        title: customRole.trim(),
      })
      return
    }
    const resolved = resolveTitlePick(pickedDisplay)
    if (!resolved) return
    onChange({
      role_type: resolved.role_type,
      exact_job_title: trimmed.length > 0 ? trimmed : resolved.exact_job_title,
      title: pickedDisplay,
    })
  }

  // Display labels
  const currentCategory = titleToCategory(isOther ? 'Other' : roleType)
  const currentMatch = TITLE_ALIASES.find((e) => e.display === pickedDisplay)
  const storedRoleType = isOther ? 'Other' : (currentMatch?.role_type ?? roleType)

  return (
    <div className="space-y-3">
      {/* Selected title pill (showing the picked display + structured role) */}
      {pickedDisplay && (
        <div className="flex items-start gap-2 rounded-lg border border-[#1B2850]/20 bg-[#1B2850]/5 px-3 py-2">
          <div className="flex-1">
            <p className="text-sm font-medium text-[#1B2850]">{pickedDisplay}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              Stored as <span className="font-mono">{storedRoleType}</span>
              {currentCategory && ` · ${currentCategory}`}
            </p>
          </div>
        </div>
      )}

      {/* Combobox */}
      <div ref={wrapperRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left text-sm hover:border-[#1B2850]/40 transition-colors"
          aria-expanded={open}
        >
          <Search className="h-4 w-4 text-slate-400" />
          <span className="flex-1 text-slate-500">
            {open ? 'Type to search titles…' : pickedDisplay ? 'Change role title' : 'Pick a role title'}
          </span>
          <ChevronDown className={cn('h-4 w-4 text-slate-400 transition-transform', open && 'rotate-180')} />
        </button>

        {open && (
          <div className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
            <div className="sticky top-0 border-b border-slate-100 bg-white p-2">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. CFO, Privacy Officer, Board Member…"
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-sm focus:border-[#1B2850] focus:outline-none"
                autoFocus
              />
            </div>
            <ul role="listbox" className="py-1">
              {filtered.length === 0 ? (
                <li className="px-3 py-2 text-xs text-slate-400">No matches. Refine your search — or choose &ldquo;Other (not listed)&rdquo; below.</li>
              ) : (
                filtered.map((e) => {
                  const isAlias = e.display !== e.role_type
                  return (
                    <li key={`${e.category}:${e.display}`}>
                      <button
                        type="button"
                        onClick={() => pickDisplay(e.display)}
                        className={cn(
                          'flex w-full items-start justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50',
                          pickedDisplay === e.display && 'bg-[#1B2850]/5 text-[#1B2850]'
                        )}
                      >
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-slate-900">{e.display}</p>
                          <p className="truncate text-xs text-slate-500">
                            {e.category}
                            {isAlias && (
                              <>
                                {' · '}
                                <span className="text-slate-400">stored as {e.role_type}</span>
                              </>
                            )}
                          </p>
                        </div>
                      </button>
                    </li>
                  )
                })
              )}
              {/* Escape hatch — never in TITLE_ALIASES, so the firewall is untouched. */}
              <li className="border-t border-slate-100">
                <button
                  type="button"
                  onClick={pickOther}
                  className={cn(
                    'flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50',
                    isOther && 'bg-[#1B2850]/5 text-[#1B2850]'
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-slate-900">{OTHER_LABEL}</p>
                    <p className="truncate text-xs text-slate-500">Enter your own role title</p>
                  </div>
                </button>
              </li>
            </ul>
          </div>
        )}
      </div>

      {/* Required custom role — revealed only for the 'Other (not listed)' pick.
          Populates profiles.title (via the parent); role_type stays 'Other'. */}
      {isOther && (
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">
            Custom role title <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={customRole}
            onChange={(e) => applyCustomRole(e.target.value)}
            placeholder="Head of AI Safety"
            maxLength={140}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-[#1B2850] focus:outline-none"
          />
        </div>
      )}

      {/* Optional display override — never affects matching. */}
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-600">
          Display title <span className="text-slate-400 font-normal">(optional)</span>
        </label>
        <p className="mb-1 text-xs text-slate-400">
          Displayed on your profile. Does not affect matching.
        </p>
        <input
          type="text"
          value={customExact}
          onChange={(e) => applyCustomExact(e.target.value)}
          placeholder="e.g. SVP, Strategic Partnerships"
          maxLength={140}
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-[#1B2850] focus:outline-none"
        />
      </div>
    </div>
  )
}

/**
 * Multi-select mode. Emits ONLY canonical role_type strings sourced from
 * TITLE_ALIASES via resolveTitlePick (same taxonomy + alias search + firewall as
 * single mode). No custom "Other" / free text. De-duplicated by role_type.
 */
function MultiRoleSelect({ values, onValuesChange }: MultiProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapperRef = useRef<HTMLDivElement>(null)

  const selectedSet = useMemo(() => new Set(values), [values])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = q
      ? TITLE_ALIASES.filter(
          (e) => e.display.toLowerCase().includes(q) || e.role_type.toLowerCase().includes(q)
        )
      : TITLE_ALIASES
    return base.slice(0, 50)
  }, [query])

  function pick(display: string) {
    const resolved = resolveTitlePick(display)
    if (!resolved) return // display came from TITLE_ALIASES, so this won't happen
    if (selectedSet.has(resolved.role_type)) return // de-dup by canonical role_type
    onValuesChange([...values, resolved.role_type])
    setQuery('')
  }

  function remove(roleType: string) {
    onValuesChange(values.filter((r) => r !== roleType))
  }

  return (
    <div className="space-y-2">
      {/* Selected canonical role_types as removable pills */}
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((rt) => (
            <span
              key={rt}
              className="inline-flex items-center gap-1 rounded-full border border-[#1B2850]/20 bg-[#1B2850]/5 px-2.5 py-1 text-xs font-medium text-[#1B2850]"
            >
              {rt}
              <button
                type="button"
                onClick={() => remove(rt)}
                aria-label={`Remove ${rt}`}
                className="text-[#1B2850]/50 transition-colors hover:text-[#1B2850]"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div ref={wrapperRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-left text-sm hover:border-slate-400"
        >
          <Search className="h-4 w-4 text-slate-400" />
          <span className="flex-1 text-slate-500">
            {open ? 'Type to search roles…' : values.length > 0 ? 'Add another role' : 'Search and select one or more roles'}
          </span>
          <ChevronDown className={cn('h-4 w-4 text-slate-400 transition-transform', open && 'rotate-180')} />
        </button>

        {open && (
          <div className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
            <div className="sticky top-0 border-b border-slate-100 bg-white p-2">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. CEO, General Counsel, Investor…"
                className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-sm focus:border-[#1B2850] focus:outline-none"
                autoFocus
              />
            </div>
            <ul role="listbox" className="py-1">
              {filtered.length === 0 ? (
                <li className="px-3 py-2 text-xs text-slate-400">No matches. Refine your search.</li>
              ) : (
                filtered.map((e) => {
                  const isSelected = selectedSet.has(e.role_type)
                  const isAlias = e.display !== e.role_type
                  return (
                    <li key={`${e.category}:${e.display}`}>
                      <button
                        type="button"
                        onClick={() => pick(e.display)}
                        disabled={isSelected}
                        className={cn(
                          'flex w-full items-start justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50',
                          isSelected && 'opacity-60'
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-slate-900">{e.display}</p>
                          <p className="truncate text-xs text-slate-500">
                            {e.category}
                            {isAlias && <span className="text-slate-400"> · stored as {e.role_type}</span>}
                          </p>
                        </div>
                        {isSelected && <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#1B2850]" />}
                      </button>
                    </li>
                  )
                })
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
