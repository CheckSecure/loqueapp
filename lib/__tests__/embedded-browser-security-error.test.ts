import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * EMBEDDED-BROWSER SecurityError regression.
 *
 * Production evidence: { metric: client_error_boundary, surface: "global",
 * errorClass: "SecurityError", digest: "none" } from an iPhone embedded/in-app browser.
 *
 * These tests model a host that refuses optional browser capabilities — the PROPERTY READ itself
 * throws, which is how iOS WKWebView behaves with blocked storage — and assert the app degrades that
 * one feature instead of blanking.
 */

// The beacon itself is covered by lib/__tests__/metrics.test.ts and by source assertions below;
// here it is mocked so a relative URL never reaches Node's fetch.
vi.mock('@/lib/metrics', () => ({ emitMetric: vi.fn() }))

const RECOVER = readFileSync('app/auth/recover/page.tsx', 'utf8')
const DASH_ERR = readFileSync('app/dashboard/error.tsx', 'utf8')
const ONB_ERR = readFileSync('app/onboarding/error.tsx', 'utf8')
const GLOBAL_ERR = readFileSync('app/global-error.tsx', 'utf8')
const SAFE = readFileSync('lib/browser/safeApis.ts', 'utf8')
const METRICS = readFileSync('lib/metrics.ts', 'utf8')

const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const securityError = () => {
  const e: any = new Error('The operation is insecure.')
  e.name = 'SecurityError'
  return e
}

/** A window whose storage/history PROPERTIES throw on access, like a blocked embedded browser. */
function installHostileWindow(opts: { storage?: boolean; history?: boolean } = { storage: true, history: true }) {
  const w: any = {}
  if (opts.storage) {
    Object.defineProperty(w, 'localStorage', { get() { throw securityError() }, configurable: true })
    Object.defineProperty(w, 'sessionStorage', { get() { throw securityError() }, configurable: true })
  } else {
    const mem = new Map<string, string>()
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v) },
      removeItem: (k: string) => { mem.delete(k) },
    }
    w.localStorage = store
    w.sessionStorage = store
  }
  w.history = opts.history
    ? { replaceState() { throw securityError() }, pushState() { throw securityError() } }
    : { replaceState: vi.fn(), pushState: vi.fn() }
  w.location = { assign: vi.fn(), pathname: '/auth/recover', hash: '', search: '' }
  ;(globalThis as any).window = w
  return w
}

beforeEach(() => { vi.resetModules() })
afterEach(() => { delete (globalThis as any).window })

// ── The safe wrappers ────────────────────────────────────────────────────────

describe('safeApis — every access happens INSIDE the try, including property acquisition', () => {
  it('safeStorage returns null instead of throwing when the getter itself throws', async () => {
    installHostileWindow()
    const { safeStorage } = await import('@/lib/browser/safeApis')
    expect(() => safeStorage('local', 'test')).not.toThrow()
    expect(safeStorage('local', 'test')).toBeNull()
    expect(safeStorage('session', 'test')).toBeNull()
  })

  it('safeGetItem / safeSetItem degrade to null / false, never throw', async () => {
    installHostileWindow()
    const { safeGetItem, safeSetItem } = await import('@/lib/browser/safeApis')
    expect(safeGetItem('local', 'k', 'test')).toBeNull()
    expect(safeGetItem('session', 'k', 'test')).toBeNull()
    expect(safeSetItem('local', 'k', 'v', 'test')).toBe(false)
    expect(safeSetItem('session', 'k', 'v', 'test')).toBe(false)
  })

  it('storage still works normally in a permissive browser', async () => {
    installHostileWindow({ storage: false, history: false })
    const { safeSetItem, safeGetItem } = await import('@/lib/browser/safeApis')
    expect(safeSetItem('local', 'k', 'v', 'test')).toBe(true)
    expect(safeGetItem('local', 'k', 'test')).toBe('v')
  })

  it('safeReplaceState returns false instead of throwing when History is refused', async () => {
    installHostileWindow()
    const { safeReplaceState } = await import('@/lib/browser/safeApis')
    expect(() => safeReplaceState('/auth/recover', 'auth_recover')).not.toThrow()
    expect(safeReplaceState('/auth/recover', 'auth_recover')).toBe(false)
  })

  it('safeReplaceState succeeds normally when History works', async () => {
    installHostileWindow({ storage: false, history: false })
    const { safeReplaceState } = await import('@/lib/browser/safeApis')
    expect(safeReplaceState('/auth/recover', 'auth_recover')).toBe(true)
  })

  it('safeNavigate falls back to a hard load when the client router throws', async () => {
    const w = installHostileWindow()
    const { safeNavigate } = await import('@/lib/browser/safeApis')
    const throwingRouter = () => { throw securityError() }
    expect(safeNavigate('/dashboard/introductions', 'test', throwingRouter)).toBe('hard')
    expect(w.location.assign).toHaveBeenCalledWith('/dashboard/introductions')
  })

  it('safeNavigate prefers the client router when it works', async () => {
    installHostileWindow({ storage: false, history: false })
    const { safeNavigate } = await import('@/lib/browser/safeApis')
    const push = vi.fn()
    expect(safeNavigate('/x', 'test', push)).toBe('client')
    expect(push).toHaveBeenCalledWith('/x')
  })

  it('a storage probe failure is caught too (host exposes the object but throws on use)', async () => {
    const w: any = {}
    w.localStorage = { getItem: () => null, setItem: () => { throw securityError() }, removeItem: () => {} }
    w.history = { replaceState: vi.fn() }
    ;(globalThis as any).window = w
    const { safeStorage } = await import('@/lib/browser/safeApis')
    expect(safeStorage('local', 'test')).toBeNull()
  })
})

describe('safeApis — narrow scope, never a blanket suppressor', () => {
  it('wraps only the four identified optional operations', async () => {
    const { safeStorage } = await import('@/lib/browser/safeApis')
    expect(typeof safeStorage).toBe('function')
    const ops = (SAFE.match(/^  \| '([a-z_]+)'$/gm) || []).map((s) => s.trim())
    expect(ops).toEqual([
      "| 'local_storage'", "| 'session_storage'", "| 'history_replace_state'", "| 'client_navigation'",
    ])
  })

  it('catches around a single operation each — no catch-all wrapper is exported', () => {
    expect(codeOnly(SAFE)).not.toMatch(/name === 'SecurityError'/) // no error-type sniffing to suppress broadly
    expect(codeOnly(SAFE)).not.toMatch(/window\.onerror|addEventListener\('error'|unhandledrejection/)
    // Each try body is one operation.
    expect(SAFE).toContain('window.history.replaceState(null, \'\', url)')
    expect(SAFE).toContain('window.localStorage')
    expect(SAFE).toContain('window.sessionStorage')
  })
})

// ── Diagnostics ──────────────────────────────────────────────────────────────

describe('coarse diagnostics for a refused capability', () => {
  it('uses the existing hardened metrics facility with a new allowlisted name', () => {
    expect(METRICS).toContain("'client_browser_api_unavailable'")
    expect(METRICS).toContain('ALLOWED_METRICS')
    expect(METRICS).toContain("'/api/metrics'")
    expect(METRICS).toContain('sanitizeDims')
  })

  it('sends only a fixed op + surface label — never URL, id, message, stack, or user agent', () => {
    expect(SAFE).toContain("emitMetric('client_browser_api_unavailable', { op, surface })")
    const call = SAFE.slice(SAFE.indexOf('function reportUnavailable'), SAFE.indexOf('export function safeStorage'))
    expect(call).not.toMatch(/message|stack|href|location|userAgent|navigator|email|token|cookie/i)
  })

  it('telemetry is non-blocking — a metric failure cannot affect the caller', () => {
    expect(SAFE).toContain('try {\n    emitMetric')
    expect(SAFE).toMatch(/catch \{\s*\/\* telemetry must never affect the caller \*\/\s*\}/)
  })
})

// ── The two operations that were unguarded ───────────────────────────────────

describe('the recovery page no longer throws on a refused History API', () => {
  it('routes the address-bar scrub through safeReplaceState', () => {
    expect(RECOVER).toContain("safeReplaceState(window.location.pathname, 'auth_recover')")
    expect(codeOnly(RECOVER)).not.toMatch(/window\.history\.replaceState/)
  })

  it('captures the token params BEFORE the scrub, so a refused scrub loses nothing', () => {
    const parseIdx = RECOVER.indexOf('parseRecoveryParamsFromLocation')
    const scrubIdx = RECOVER.indexOf('safeReplaceState')
    expect(parseIdx).toBeGreaterThan(-1)
    expect(parseIdx).toBeLessThan(scrubIdx)
  })

  it('token verification is unchanged — still an explicit click, not an automatic verify', () => {
    expect(RECOVER).toContain('RecoveryFlow')
    expect(RECOVER).toContain('async function handleConfirm()')
    expect(RECOVER).toContain('await flow.confirm()')
  })
})

describe('DemoGate no longer touches sessionStorage unguarded', () => {
  const DEMO = readFileSync('components/DemoGate.tsx', 'utf8')
  it('every access goes through its guarded helpers', () => {
    const code = codeOnly(DEMO)
    // The only raw sessionStorage references left are inside the helper definitions.
    const raw = (code.match(/sessionStorage\./g) || []).length
    expect(raw).toBe(2) // safeGetItem + safeSetItem bodies
    expect(code).toContain("safeGetItem(STORAGE_KEY) === 'true'")
    expect(code).toContain("safeSetItem(STORAGE_KEY, 'true')")
  })
})

// ── Recovery UI must work without History/storage/routing ────────────────────

describe('error recovery UI is usable in a hostile embedded browser', () => {
  it('uses plain hard-navigation anchors, never next/link', () => {
    for (const src of [DASH_ERR, ONB_ERR, GLOBAL_ERR]) {
      // codeOnly: the files explain in a comment WHY they avoid next/link.
      expect(codeOnly(src)).not.toMatch(/next\/link/)
      expect(codeOnly(src)).not.toMatch(/<Link\b/)
      expect(src).toMatch(/<a\s+href="\/dashboard\/introductions"/)
    }
  })

  it('offers a second escape path to /login on every boundary', () => {
    for (const src of [DASH_ERR, ONB_ERR, GLOBAL_ERR]) {
      expect(src).toMatch(/href="\/login"/)
    }
  })

  it('requires no client storage, cookies, or routing to render', () => {
    for (const src of [DASH_ERR, ONB_ERR, GLOBAL_ERR]) {
      expect(codeOnly(src)).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/)
      expect(codeOnly(src)).not.toMatch(/useRouter|router\.(push|replace|refresh)/)
      expect(codeOnly(src)).not.toMatch(/history\.(pushState|replaceState)/)
    }
  })

  it('still leaks nothing — no message, stack, or raw error on screen', () => {
    for (const src of [DASH_ERR, ONB_ERR, GLOBAL_ERR]) {
      expect(src).not.toMatch(/\{error\.message\}/)
      expect(src).not.toMatch(/\{error\.stack\}/)
      expect(src).toMatch(/error\?\.digest &&|error\?\.digest/)
    }
  })
})

// ── Nothing else regressed ───────────────────────────────────────────────────

describe('recent containment and password-copy work remain intact', () => {
  it('boundaries still report through the beacon with coarse dimensions', () => {
    for (const src of [DASH_ERR, ONB_ERR, GLOBAL_ERR]) {
      expect(src).toContain("emitMetric('client_error_boundary'")
      expect(src).toContain('errorClass: error?.name')
      expect(src).toMatch(/does NOT reach Vercel|Browser-only/i)
    }
  })

  it('boundaries still document that they do not catch everything', () => {
    for (const src of [DASH_ERR, GLOBAL_ERR]) {
      expect(src).toMatch(/event handler/i)
      expect(src).toMatch(/reject(ed|ion)/i)
    }
  })

  it('server-derived password copy and the neutral first paint are unchanged', () => {
    const reset = readFileSync('app/auth/reset-password/page.tsx', 'utf8')
    expect(reset).toContain('useState<PasswordSetupDisplayMode>(DEFAULT_MODE)')
    expect(reset).toContain("fetch('/api/auth/password-context')")
    expect(reset).toContain('/api/auth/complete-reset')
    expect(reset).toContain("mode: 'finalize'")
    const copy = readFileSync('lib/auth/passwordSetupCopy.ts', 'utf8')
    expect(copy).toContain("DEFAULT_MODE: PasswordSetupDisplayMode = 'unknown'")
  })

  it('the reset page storage marker was already guarded and stays display-only', () => {
    const reset = readFileSync('app/auth/reset-password/page.tsx', 'utf8')
    for (const fn of ['markPwSet', 'isPwSet', 'clearPwSet']) {
      const line = reset.split('\n').find((l) => l.includes(`const ${fn} =`))!
      expect(line).toMatch(/try \{.*catch/)
    }
    expect(reset).toContain('DISPLAY ONLY')
  })

  it('completeOnboarding still writes onboarding_step atomically', () => {
    const actions = readFileSync('app/actions.ts', 'utf8')
    const body = actions.slice(actions.indexOf('export async function completeOnboarding'), actions.indexOf('export async function saveAvatarUrl'))
    expect(body).toMatch(/profile_complete: true/)
    expect(body).toMatch(/onboarding_step: 2/)
  })

  it('no auth, token, cookie, or same-origin control was weakened', () => {
    expect(codeOnly(SAFE)).not.toMatch(/cookie|token|sameSite|secure:|assertSameOrigin|requireAdmin/i)
    expect(readFileSync('middleware.ts', 'utf8')).toContain("rpc('get_my_profile')")
    expect(readFileSync('app/api/auth/password-context/route.ts', 'utf8')).toContain('auth.getUser()')
  })
})

describe('no reset loop and no data loss in a hostile browser', () => {
  it('a refused scrub does not re-enter verification or clear captured params', () => {
    // The flow object is built from params captured before the scrub and is verified only on click.
    const order = ['parseRecoveryParamsFromLocation', 'safeReplaceState', 'new RecoveryFlow', 'flow.init()']
    let last = -1
    for (const token of order) {
      const i = RECOVER.indexOf(token)
      expect(i, token).toBeGreaterThan(last)
      last = i
    }
  })

  it('storage being unavailable never triggers a profile write or reset', () => {
    // safeApis performs no network call and touches no profile state.
    expect(codeOnly(SAFE)).not.toMatch(/fetch\(|supabase|profiles|from\(/)
  })
})
