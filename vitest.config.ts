import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Telemetry is fire-and-forget; keep it disabled in unit tests so no run
    // ever attempts a network call. Enabled-path tests pass an explicit env.
    env: { POSTMAN_ACTIONS_TELEMETRY: 'off' },
    // Live-validation contract tests temporarily replace the committed evidence
    // receipt, so test files must not read that receipt concurrently.
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/live/**']
  }
});
