/**
 * @file
 *
 * The one place that says which Vitest projects exist and which runner is responsible for each.
 *
 * A project defined in `vitest-config.ts` and named by no runner is run by nothing at all, and nothing says
 * so: the suite stays green in the file listing, its `npx vitest --project <name>` still works by hand, and
 * the coverage it was written to provide silently stops existing. That is not hypothetical here twice over —
 * `unit-tests:scripts` once globbed `scripts/docs-gen/**` and left four suites run by no project, and
 * `integration-tests:desktop-trusted-input` — the repo's only desktop coverage of the trusted-input helpers —
 * sat in no aggregate from the day it was written. Both were found by a person reading the config.
 *
 * So the names live here as an enum rather than as literals spread over a config and four scripts, every
 * name is filed under the runner that owns it, and `vitest-projects.test.ts` asserts the two halves match in
 * both directions. Adding a project without deciding what runs it is then a red test rather than a silent
 * omission.
 */

/**
 * Every Vitest project this repo defines, by the name `vitest --project` takes.
 */
export enum VitestProject {
  /**
   * The Android suites, which need a real emulator through Appium.
   */
  AndroidIntegrationTests = 'integration-tests:android',

  /**
   * The plugin-less counterpart of {@link VitestProject.OwnedAttachIntegrationTests}.
   */
  BareAttachIntegrationTests = 'integration-tests:bare-attach',

  /**
   * The only project that runs under a `configDirectory` override.
   */
  ConfigDirectoryOverrideIntegrationTests = 'integration-tests:config-directory-override',

  /**
   * The desktop trusted-input suite, which runs serially because it drives the window's global pointer and
   * focus.
   */
  DesktopTrustedInputIntegrationTests = 'integration-tests:desktop-trusted-input',

  /**
   * The `enableCommunityPlugins` end-to-end suite, whose global setup seeds a demo vault with two plugins.
   */
  EnableCommunityPluginsIntegrationTests = 'integration-tests:enable-community-plugins',

  /**
   * The failed-setup regression suite, whose global setup is wired to fail.
   */
  FailedSetupIntegrationTests = 'integration-tests:failed-setup',

  /**
   * The instance-death regression suite, which destroys the instance its project owns.
   */
  InstanceDeathIntegrationTests = 'integration-tests:instance-death',

  /**
   * The default desktop integration suites, each registering its vault in-worker.
   */
  IntegrationTests = 'integration-tests',

  /**
   * The worker-attach regression suite, whose global setup owns the instance.
   */
  OwnedAttachIntegrationTests = 'integration-tests:owned-attach',

  /**
   * Everything under `scripts/` plus the docs site.
   */
  ScriptsUnitTests = 'unit-tests:scripts',

  /**
   * The `src/**` unit suites — the one project the release gate's coverage run covers.
   */
  UnitTests = 'unit-tests'
}

/**
 * The projects `npm run test:coverage` runs.
 *
 * Deliberately narrower than {@link UNIT_TEST_PROJECTS}: the 100%-per-file thresholds are a statement about
 * the shipped library, and `coverage.include` is `src/**` accordingly. This is a subset of a bucket rather
 * than a bucket of its own, so it is not part of the "every project has a runner" accounting.
 */
export const COVERAGE_TEST_PROJECTS: readonly VitestProject[] = [VitestProject.UnitTests];

/**
 * The projects `npm run test:integration` runs — the desktop aggregate.
 *
 * Everything desktop belongs here, including the serial suites. A project runs serially *within itself*
 * (`fileParallelism: false`, `maxWorkers: 1`) for reasons that say nothing about whether the aggregate should
 * invoke it; keeping one out of the aggregate on that basis is what left the trusted-input suite run by nothing.
 */
export const DESKTOP_INTEGRATION_TEST_PROJECTS: readonly VitestProject[] = [
  VitestProject.IntegrationTests,
  VitestProject.OwnedAttachIntegrationTests,
  VitestProject.BareAttachIntegrationTests,
  VitestProject.EnableCommunityPluginsIntegrationTests,
  VitestProject.ConfigDirectoryOverrideIntegrationTests,
  VitestProject.FailedSetupIntegrationTests,
  VitestProject.InstanceDeathIntegrationTests,
  VitestProject.DesktopTrustedInputIntegrationTests
];

/**
 * The projects `npm run test` and `npm run test:watch` run.
 */
export const UNIT_TEST_PROJECTS: readonly VitestProject[] = [
  VitestProject.UnitTests,
  VitestProject.ScriptsUnitTests
];

/**
 * The projects no package script runs, because a GitHub workflow runs them instead.
 *
 * `integration-tests:android` boots an emulator through Appium, which takes 140–200 s cold and needs
 * provisioning no developer machine is assumed to have. The desktop aggregate runs on every change and must
 * not do that, so the Android leg is dispatched from `.github/workflows/validate-android-emulator.yml` and
 * run by hand with `npx vitest run --project integration-tests:android`.
 *
 * This bucket is an exemption, not a dumping ground: `vitest-projects.test.ts` asserts every name in it is
 * genuinely named by a workflow file, so "nothing runs it" cannot hide in here either.
 */
export const WORKFLOW_ONLY_TEST_PROJECTS: readonly VitestProject[] = [VitestProject.AndroidIntegrationTests];

/**
 * Builds the `--project <name>` argument pairs that select a set of projects on a `vitest` command line.
 *
 * @param projects - The projects to select.
 * @returns The arguments, e.g. `['--project', 'unit-tests', '--project', 'unit-tests:scripts']`.
 */
export function toProjectArguments(projects: readonly VitestProject[]): string[] {
  return projects.flatMap((project) => ['--project', project]);
}
