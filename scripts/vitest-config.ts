import { defineConfig } from 'vitest/config';

import {
  defineObsidianMetadataGlobal,
  readMetadataJsonText
} from './helpers/metadata-global.ts';
import { VitestProject } from './helpers/vitest-projects.ts';

const SHARED_EXCLUDE = ['node_modules', 'dist'];
const INTEGRATION_TEST_FILES = 'src/**/*.integration.test.ts';
const JEST_TEST_FILES = 'src/**/*.jest.test.ts';
// Every test under `scripts/` — the vendored docs generator (L35), the custom ESLint rules, and the
// release-script helpers. Deliberately the whole tree rather than `scripts/docs-gen/**`, which is what it
// used to be: that narrower glob silently left `scripts/helpers/eslint-rules/*.test.ts` run by no project
// at all, and left `scripts/version.ts` with nowhere to put a regression test at all.
const SCRIPTS_TEST_FILES = 'scripts/**/*.test.ts';
const DOCS_SITE_TEST_FILES = 'docs/src/**/*.test.ts';
const BIG_TIMEOUT_IN_MILLISECONDS = 30_000;

// Vitest 4 projects do NOT inherit the root-level `test` options, so a project that omits `testTimeout`
// silently runs on the built-in 5000 ms default. That is how the release gate went flaky: every
// project here carried a budget EXCEPT `unit-tests` — the only one `npm run test:coverage` runs — so the
// one project gating a release had the tightest budget in the repo. Spreading the default into each project
// makes the omission impossible rather than merely unlikely. The budget covers two costs a per-suite number
// cannot: v8 coverage instrumentation, measured at ~2.2x on this project, and the CPU contention of a busy
// machine. Suites that are genuinely slow in their own right — rendering an OG image with satori + resvg,
// building a ts-morph Project over the whole `tsconfig.json` — sit comfortably inside it.
const SHARED_TEST_DEFAULTS = { testTimeout: BIG_TIMEOUT_IN_MILLISECONDS };

// The owned-instance worker-attach regression suite runs in its own project: it
// owns the instance in the global setup and evals from a worker (every other
// integration suite registers in-worker), so it needs the harness-owned global
// setup plus the per-worker `vitest-setup` resolvers.
const OWNED_ATTACH_TEST_FILE = 'src/owned-instance-worker-attach.integration.test.ts';

// The plugin-less counterpart of the owned-attach suite: it owns the instance in
// the global setup via `createSetup({ installPlugin: false })` and evals from a
// worker, so it likewise needs its own global setup plus the per-worker
// `vitest-setup` resolvers.
const BARE_ATTACH_TEST_FILE = 'src/bare-instance-worker-attach.integration.test.ts';

// The `enableCommunityPlugins` end-to-end suite runs in its own project: its global
// setup seeds a demo vault with two dummy plugins (via `buildDemoVaultPopulate`) and
// enables them through `createSetup({ enableCommunityPlugins })`, then the worker
// asserts both loaded — so it needs its own global setup plus the per-worker resolvers.
const ENABLE_COMMUNITY_PLUGINS_TEST_FILE = 'src/enable-community-plugins.integration.test.ts';

// The `configDirectory` override suite runs in its own project because the override is a property of the
// whole run: its global setup opens the owned vault under `.obsidian-desktop`, and every other integration
// project deliberately runs under Obsidian's default. It evals from a worker to assert that what the harness
// wrote before open — the seeded plugin, the headless `app.json` — actually reached the folder the vault
// opened, so it needs its own global setup plus the per-worker resolvers.
const CONFIG_DIRECTORY_OVERRIDE_TEST_FILE = 'src/config-directory-override.integration.test.ts';
// Kept in sync with the `CONFIG_DIRECTORY` the companion test asserts `app.vault.configDir` against.
const CONFIG_DIRECTORY_OVERRIDE = '.obsidian-desktop';

// The failed-setup regression suite runs in its own project because its global setup must FAIL:
// It attaches to a CDP port nothing can serve, so every test in it runs in the state a worker is left in
// after a real setup failure. Port 1 is refused outright by `fetch`, so the failure is instant and never
// touches the network -- and an `obsidian-cdp` transport takes no setup lock, unlike an Appium one, so
// this project stays hermetic and safe inside the default aggregate.
const FAILED_SETUP_TEST_FILE = 'src/failed-setup-fail-fast.integration.test.ts';
const UNREACHABLE_CDP_PORT = 1;

// The instance-death regression suite runs in its own project because it DESTROYS the instance its project
// shares — the same reason the failed-setup suite has one. It owns the instance in the global setup and evals
// from a worker, so it needs the per-worker resolvers; the plugin-less setup is enough, since what is under
// test is the death of the instance rather than anything in a vault.
const INSTANCE_DEATH_TEST_FILE = 'src/owned-instance-death.integration.test.ts';

// The Android suites run in their own project because they are the only ones that need a real Android
// emulator through Appium (see L39). Keeping them out of the default `integration-tests` aggregate is
// deliberate: that aggregate is desktop, runs on every change, and must not boot an emulator. That
// exemption is declared where it can be checked — `WORKFLOW_ONLY_TEST_PROJECTS` in
// `helpers/vitest-projects.ts`, which asserts a workflow really does run what no package script does. They
// share one project rather than taking one each, because each project boots its own emulator session — the
// cost that dominates an Android run — and these files are serialized within it anyway.
const ANDROID_TEST_FILES = [
  'src/mobile-trusted-input.android.integration.test.ts',
  'src/eval-cap.android.integration.test.ts',
  'src/headless-vault-config.android.integration.test.ts'
];

// Its desktop counterpart runs serially for the reason L11 gives consumers: trusted input targets the
// single shared window's GLOBAL focus and pointer, so pointer-dependent files cannot run against each
// other — which the default `integration-tests` project does not guarantee. That is a statement about how
// this project runs its own files, and NOT a reason to keep it out of the desktop aggregate: it is in
// `DESKTOP_INTEGRATION_TEST_PROJECTS` like every other desktop project, it launches its own isolated
// instance (L7), and it is the only integration file in the repo that touches the pointer or the keyboard,
// so there is nothing for it to race. Until it was added to that list it sat in no aggregate at all, which
// left the repo's only desktop coverage of the trusted-input helpers run by nothing.
const DESKTOP_TRUSTED_INPUT_TEST_FILE = 'src/trusted-input.desktop.integration.test.ts';

// An emulator run is 140-200s cold (L19), and every step before the first assertion — boot, Appium session,
// vault push, app restart — happens inside the hooks. Raised by the 120s the network-ready gate can add on
// A guest that never reports a validated default network (L45); `afterAll`'s dispose builds a
// transport of its own, so it needs the same headroom the registration hook does.
const ANDROID_TIMEOUT_IN_MILLISECONDS = 420_000;

// Inject the per-version compatibility table into `obsidian-metadata.ts` under
// test, the same way the esbuild build does via `define`. Two mechanisms are
// needed because Vitest's per-project `define` reaches the unit-test project but
// not the integration-test projects (a known quirk): the unit-test project uses
// `define` (a string value is substituted as a raw expression, so the JSON text
// becomes an object literal replacing the `OBSIDIAN_METADATA` global — keeping the
// unit project filesystem-free), while the integration-test projects publish the
// same table as a global via `METADATA_SETUP_FILE`.
const DEFINE = {
  OBSIDIAN_METADATA: readMetadataJsonText()
};
const METADATA_SETUP_FILE = './scripts/metadata-global-setup.ts';

// The integration projects' global-setup modules (owned-attach / bare-attach) run in
// the Vitest main process, where the per-project `define` (unit-tests only) and the
// per-worker `METADATA_SETUP_FILE` setupFile do NOT apply. Publish the table as a
// global here — this config is evaluated in that same main process — so a global
// setup importing the harness chain resolves `OBSIDIAN_METADATA` instead of throwing
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
          name: VitestProject.UnitTests,
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
          name: VitestProject.ScriptsUnitTests
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
            CONFIG_DIRECTORY_OVERRIDE_TEST_FILE,
            FAILED_SETUP_TEST_FILE,
            INSTANCE_DEATH_TEST_FILE,
            ...ANDROID_TEST_FILES,
            DESKTOP_TRUSTED_INPUT_TEST_FILE
          ],
          include: [INTEGRATION_TEST_FILES],
          name: VitestProject.IntegrationTests,
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
          name: VitestProject.OwnedAttachIntegrationTests,
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
          // exercising it end-to-end — no wrapper needed.
          globalSetup: ['./src/vitest/global-setup-no-plugin.ts'],
          include: [BARE_ATTACH_TEST_FILE],
          maxWorkers: 1,
          name: VitestProject.BareAttachIntegrationTests,
          setupFiles: [METADATA_SETUP_FILE, './src/vitest/setup.ts']
        }
      },
      {
        test: {
          ...SHARED_TEST_DEFAULTS,
          environment: 'node',
          // The whole point of this project: a global setup that FAILS. It points the standard
          // plugin-less setup at a CDP port nothing serves, so `registerVault` throws and the adapter
          // stores the failure instead of publishing a transport.
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
          name: VitestProject.FailedSetupIntegrationTests,
          setupFiles: [METADATA_SETUP_FILE, './src/vitest/setup.ts']
        }
      },
      {
        test: {
          ...SHARED_TEST_DEFAULTS,
          environment: 'node',
          exclude: SHARED_EXCLUDE,
          fileParallelism: false,
          globalSetup: ['./src/vitest/global-setup-no-plugin.ts'],
          include: [INSTANCE_DEATH_TEST_FILE],
          maxWorkers: 1,
          name: VitestProject.InstanceDeathIntegrationTests,
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
          name: VitestProject.EnableCommunityPluginsIntegrationTests,
          setupFiles: [METADATA_SETUP_FILE, './src/vitest/setup.ts']
        }
      },
      {
        test: {
          ...SHARED_TEST_DEFAULTS,
          environment: 'node',
          // The whole point of the project: the owned vault opens under a config folder that is not
          // `.obsidian`, so every pre-open write the harness makes has to follow it there.
          environmentOptions: {
            obsidianTransport: {
              configDirectory: CONFIG_DIRECTORY_OVERRIDE,
              type: 'obsidian-cdp'
            }
          },
          exclude: SHARED_EXCLUDE,
          fileParallelism: false,
          globalSetup: ['./scripts/config-directory-override-global-setup.ts'],
          include: [CONFIG_DIRECTORY_OVERRIDE_TEST_FILE],
          maxWorkers: 1,
          name: VitestProject.ConfigDirectoryOverrideIntegrationTests,
          setupFiles: [METADATA_SETUP_FILE, './src/vitest/setup.ts']
        }
      },
      {
        test: {
          ...SHARED_TEST_DEFAULTS,
          environment: 'node',
          exclude: SHARED_EXCLUDE,
          // One emulator, one Appium server, and trusted input targets the app's GLOBAL focus and pointer,
          // so these files cannot run against each other (the same reason L8/L11 give consumers).
          fileParallelism: false,
          // Takes the shared-emulator lock (L7). This project has no transport global setup, so it never
          // goes through `coreSetup` — which is what normally acquires it.
          globalSetup: ['./scripts/android-global-setup.ts'],
          hookTimeout: ANDROID_TIMEOUT_IN_MILLISECONDS,
          include: ANDROID_TEST_FILES,
          maxWorkers: 1,
          name: VitestProject.AndroidIntegrationTests,
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
          name: VitestProject.DesktopTrustedInputIntegrationTests,
          setupFiles: [METADATA_SETUP_FILE]
        }
      }
    ]
  }
});
