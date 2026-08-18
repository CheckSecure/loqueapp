import { emitMetric } from '@/lib/metrics'

/**
 * safeApis — narrowly-scoped wrappers for the OPTIONAL browser capabilities that embedded/in-app
 * browsers (iOS WKWebView-based in-app views, Safari with blocked storage) can refuse with a
 * DOMException. The specific host application involved in the production report is NOT confirmed and
 * is deliberately not named here.
 *
 * WHY: production captured `{ metric: client_error_boundary, surface: "global",
 * errorClass: "SecurityError", digest: "none" }` from an iPhone embedded browser. In those hosts:
 *   - reading `window.localStorage` / `window.sessionStorage` throws on PROPERTY ACCESS, before any
 *     method call — so `try { localStorage.getItem(k) }` is only safe because the property read
 *     happens inside the try. A cached `const s = window.localStorage` outside a try is not safe.
 *   - `history.replaceState` / `pushState` can throw SecurityError outright.
 *
 * SCOPE DISCIPLINE (deliberate): this module NEVER swallows errors broadly. Each helper wraps ONE
 * identified optional operation, returns a value that lets the caller degrade that single feature,
 * and re-throws nothing else's problem — any error from a different operation still reaches the
 * error boundary and telemetry untouched. Nothing here weakens auth, token verification, cookie
 * settings, same-origin protections, or A3/P0/P1 controls; none of these operations is a security
 * control, and the one that is adjacent to security (the recover-page URL scrub) degrades in a way
 * that is explicitly reported rather than silently assumed.
 */

/** Fixed allowlist of operation labels. Coarse and non-identifying by construction. */
export type SafeApiOp =
  | 'local_storage'
  | 'session_storage'
  | 'history_replace_state'
  | 'client_navigation'

/**
 * Record that an optional browser capability was unavailable. Coarse only — an operation label and
 * a surface label, both from fixed vocabularies. Never a URL, email, id, message, stack, form value,
 * token, cookie, user agent, or raw exception. Non-blocking: emitMetric swallows its own failures.
 */
function reportUnavailable(op: SafeApiOp, surface: string): void {
  try {
    emitMetric('client_browser_api_unavailable', { op, surface })
  } catch {
    /* telemetry must never affect the caller */
  }
}

/**
 * Acquire a Storage object, or null when the host refuses it. The PROPERTY READ is inside the try —
 * that is the whole point, since `window.localStorage` itself throws in a blocked embedded browser.
 * A probe write/remove is included because some hosts expose the object but throw on first use.
 */
export function safeStorage(kind: 'local' | 'session', surface: string): Storage | null {
  try {
    const s = kind === 'local' ? window.localStorage : window.sessionStorage
    if (!s) return null
    const probe = '__andrel_probe__'
    s.setItem(probe, '1')
    s.removeItem(probe)
    return s
  } catch {
    reportUnavailable(kind === 'local' ? 'local_storage' : 'session_storage', surface)
    return null
  }
}

/** Read a key, or null when storage is unavailable. Never throws. */
export function safeGetItem(kind: 'local' | 'session', key: string, surface: string): string | null {
  const s = safeStorage(kind, surface)
  if (!s) return null
  try { return s.getItem(key) } catch { return null }
}

/** Write a key. Returns whether it persisted. Never throws. */
export function safeSetItem(kind: 'local' | 'session', key: string, value: string, surface: string): boolean {
  const s = safeStorage(kind, surface)
  if (!s) return false
  try { s.setItem(key, value); return true } catch { return false }
}

/**
 * Replace the current history entry. Returns whether it succeeded.
 *
 * Used by the recovery page to scrub a token out of the address bar. When the host refuses the
 * History API this returns false and the caller CONTINUES — the token was already captured in
 * memory, so the flow still works; only the address-bar scrub is skipped. That is a reported
 * degradation, not a silent one, and it is strictly better than a blank screen. We deliberately do
 * NOT fall back to a location assignment here: that would reload the page and discard the captured
 * one-time token.
 */
export function safeReplaceState(url: string, surface: string): boolean {
  try {
    window.history.replaceState(null, '', url)
    return true
  } catch {
    reportUnavailable('history_replace_state', surface)
    return false
  }
}

/**
 * Navigate, preferring the caller's client router and falling back to a full page load when the
 * host refuses it (a client router push ultimately calls the History API). Returns the strategy
 * used so callers can assert on it. Same-origin paths only — callers pass app-relative paths.
 */
export function safeNavigate(
  path: string,
  surface: string,
  clientNavigate?: (p: string) => void,
): 'client' | 'hard' | 'failed' {
  if (clientNavigate) {
    try {
      clientNavigate(path)
      return 'client'
    } catch {
      reportUnavailable('client_navigation', surface)
    }
  }
  try {
    window.location.assign(path)
    return 'hard'
  } catch {
    reportUnavailable('client_navigation', surface)
    return 'failed'
  }
}
