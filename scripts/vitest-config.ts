import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const SHARED_EXCLUDE = ['node_modules', 'dist'];
const INTEGRATION_TEST_FILES = 'src/**/*.integration.test.ts';
const JEST_TEST_FILES = 'src/**/*.jest.test.ts';
const BIG_TIMEOUT_IN_MILLISECONDS = 30_000;

// The owned-instance worker-attach regression suite runs in its own project: it
// Owns the instance in the global setup and evals from a worker (every other
// Integration suite registers in-worker), so it needs the harness-owned global
// Setup plus the per-worker `vitest-setup` resolvers.
const OWNED_ATTACH_TEST_FILE = 'src/owned-instance-worker-attach.integration.test.ts';

// The plugin-less counterpart of the owned-attach suite: it owns the instance in
// The global setup via `createSetup({ installPlugin: false })` and evals from a
// Worker, so it likewise needs its own global setup plus the per-worker
// `vitest-setup` resolvers.
const BARE_ATTACH_TEST_FILE = 'src/bare-instance-worker-attach.integration.test.ts';

// The `enableCommunityPlugins` end-to-end suite runs in its own project: its global
// Setup seeds a demo vault with two dummy plugins (via `buildDemoVaultPopulate`) and
// Enables them through `createSetup({ enableCommunityPlugins })`, then the worker
// Asserts both loaded — so it needs its own global setup plus the per-worker resolvers.
const ENABLE_COMMUNITY_PLUGINS_TEST_FILE = 'src/enable-community-plugins.integration.test.ts';

// Inject the per-version compatibility table into `obsidian-metadata.ts` under
// Test, the same way the esbuild build does via `define`. Two mechanisms are
// Needed because Vitest's per-project `define` reaches the unit-test project but
// Not the integration-test projects (a known quirk): the unit-test project uses
// `define` (a string value is substituted as a raw expression, so the JSON text
// Becomes an object literal replacing the `OBSIDIAN_METADATA` global — keeping the
// Unit project filesystem-free), while the integration-test projects publish the
// Same table as a global via `METADATA_SETUP_FILE`.
const DEFINE = {
  OBSIDIAN_METADATA: readFileSync('metadata.json', 'utf-8')
};
const METADATA_SETUP_FILE = './scripts/vitest-metadata-setup.ts';

// The integration projects' global-setup modules (owned-attach / bare-attach) run in
// The Vitest main process, where the per-project `define` (unit-tests only) and the
// Per-worker `METADATA_SETUP_FILE` setupFile do NOT apply. Publish the table as a
// Global here — this config is evaluated in that same main process — so a global
// Setup importing the harness chain resolves `OBSIDIAN_METADATA` instead of throwing
// `OBSIDIAN_METADATA is not defined` at module evaluation.
Object.defineProperty(globalThis, 'OBSIDIAN_METADATA', {
  configurable: true,
  value: JSON.parse(DEFINE.OBSIDIAN_METADATA)
});

export const config = defineConfig({
  test: {
    coverage: {
      exclude: [
        'src/**/*.test.ts'
      ],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage'
    },
    exclude: SHARED_EXCLUDE,
    globals: false,
    projects: [
      {
        define: DEFINE,
        test: {
          environment: 'node',
          exclude: [...SHARED_EXCLUDE, INTEGRATION_TEST_FILES, JEST_TEST_FILES],
          include: ['src/**/*.test.ts'],
          name: 'unit-tests',
          server: {
            deps: {
              inline: ['@obsidian-typings', 'obsidian-dev-utils']
            }
          }
        }
      },
      {
        test: {
          environment: 'node',
          exclude: [...SHARED_EXCLUDE, OWNED_ATTACH_TEST_FILE, BARE_ATTACH_TEST_FILE, ENABLE_COMMUNITY_PLUGINS_TEST_FILE],
          include: [INTEGRATION_TEST_FILES],
          name: 'integration-tests',
          setupFiles: [METADATA_SETUP_FILE],
          testTimeout: BIG_TIMEOUT_IN_MILLISECONDS
        }
      },
      {
        test: {
          environment: 'node',
          exclude: SHARED_EXCLUDE,
          fileParallelism: false,
          globalSetup: ['./scripts/owned-attach-regression-global-setup.ts'],
          include: [OWNED_ATTACH_TEST_FILE],
          maxWorkers: 1,
          name: 'integration-tests:owned-attach',
          setupFiles: [METADATA_SETUP_FILE, './src/vitest/setup.ts'],
          testTimeout: BIG_TIMEOUT_IN_MILLISECONDS
        }
      },
      {
        test: {
          environment: 'node',
          exclude: SHARED_EXCLUDE,
          fileParallelism: false,
          // Point straight at the plugin-less setup module (the same
          // `vitest-global-setup-no-plugin` subpath a non-plugin consumer uses),
          // Exercising it end-to-end — no wrapper needed.
          globalSetup: ['./src/vitest/global-setup-no-plugin.ts'],
          include: [BARE_ATTACH_TEST_FILE],
          maxWorkers: 1,
          name: 'integration-tests:bare-attach',
          setupFiles: [METADATA_SETUP_FILE, './src/vitest/setup.ts'],
          testTimeout: BIG_TIMEOUT_IN_MILLISECONDS
        }
      },
      {
        test: {
          environment: 'node',
          exclude: SHARED_EXCLUDE,
          fileParallelism: false,
          globalSetup: ['./scripts/enable-community-plugins-global-setup.ts'],
          include: [ENABLE_COMMUNITY_PLUGINS_TEST_FILE],
          maxWorkers: 1,
          name: 'integration-tests:enable-community-plugins',
          setupFiles: [METADATA_SETUP_FILE, './src/vitest/setup.ts'],
          testTimeout: BIG_TIMEOUT_IN_MILLISECONDS
        }
      }
    ]
  }
});
