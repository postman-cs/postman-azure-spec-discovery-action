import { configDefaults, defineConfig } from 'vitest/config';

const windowsCwdSensitiveTests = [
  'tests/action-cli-parity.test.ts',
  'tests/cli.integration.test.ts',
  'tests/definition-file-inventory.test.ts'
];

export default defineConfig({
  test: process.platform === 'win32'
    ? {
        projects: [
          {
            test: {
              name: 'windows-cwd-sensitive',
              environment: 'node',
              env: { POSTMAN_ACTIONS_TELEMETRY: 'off' },
              pool: 'forks',
              fileParallelism: false,
              include: windowsCwdSensitiveTests
            }
          },
          {
            test: {
              name: 'windows-fast',
              environment: 'node',
              env: { POSTMAN_ACTIONS_TELEMETRY: 'off' },
              pool: 'threads',
              fileParallelism: false,
              include: ['tests/**/*.test.ts'],
              exclude: [...configDefaults.exclude, 'tests/live/**', ...windowsCwdSensitiveTests]
            }
          }
        ]
      }
    : {
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
