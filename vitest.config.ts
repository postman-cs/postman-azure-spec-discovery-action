import { configDefaults, defineConfig } from 'vitest/config';

const windowsCwdSensitiveTests = [
  'tests/action-cli-parity.test.ts',
  'tests/cli.integration.test.ts',
  'tests/definition-file-inventory.test.ts'
];

const windowsSerialReceiptTests = [
  'tests/live-validation-contract.test.ts',
  'tests/coverage-manifest.test.ts'
];

export default defineConfig({
  test: process.platform === 'win32'
    ? {
        projects: [
          {
            test: {
              name: 'windows-serial',
              environment: 'node',
              env: { POSTMAN_ACTIONS_TELEMETRY: 'off' },
              pool: 'forks',
              fileParallelism: false,
              // Vitest 4: former poolOptions.forks.singleFork
              maxWorkers: 1,
              isolate: false,
              // Distinct from windows-fast (different maxWorkers).
              sequence: { groupOrder: 1 },
              include: [...windowsCwdSensitiveTests, ...windowsSerialReceiptTests]
            }
          },
          {
            test: {
              name: 'windows-fast',
              environment: 'node',
              env: { POSTMAN_ACTIONS_TELEMETRY: 'off' },
              pool: 'threads',
              sequence: { groupOrder: 0 },
              include: ['tests/**/*.test.ts'],
              exclude: [
                ...configDefaults.exclude,
                'tests/live/**',
                ...windowsCwdSensitiveTests,
                ...windowsSerialReceiptTests
              ]
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
