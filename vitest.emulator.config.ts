import { defineConfig } from 'vitest/config';

// Emulator lane: hermetic Azure fixture proofs for the shipped CLI bundle.
// Runs only via `npm run test:emulator:azure` inside the budgeted CI lane (or
// a local operator shell); never part of default `npm test`.
export default defineConfig({
  test: {
    environment: 'node',
    env: { POSTMAN_ACTIONS_TELEMETRY: 'off' },
    include: ['tests/emulator/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
