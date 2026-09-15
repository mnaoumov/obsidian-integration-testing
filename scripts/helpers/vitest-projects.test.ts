/**
 * @file
 *
 * The guard that makes "a Vitest project nothing runs" impossible to add.
 *
 * `integration-tests:desktop-trusted-input` — the repo's only desktop coverage of the trusted-input helpers —
 * was defined in `vitest-config.ts`, excluded from the default aggregate like every other serial project, and
 * then named by no package script and no workflow. It was green, it was fast, and for its whole life it ran
 * exactly never. Nothing could have said so: a project is a config entry, and a runner is a command line, and
 * until this file nothing compared the two.
 *
 * So it compares them, in both directions, the way `src/public-api-barrel.test.ts` does for the barrel: every
 * project the config defines is an enum member, every enum member is defined exactly once, and every enum
 * member is filed under exactly one runner — with `WORKFLOW_ONLY_TEST_PROJECTS` checked against the workflow
 * files themselves, so the one bucket that means "no package script runs this" still has to prove something
 * does.
 */

import {
  readdirSync,
  readFileSync
} from 'node:fs';
import { join } from 'node:path';
import {
  describe,
  expect,
  it
} from 'vitest';

import { config } from '../vitest-config.ts';
import { getRootFolder } from './root.ts';
import {
  COVERAGE_TEST_PROJECTS,
  DESKTOP_INTEGRATION_TEST_PROJECTS,
  UNIT_TEST_PROJECTS,
  VitestProject,
  WORKFLOW_ONLY_TEST_PROJECTS
} from './vitest-projects.ts';

/**
 * A project entry that carries a name, which is the only shape this repo's config uses.
 */
interface NamedProject {
  readonly test: NamedProjectTest;
}

/**
 * The `test` block of a named project entry.
 */
interface NamedProjectTest {
  readonly name: string;
}

/**
 * Every runner, by the label a failure should name it with.
 */
const RUNNERS_BY_LABEL = new Map<string, readonly string[]>([
  ['DESKTOP_INTEGRATION_TEST_PROJECTS (npm run test:integration)', DESKTOP_INTEGRATION_TEST_PROJECTS],
  ['UNIT_TEST_PROJECTS (npm run test / test:watch)', UNIT_TEST_PROJECTS],
  ['WORKFLOW_ONLY_TEST_PROJECTS (a GitHub workflow)', WORKFLOW_ONLY_TEST_PROJECTS]
]);

/*
 * Read through `Object.keys` rather than the obvious `Object.values`, which this repo's stricter `lib` types
 * as `unknown[]` here: its index-signature overload does not apply to an enum object, so the value type is
 * lost. The keys are plain strings, and indexing back into the enum with one recovers it.
 */
const ALL_PROJECT_NAMES: readonly string[] = Object.keys(VitestProject)
  .map((key) => VitestProject[key as keyof typeof VitestProject]);
const DEFINED_PROJECT_NAMES = readDefinedProjectNames();

describe('vitest projects', () => {
  it('should define every project under a VitestProject name', () => {
    const unknownNames = DEFINED_PROJECT_NAMES.filter((name) => !ALL_PROJECT_NAMES.includes(name));

    expect(unknownNames).toStrictEqual([]);
  });

  it('should define every VitestProject member exactly once', () => {
    const definitionCounts = Object.fromEntries(
      ALL_PROJECT_NAMES.map((name) => [name, DEFINED_PROJECT_NAMES.filter((definedName) => definedName === name).length])
    );
    const expectedCounts = Object.fromEntries(ALL_PROJECT_NAMES.map((name) => [name, 1]));

    expect(definitionCounts).toStrictEqual(expectedCounts);
  });

  it('should file every project under exactly one runner', () => {
    // Kept as a map from the project to the runners actually found, because the two ways this fails want
    // different fixes: an empty list is the defect this file exists for — defined and run by nothing — while
    // A list of two is the same suite paid for twice in one run.
    const misfiledProjects = Object.fromEntries(
      ALL_PROJECT_NAMES
        .map((name) => [name, findRunnerLabels(name)] as const)
        .filter(([, labels]) => labels.length !== 1)
    );

    expect(misfiledProjects).toStrictEqual({});
  });

  it('should take every coverage project from the unit runner', () => {
    const strayProjects = COVERAGE_TEST_PROJECTS.filter((project) => !UNIT_TEST_PROJECTS.includes(project));

    expect(strayProjects).toStrictEqual([]);
  });

  it('should have a workflow for every project no package script runs', () => {
    const workflowText = readWorkflowText();
    const projectsWithNoWorkflow = WORKFLOW_ONLY_TEST_PROJECTS.filter((project) => !workflowText.includes(project));

    expect(projectsWithNoWorkflow).toStrictEqual([]);
  });
});

/**
 * Lists the runners a project is filed under.
 *
 * @param name - The project name to look for.
 * @returns The labels of every runner holding it — none when nothing runs it, more than one when it is
 * double-booked.
 */
function findRunnerLabels(name: string): string[] {
  return [...RUNNERS_BY_LABEL]
    .filter(([, projects]) => projects.includes(name))
    .map(([label]) => label);
}

/**
 * Tells whether a project entry is one this repo defines — an object with a `test.name`.
 *
 * Vitest also accepts a glob string and a factory function as project entries. Neither carries a name that
 * can be matched against a runner, so either would be a project this file cannot account for; the check
 * exists so such an entry is reported rather than skipped.
 *
 * @param value - The project entry to inspect.
 * @returns Whether the entry carries a name.
 */
function isNamedProject(value: unknown): value is NamedProject {
  if (typeof value !== 'object' || value === null || !('test' in value)) {
    return false;
  }

  const test: unknown = value.test;

  if (typeof test !== 'object' || test === null || !('name' in test)) {
    return false;
  }

  return typeof test.name === 'string';
}

/**
 * Reads the name of every project the config defines.
 *
 * @returns The names, with an entry that carries none rendered as a placeholder naming its index — so it
 * fails the "every project is a VitestProject name" assertion instead of vanishing from the comparison.
 */
function readDefinedProjectNames(): string[] {
  const projects = config.test?.projects ?? [];

  return projects.map((project, index) => isNamedProject(project) ? project.test.name : `<unnamed project at index ${String(index)}>`);
}

/**
 * Reads every workflow file as one blob, which is all the workflow assertion needs to search.
 *
 * @returns The concatenated text of `.github/workflows`.
 */
function readWorkflowText(): string {
  const rootFolder = getRootFolder();

  if (rootFolder === null) {
    throw new Error('Could not resolve the project root folder.');
  }

  const workflowsFolder = join(rootFolder, '.github', 'workflows');

  return readdirSync(workflowsFolder)
    .filter((fileName) => fileName.endsWith('.yml') || fileName.endsWith('.yaml'))
    .map((fileName) => readFileSync(join(workflowsFolder, fileName), 'utf-8'))
    .join('\n');
}
