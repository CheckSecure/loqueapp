import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Scoped to lib/__tests__ so it runs the unit tests without picking up the
// pre-existing jest-format regression file in the root __tests__/ dir (which
// documents that it needs a separate jest setup to run).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: { '@': resolve(__dirname, '.') },
  },
})
