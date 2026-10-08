import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@/': fileURLToPath(new URL('./src/', import.meta.url)),
      '@data/': fileURLToPath(new URL('./data/', import.meta.url)),
      // src/server modules start with `import 'server-only'`, which throws outside a React
      // Server build (its default export). Tests run them on Node, as the server does.
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'tests/perf/**/*.test.ts'],
  },
})
