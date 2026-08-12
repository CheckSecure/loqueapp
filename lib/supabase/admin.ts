import { createClient } from '@supabase/supabase-js'

/** Combine abort signals so a request aborts when ANY of them fires (safe fallback if
 *  AbortSignal.any is unavailable). Non-identifying; used only for deadline propagation. */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  const present = signals.filter(Boolean)
  if (present.length === 1) return present[0]
  if (typeof (AbortSignal as any).any === 'function') return (AbortSignal as any).any(present)
  const controller = new AbortController()
  for (const s of present) {
    if (s.aborted) { controller.abort(); break }
    s.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}

/** A fetch wrapper that attaches a deadline AbortSignal to EVERY request (merged with any
 *  per-request signal). Injected as the Supabase client's global fetch so every query/RPC that
 *  client issues is genuinely cancelled when the deadline fires. */
export function boundedFetch(deadlineSignal: AbortSignal, base: typeof fetch = fetch): typeof fetch {
  return ((input: any, init?: any) => {
    const signal = anySignal([init?.signal, deadlineSignal].filter(Boolean) as AbortSignal[])
    return base(input, { ...init, signal })
  }) as typeof fetch
}

/**
 * Service-role admin client.
 *
 * Pass `{ signal }` to bind a deadline AbortSignal to EVERY request this client makes (via a
 * custom global fetch). This is how the onboarding reciprocal generator enforces one hard total
 * budget: a single controller aborts eligibility reads, capacity reads, all ranker/profile reads,
 * AND every create_reciprocal_suggestion RPC at once — no per-query threading required.
 */
export function createAdminClient(options?: { signal?: AbortSignal }) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

  if (!supabaseUrl) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not configured')
  }

  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured')
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    ...(options?.signal ? { global: { fetch: boundedFetch(options.signal) } } : {}),
  })
}
