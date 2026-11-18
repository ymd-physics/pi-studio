import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  test: {
    include: [
      'src/main/minimal/**/*.test.ts',
      'src/main/workspace-fs*.test.ts',
      'src/main/__tests__/login-shell-environment.test.ts',
      'src/renderer/src/minimal/**/*.test.{ts,tsx}',
      'packages/shared/*.test.ts',
    ],
    environment: 'node',
  },
})
