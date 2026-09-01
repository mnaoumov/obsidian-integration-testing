import { defineConfig } from 'vitest/config';

import {
  defineObsidianMetadataGlobal,
  readMetadataJsonText
} from './helpers/metadata-global.ts';

const SHARED_EXCLUDE = ['node_modules', 'dist'];
const INTEGRATION_TEST_FILES = 'src/**/*.integration.test.ts';
const JEST_TEST_FILES = 'src/**/*.jest.test.ts';
// Every test under `scripts/` — the vendored docs generator (L35), the custom ESLint rules, and the
// Release-script helpers. Deliberately the whole tree rather than `scripts/docs-gen/**`, which is what it
// Used to be: that narrower glob silently left `scripts/helpers/eslint-rules/*.test.ts` run by no project
// At all, and left `scripts/version.ts` with nowhere to put a regression test at all (T813-P2).
const SCRIPTS_TEST_FILES = 'scripts/**/*.test.ts';
const DOCS_SITE_TEST_FILES = 'docs/src/**/*.test.ts';
const BIG_TIMEOUT_IN_MILLISECONDS = 30_000;

// Vitest 4 projects do NOT inherit the root-level `test` options, so a project that omits `testTimeout`
// Silently runs on the built-in 5000 ms default. That is how the release gate went flaky (T765): every
// Project here carried a budget EXCEPT `unit-tests` — the only one `npm run test:coverage` runs — so the
// One project gating a release had the tightest budget in the repo. Spreading the default into each project
// Makes the omission impossible rather than merely unlikely. The budget covers two costs a per-suite number
// Cannot: v8 coverage instrumentation, measured at ~2.2x on this project, and the CPU contention of a busy
// Machine. Suites that are genuinely slow in their own right — rendering an OG image with satori + resvg,
// Building a ts-morph Project over the whole `tsconfig.json` — sit comfortably inside it.
const SHARED_TEST_DEFAULTS = { testTimeout: BIG_TIMEOUT_IN_MILLISECONDS };

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

// The failed-setup regression suite (T726) runs in its own project because its global setup must FAIL:
// It attaches to a CDP port nothing can serve, so every test in it runs in the state a worker is left in
// After a real setup failure. Port 1 is refused outright by `fetch`, so the failure is instant and never
// Touches the network -- and an `obsidian-cdp` transport takes no setup lock, unlike an Appium one, so
// This project stays hermetic and safe inside the default aggregate.
const FAILED_SETUP_TEST_FILE = 'src/failed-setup-fail-fast.integration.test.ts';
const UNREACHABLE_CDP_PORT = 1;

// The mobile trusted-input suite runs in its own project because it is the only one that needs a real
// Android emulator through Appium (see L39). Keeping it out of the default `integration-tests` aggregate is
// Deliberate: that aggregate is desktop, runs on every change, and must not boot an emulator.
const ANDROID_TRUSTED_INPUT_TEST_FILE = 'src/mobile-trusted-input.android.integration.test.ts';

// Its desktop counterpart runs serially for the reason L11 gives consumers: trusted input targets the
// Single shared window's GLOBAL focus and pointer, so pointer-dependent files cannot run against each
// Other — which the default `integration-tests` project does not guarantee.
const DESKTOP_TRUSTED_INPUT_TEST_FILE = 'src/trusted-input.desktop.integration.test.ts';

// An emulator run is 140-200s cold (L19), and every step before the first assertion — boot, Appium session,
// Vault push, app restart — happens inside the hooks.
const ANDROID_TIMEOUT_IN_MILLISECONDS = 300_000;

// Inject the per-version compatibility table into `obsidian-metadata.ts` under
// Test, the same way the esbuild build does via `define`. Two mechanisms are
// Needed because Vitest's per-project `define` reaches the unit-test project but
// Not the integration-test projects (a known quirk): the unit-test project uses
// `define` (a string value is substituted as a raw expression, so the JSON text
// Becomes an object literal replacing the `OBSIDIAN_METADATA` global — keeping the
// Unit project filesystem-free), while the integration-test projects publish the
// Same table as a global via `METADATA_SETUP_FILE`.
const DEFINE = {
  OBSIDIAN_METADATA: readMetadataJsonText()
};
const METADATA_SETUP_FILE = './scripts/metadata-global-setup.ts';

// The integration projects' global-setup modules (owned-attach / bare-attach) run in
// The Vitest main process, where the per-project `define` (unit-tests only) and the
// Per-worker `METADATA_SETUP_FILE` setupFile do NOT apply. Publish the table as a
// Global here — this config is evaluated in that same main process — so a global
// Setup importing the harness chain resolves `OBSIDIAN_METADATA` instead of throwing
// `OBSIDIAN_METADATA is not defined` at module evaluation.
defineObsidianMetadataGlobal();

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
          ...SHARED_TEST_DEFAULTS,
          environment: 'node',
          exclude: [...SHARED_EXCLUDE, INTEGRATION_TEST_FILES, JEST_TEST_FILES],
          include: ['src/**/*.test.ts'],
          name: 'unit-tests',
          server: {
            // eslint-disable-next-line unicorn/name-replacements -- `deps` is Vite's own `server.deps` option name.
            deps: {
              inline: ['@obsidian-typings', 'obsidian-dev-utils']
            }
          }
        }
      },
      {
        test: {
          ...SHARED_TEST_DEFAULTS,
          environment: 'node',
          exclude: [...SHARED_EXCLUDE],
          include: [SCRIPTS_TEST_FILES, DOCS_SITE_TEST_FILES],
          name: 'unit-tests:scripts'
        }
      },
      {
        test: {
          ...SHARED_TEST_DEFAULTS,
          environment: 'node',
          exclude: [
            ...SHARED_EXCLUDE,
            OWNED_ATTACH_TEST_FILE,
            BARE_ATTACH_TEST_FILE,
            ENABLE_COMMUNITY_PLUGINS_TEST_FILE,
            FAILED_SETUP_TEST_FILE,
            ANDROID_TRUSTED_INPUT_TEST_FILE,
            DESKTOP_TRUSTED_INPUT_TEST_FILE
          ],
          include: [INTEGRATION_TEST_FILES],
          name: 'integration-tests',
          setupFiles: [METADATA_SETUP_FILE]
        }
      },
      {
        test: {
          ...SHARED_TEST_DEFAULTS,
          environment: 'node',
          exclude: SHARED_EXCLUDE,
          fileParallelism: false,
          globalSetup: ['./scripts/owned-attach-regression-global-setup.ts'],
          include: [OWNED_ATTACH_TEST_FILE],
          maxWorkers: 1,
          name: 'integration-tests:owned-attach',
          setupFiles: [METADATA_SETUP_FILE, './src/vitest/setup.ts']
        }
      },
      {
        test: {
          ...SHARED_TEST_DEFAULTS,
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
          setupFiles: [METADATA_SETUP_FILE, './src/vitest/setup.ts']
        }
      },
      {
        test: {
          ...SHARED_TEST_DEFAULTS,
          environment: 'node',
          // The whole point of this project: a global setup that FAILS. It points the standard
          // Plugin-less setup at a CDP port nothing serves, so `registerVault` throws and the adapter
          // Stores the failure instead of publishing a transport.
          environmentOptions: {
            obsidianTransport: {
              port: UNREACHABLE_CDP_PORT,
              type: 'obsidian-cdp'
            }
          },
          exclude: SHARED_EXCLUDE,
          fileParallelism: false,
          globalSetup: ['./src/vitest/global-setup-no-plugin.ts'],
          include: [FAILED_SETUP_TEST_FILE],
          maxWorkers: 1,
          name: 'integration-tests:failed-setup',
          setupFiles: [METADATA_SETUP_FILE, './src/vitest/setup.ts']
        }
      },
      {
        test: {
          ...SHARED_TEST_DEFAULTS,
          environment: 'node',
          exclude: SHARED_EXCLUDE,
          fileParallelism: false,
          globalSetup: ['./scripts/enable-community-plugins-global-setup.ts'],
          include: [ENABLE_COMMUNITY_PLUGINS_TEST_FILE],
          maxWorkers: 1,
          name: 'integration-tests:enable-community-plugins',
          setupFiles: [METADATA_SETUP_FILE, './src/vitest/setup.ts']
        }
      },
      {
        test: {
          ...SHARED_TEST_DEFAULTS,
          environment: 'node',
          exclude: SHARED_EXCLUDE,
          // One emulator, one Appium server, and trusted input targets the app's GLOBAL focus and pointer,
          // So these files cannot run against each other (the same reason L8/L11 give consumers).
          fileParallelism: false,
          // Takes the shared-emulator lock (L7). This project has no transport global setup, so it never
          // Goes through `coreSetup` — which is what normally acquires it.
          globalSetup: ['./scripts/android-trusted-input-global-setup.ts'],
          hookTimeout: ANDROID_TIMEOUT_IN_MILLISECONDS,
          include: [ANDROID_TRUSTED_INPUT_TEST_FILE],
          maxWorkers: 1,
          name: 'integration-tests:android-trusted-input',
          setupFiles: [METADATA_SETUP_FILE, './scripts/android-transport-setup.ts'],
          testTimeout: ANDROID_TIMEOUT_IN_MILLISECONDS
        }
      },
      {
        test: {
          ...SHARED_TEST_DEFAULTS,
          environment: 'node',
          exclude: SHARED_EXCLUDE,
          fileParallelism: false,
          include: [DESKTOP_TRUSTED_INPUT_TEST_FILE],
          maxWorkers: 1,
          name: 'integration-tests:desktop-trusted-input',
          setupFiles: [METADATA_SETUP_FILE]
        }
      }
    ]
  }
});
