import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Scoped to lib/__tests__ so it runs the unit tests without picking up the
// pre-existing jest-format regression file in the root __tests__/ dir (which
// documents that it needs a separate jest setup to run).
export default defineConfig({
  // tsconfig sets jsx:"preserve" for Next's compiler, which leaves raw JSX that Vite
  // cannot parse. Transform it here so tests may render real .tsx components — the
  // post-onboarding regression suite renders the client set the first dashboard page
  // mounts. Test-only: the production build still uses Next's own compiler.
  // `as any`: the value is correct at runtime (Vitest 4 transforms via oxc), but the
  // bundled Vite typings don't re-export oxc's jsx literal, so the object doesn't
  // typecheck. Cast is narrowed to this one property.
  oxc: { jsx: 'automatic' } as any,
  test: {
    environment: 'node',
    include: ['lib/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
})
