import type { ReleaseType } from 'semver';
import type {
  PackageJson,
  Promisable,
  UndefinedOnPartialDeep
} from 'type-fest';

import { existsSync } from 'node:fs';
import {
  readFile,
  writeFile
} from 'node:fs/promises';
import {
  join,
  resolve as resolvePosix
} from 'node:path/posix';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  inc,
  prerelease
} from 'semver';

import {
  assertNonNullable,
  ensureNonNullable
} from '../src/type-guards.ts';
import { exitIfScriptDisabled } from './helpers/env-toggle.ts';
import {
  execFromRoot,
  getRootFolder,
  toPosixPath
} from './helpers/root.ts';

exitIfScriptDisabled();

interface NpmPackResult {
  readonly filename: string;
}

const DEFAULT_PREID = 'beta';

/*
The workflow that publishes to npm. Its filename is load-bearing twice over: npm's Trusted Publisher
configuration authorizes a run by this exact name, and this script polls for the run the release starts.
*/
const PUBLISH_WORKFLOW_FILE_NAME = 'publish-npm.yml';

enum VersionUpdateType {
  Invalid = 'invalid',
  Major = 'major',
  Manual = 'manual',
  Minor = 'minor',
  Patch = 'patch',
  PreMajor = 'premajor',
  PreMinor = 'preminor',
  PrePatch = 'prepatch',
  PreRelease = 'prerelease'
}

async function addGitTag(newVersion: string): Promise<void> {
  await execFromRoot(`git tag -a ${newVersion} -m ${newVersion} --force`, { isQuiet: true });
}

async function addUpdatedFilesToGit(newVersion: string): Promise<void> {
  await execFromRoot(['git', 'add', '--all'], { isQuiet: true });
  await execFromRoot(['git', 'commit', '-m', `chore: release ${newVersion}`, '--allow-empty'], { isQuiet: true });
}

async function assertGitHubCliInstalled(): Promise<void> {
  try {
    await execFromRoot('gh --version', { isQuiet: true });
  } catch {
    throw new Error('GitHub CLI is not installed. Please install it from https://cli.github.com/');
  }
}

async function assertGitInstalled(): Promise<void> {
  try {
    await execFromRoot('git --version', { isQuiet: true });
  } catch {
    throw new Error('Git is not installed. Please install it from https://git-scm.com/');
  }
}

async function assertGitRepoClean(): Promise<void> {
  const NOT_CLEAN_MESSAGE = 'Git repository is not clean. Please commit or stash your changes before releasing a new version.';

  let stdout: string;
  try {
    stdout = await execFromRoot('git status --porcelain --untracked-files=all', { isQuiet: true });
  } catch {
    throw new Error(NOT_CLEAN_MESSAGE);
  }

  if (stdout) {
    throw new Error(NOT_CLEAN_MESSAGE);
  }
}

async function getNewVersion(versionUpdateType: string): Promise<string> {
  const versionType = getVersionUpdateType(versionUpdateType);
  if (versionType === VersionUpdateType.Manual) {
    return versionUpdateType;
  }

  const packageJson = await readPackageJson();
  const currentVersion = packageJson.version ?? '';

  const releaseType = versionType as ReleaseType;
  const isPreReleaseType = releaseType.startsWith('pre');
  const newVersion = isPreReleaseType
    ? inc(currentVersion, releaseType, DEFAULT_PREID)
    : inc(currentVersion, releaseType);
  assertNonNullable(newVersion, `Failed to increment version from '${currentVersion}' with type '${versionType}'`);

  return newVersion;
}

async function getReleaseNotes(newVersion: string): Promise<string> {
  const changelogPath = resolvePathFromRootSafe('CHANGELOG.md');
  const content = await readFile(changelogPath, 'utf-8');
  const newVersionEscaped = newVersion.replace('.', String.raw`\.`);
  const match = new RegExp(`\n## ${newVersionEscaped}\n\n((.|\n)+?)\n\n##`).exec(content);
  let releaseNotes = match?.[1] ? `${match[1]}\n\n` : '';

  const tagsOutput = await execFromRoot('git tag --sort=-creatordate', { isQuiet: true });
  const tags = tagsOutput.split(/\r?\n/);
  const previousVersion = tags[1];

  const repoUrl = await getRepoUrl();

  const changesUrl = previousVersion ? `${repoUrl}/compare/${previousVersion}...${newVersion}` : `${repoUrl}/commits/${newVersion}`;

  releaseNotes += `**Full Changelog**: ${changesUrl}`;
  return releaseNotes;
}

async function getRepoUrl(): Promise<string> {
  return await execFromRoot('gh repo view --json url -q .url', { isQuiet: true });
}

function getVersionUpdateType(versionUpdateType: string): VersionUpdateType {
  const versionUpdateTypeEnum = versionUpdateType as VersionUpdateType;
  switch (versionUpdateTypeEnum) {
    case VersionUpdateType.Major:
    case VersionUpdateType.Minor:
    case VersionUpdateType.Patch:
    case VersionUpdateType.PreMajor:
    case VersionUpdateType.PreMinor:
    case VersionUpdateType.PrePatch:
    case VersionUpdateType.PreRelease: {
      return versionUpdateTypeEnum;
    }

    default: {
      if (/^\d+\.\d+\.\d+(?:-[\w\d.-]+)?$/.test(versionUpdateType)) {
        return VersionUpdateType.Manual;
      }

      return VersionUpdateType.Invalid;
    }
  }
}

async function gitPush(): Promise<void> {
  await execFromRoot('git push --follow-tags --force', { isQuiet: true });
}

function isPreRelease(version: string): boolean {
  return prerelease(version) !== null;
}

async function main(): Promise<void> {
  const [, , versionUpdateType] = process.argv;
  await updateVersion(versionUpdateType);
}

/**
 * Parses `gh run list --json`, treating unusable output as "no runs yet".
 *
 * `gh run list --workflow <file>` errors outright until GitHub has seen that workflow at least once, and the
 * first release after the publish workflow lands hits exactly that window. Keep polling instead of failing a
 * release that is otherwise complete.
 */
function parseWorkflowRuns(runListOutput: string): WorkflowRun[] {
  try {
    return JSON.parse(runListOutput) as WorkflowRun[];
  } catch {
    return [];
  }
}

async function publishGitHubRelease(newVersion: string): Promise<void> {
  const resultOutput = await execFromRoot(['npm', 'pack', '--pack-destination', 'dist', '--json'], { isQuiet: true });
  const result = JSON.parse(resultOutput) as [NpmPackResult];
  let filePaths = [
    join('dist', result[0].filename)
  ];

  filePaths = filePaths.filter((filePath) => existsSync(resolvePathFromRootSafe(filePath)));

  await execFromRoot([
    'gh',
    'release',
    'create',
    newVersion,
    ...filePaths,
    '--title',
    `v${newVersion}`,
    ...(isPreRelease(newVersion) ? ['--prerelease'] : []),
    '--notes-file',
    '-'
  ], {
    isQuiet: true,
    stdin: await getReleaseNotes(newVersion)
  });
}

function toFirstLine(string_: string): string {
  return string_.split(/\r?\n/).filter(Boolean).slice(0, 1).join('');
}

async function updateChangelog(newVersion: string): Promise<void> {
  const HEADER_LINES_COUNT = 2;
  const changelogPath = resolvePathFromRootSafe('CHANGELOG.md');
  let previousChangelogLines: string[];
  if (existsSync(changelogPath)) {
    const content = await readFile(changelogPath, 'utf-8');
    previousChangelogLines = content.split('\n').slice(HEADER_LINES_COUNT);
    if (previousChangelogLines.at(-1) === '') {
      previousChangelogLines.pop();
    }
  } else {
    previousChangelogLines = [];
  }

  const lastTag = (previousChangelogLines[0] ?? '').replaceAll('## ', '');
  const commitRange = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  const commitMessagesString = await execFromRoot(`git log ${commitRange} --format=%B --first-parent -z`, { isQuiet: true });
  const commitMessages = commitMessagesString.split('\0').filter(Boolean).map((message) => toFirstLine(message));

  let newChangeLog = `# CHANGELOG\n\n## ${newVersion}\n\n`;

  for (const message of commitMessages) {
    newChangeLog += `- ${message}\n`;
  }

  if (previousChangelogLines.length > 0) {
    newChangeLog += '\n';
    for (const line of previousChangelogLines) {
      newChangeLog += `${line}\n`;
    }
  }

  await writeFile(changelogPath, newChangeLog, 'utf-8');

  if (!process.stdin.isTTY) {
    console.log('Non-interactive session detected; using the generated CHANGELOG.md as-is.');
    return;
  }

  const codeVersion = await execFromRoot('code --version', {
    isQuiet: true,
    shouldIgnoreExitCode: true
  });

  if (codeVersion) {
    console.log('Please update the CHANGELOG.md file. Close Visual Studio Code when you are done...');
    await execFromRoot(['code', '-w', changelogPath], {
      isQuiet: true,
      shouldIgnoreExitCode: true
    });
  } else {
    console.log('Could not find Visual Studio Code in your PATH. Using console mode instead.');
    await createInterface(process.stdin, process.stdout).question(
      'Please update the CHANGELOG.md file. Press Enter when you are done...'
    );
  }
}

async function updateVersion(versionUpdateType?: string): Promise<void> {
  if (!versionUpdateType) {
    const npmOldVersion = process.env['npm_old_version'];
    const npmNewVersion = process.env['npm_new_version'];

    if (npmOldVersion && npmNewVersion) {
      await updateVersionInFiles(npmOldVersion);
      await updateVersion(npmNewVersion);
      return;
    }

    throw new Error('No version update type provided');
  }

  validate(versionUpdateType);
  await assertGitInstalled();
  await assertGitRepoClean();
  await assertGitHubCliInstalled();
  await npmRun('format:check');
  await npmRun('spellcheck');
  await npmRun('lint:md');
  await npmRun('build');
  await npmRun('lint');
  await npmRun('test:coverage');

  const newVersion = await getNewVersion(versionUpdateType);
  await updateVersionInFiles(newVersion);
  await updateChangelog(newVersion);
  await addUpdatedFilesToGit(newVersion);
  await addGitTag(newVersion);
  await gitPush();
  await publishGitHubRelease(newVersion);
  await watchNpmPublishWorkflow(newVersion);
}

async function updateVersionInFiles(newVersion: string): Promise<void> {
  await editPackageJson((packageJson) => {
    packageJson.version = newVersion;
  });

  await editPackageLockJson(update, { shouldSkipIfMissing: true });
  await editNpmShrinkWrapJson(update, { shouldSkipIfMissing: true });

  function update(packageLockJson: PackageLockJson): void {
    packageLockJson.version = newVersion;
    const defaultPackage = packageLockJson.packages?.[''];
    if (defaultPackage) {
      defaultPackage.version = newVersion;
    }
  }
}

function validate(versionUpdateType: string): void {
  if (getVersionUpdateType(versionUpdateType) === VersionUpdateType.Invalid) {
    throw new Error(
      'Invalid version update type. Please use \'major\', \'minor\', \'patch\', \'premajor\', \'preminor\', \'prepatch\', \'prerelease\', or \'x.y.z[-suffix]\' format.'
    );
  }
}

/**
 * Resolves the id of the `publish-npm.yml` run started by the release that was just published, or `null`
 * when no run shows up in time.
 *
 * The run is matched by the commit the tag points at rather than by branch: a `release`-triggered run
 * reports the tag it came from, and a re-run of a failed publish keeps the same head SHA.
 */
async function waitForPublishWorkflowRunId(newVersion: string): Promise<null | string> {
  const POLL_ATTEMPT_COUNT = 24;
  const POLL_INTERVAL_IN_MILLISECONDS = 5000;
  const RUN_LIST_LIMIT = '20';

  const commitSha = await execFromRoot(['git', 'rev-list', '-n', '1', newVersion], { isQuiet: true });

  for (let attempt = 0; attempt < POLL_ATTEMPT_COUNT; attempt++) {
    const runListOutput = await execFromRoot([
      'gh',
      'run',
      'list',
      '--workflow',
      PUBLISH_WORKFLOW_FILE_NAME,
      '--limit',
      RUN_LIST_LIMIT,
      '--json',
      'databaseId,headSha'
    ], {
      isQuiet: true,
      shouldIgnoreExitCode: true
    });

    const runs = parseWorkflowRuns(runListOutput);
    const run = runs.find((candidate) => candidate.headSha === commitSha);
    if (run) {
      return String(run.databaseId);
    }

    await sleep(POLL_INTERVAL_IN_MILLISECONDS);
  }

  return null;
}

/**
 * Follows the npm publish to completion so a failed publish fails this script too.
 *
 * Publishing moved to GitHub Actions when the long-lived `NPM_TOKEN` was replaced by a Trusted Publisher:
 * npm mints its short-lived credential from the workflow's OIDC token, which only a supported CI runner can
 * produce, so there is nothing left here to publish with. Without this wait a broken publish would be
 * invisible and the release would look complete.
 */
async function watchNpmPublishWorkflow(newVersion: string): Promise<void> {
  const repoUrl = await getRepoUrl();
  const runId = await waitForPublishWorkflowRunId(newVersion);

  if (!runId) {
    console.warn(
      `Could not find a ${PUBLISH_WORKFLOW_FILE_NAME} run for ${newVersion}. Check ${repoUrl}/actions/workflows/${PUBLISH_WORKFLOW_FILE_NAME} and start it manually if needed.`
    );
    return;
  }

  console.log(`Publishing to npm: ${repoUrl}/actions/runs/${runId}`);
  await execFromRoot(['gh', 'run', 'watch', runId, '--exit-status']);
}

await main();

interface EditJsonOptions {
  readonly shouldSkipIfMissing?: boolean;
}

interface EditPackageJsonOptions {
  readonly cwd?: string;
  readonly shouldSkipIfMissing?: boolean;
}

interface PackageLockJson extends Partial<PackageJson> {
  packages?: Record<string, PackageJson>;
}

interface WorkflowRun {
  readonly databaseId: number;
  readonly headSha: string;
}

export function resolve(...pathSegments: string[]): string {
  const WINDOWS_POSIX_LIKE_PATH_REG_EXP = /[a-zA-Z]:\/[^:]*$/;
  let path = resolvePosix(...pathSegments);
  path = toPosixPath(path);
  const match = WINDOWS_POSIX_LIKE_PATH_REG_EXP.exec(path);
  return match?.[0] ?? path;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- It makes `editFunction` strongly typed.
async function editJson<T>(
  path: string,
  editFunction: (data: T) => Promisable<void>,
  options: EditJsonOptions = {}
): Promise<void> {
  const {
    shouldSkipIfMissing
  } = options;
  if (shouldSkipIfMissing && !existsSync(path)) {
    return;
  }
  const data = await readJson<T>(path);
  await editFunction(data);
  await writeJson(path, data);
}

async function editNpmShrinkWrapJson(
  editFunction: (packageLockJson: PackageLockJson) => Promisable<void>,
  options: EditPackageJsonOptions = {}
): Promise<void> {
  const {
    cwd,
    shouldSkipIfMissing
  } = options;
  await editJson<PackageJson>(getNpmShrinkWrapJsonPath(cwd), editFunction, normalizeOptionalProperties<EditJsonOptions>({ shouldSkipIfMissing }));
}

async function editPackageJson(
  editFunction: (packageJson: PackageJson) => Promisable<void>,
  options: EditPackageJsonOptions = {}
): Promise<void> {
  const {
    cwd,
    shouldSkipIfMissing
  } = options;
  await editJson<PackageJson>(getPackageJsonPath(cwd), editFunction, normalizeOptionalProperties<EditJsonOptions>({ shouldSkipIfMissing }));
}

async function editPackageLockJson(
  editFunction: (packageLockJson: PackageLockJson) => Promisable<void>,
  options: EditPackageJsonOptions = {}
): Promise<void> {
  const {
    cwd,
    shouldSkipIfMissing
  } = options;
  await editJson<PackageJson>(getPackageLockJsonPath(cwd), editFunction, normalizeOptionalProperties<EditJsonOptions>({ shouldSkipIfMissing }));
}

function getNpmShrinkWrapJsonPath(cwd?: string): string {
  return ensureNonNullable(resolvePathFromRoot('npm-shrinkwrap.json', cwd), 'Could not determine the npm-shrinkwrap.json path');
}

function getPackageJsonPath(cwd?: string): string {
  return ensureNonNullable(resolvePathFromRoot('package.json', cwd), 'Could not determine the package.json path');
}

function getPackageLockJsonPath(cwd?: string): string {
  return ensureNonNullable(resolvePathFromRoot('package-lock.json', cwd), 'Could not determine the package-lock.json path');
}

function normalizeOptionalProperties<T>(object: UndefinedOnPartialDeep<T>): T {
  return object as T;
}

async function npmRun(command: string): Promise<void> {
  await execFromRoot(['npm', 'run', command]);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

async function readPackageJson(cwd?: string): Promise<PackageJson> {
  return await readJson<PackageJson>(getPackageJsonPath(cwd));
}

function resolvePathFromRoot(path: string, cwd?: string): null | string {
  const rootFolder = getRootFolder(cwd);
  if (!rootFolder) {
    return null;
  }

  return resolve(rootFolder, path);
}

function resolvePathFromRootSafe(path: string, cwd?: string): string {
  return resolvePathFromRoot(path, cwd) ?? path;
}

async function writeJson(path: string, data: unknown): Promise<void> {
  const JSON_INDENT = 2;
  await writeFile(path, `${ensureNonNullable(JSON.stringify(data, null, JSON_INDENT))}\n`);
}
