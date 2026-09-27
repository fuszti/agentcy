import { defineConfig } from 'vitest/config'

// Only the office's own tests: agents keep their projects (with their own test suites) in workspaces/.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
