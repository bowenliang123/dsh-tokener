import { defineConfig } from 'vitest/config'

// Live-gateway specs. They self-skip unless TOKENER_API_KEY is set, so CI
// without a key stays green; run locally with the key exported.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.e2e.ts'],
    testTimeout: 120_000,
  },
})
