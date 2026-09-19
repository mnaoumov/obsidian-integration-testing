import type { ReleaseType } from 'semver';
import type {
  PackageJson,
  Promisable,
  UndefinedOnPartialDeep
} from 'type-fest';

import { existsSync } from 'node:fs';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  join,
  resolve as resolvePosix
} from 'node:path/posix';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  inc,
  prerelease,
  rcompare,
  valid
} from 'semver';

import {
  assertNonNullable,
  ensureNonNullable
} from '../src/type-guards.ts';
import {
  findBreakingCommitSubjects,
  isMajorRaise
} from './helpers/breaking-change.ts';
import { toChangelogSectionDocument } from './helpers/changelog-section.ts';
import { spellcheckContent } from './helpers/cspell-content.ts';
import { exitIfScriptDisabled } from './helpers/env-toggle.ts';
import { lintMarkdownContent } from './helpers/markdownlint-content.ts';
import { parseNpmPackFilename } from './helpers/npm-pack.ts';
import { getPackageManagerRunCommand } from './helpers/package-manager.ts';
import {
  execFromRoot,
  getRootFolder,
  toPosixPath
} from './helpers/root.ts';

exitIfScriptDisabled();

/*
The one file this script settles, checks and writes. Named rather than repeated, because every message a
failed settle prints has to name it too.
*/
const CHANGELOG_FILE_NAME = 'CHANGELOG.md';

const DEFAULT_PREID = 'beta';

/*
One of the two npm scripts whose checks the settled changelog is held to, named in the messages so a reader
knows which gate they are looking at -- and knows that fixing it here is the same fix as fixing it on the
branch. Both scripts run over every settle, and a message names whichever of them actually reported
something.
*/
const LINT_MD_SCRIPT_NAME = 'lint:md';

/*
The workflow that publishes to npm. Its filename is load-bearing twice over: npm's Trusted Publisher
configuration authorizes a run by this exact name, and this script polls for the run the release starts.
*/
const PUBLISH_WORKFLOW_FILE_NAME = 'publish-npm.yml';

/*
The other one. See LINT_MD_SCRIPT_NAME.
*/
const SPELLCHECK_SCRIPT_NAME = 'spellcheck';

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

/**
 * Refuses a release that does not raise the major while unreleased commits declare a breaking change.
 *
 * Deliberately part of the `assert*` pre-flight rather than a gate: it reads two `git` commands and
 * decides in seconds, so the refusal arrives before `build` and `test:coverage` rather than after them.
 *
 * @param newVersion - The RESOLVED version about to be cut, not the argument the user typed.
 * @throws If any commit since the last tag is breaking and this release keeps the major. The message
 * names every offending subject, because the subject is the thing to go and look at.
 */
async function assertBreakingChangesAreReleasedAsMajor(newVersion: string): Promise<void> {
  const lastTag = await getLastTag();
  const commitRange = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  const rawGitLogOutput = await execFromRoot(`git log ${commitRange} --format=%B -z`, { isQuiet: true });
  const breakingCommitSubjects = findBreakingCommitSubjects(rawGitLogOutput);

  if (breakingCommitSubjects.length === 0) {
    return;
  }

  const packageJson = await readPackageJson();
  const currentVersion = packageJson.version ?? '';
  const lastReleasedStableVersion = await getLastReleasedStableVersion();

  if (isMajorRaise({ currentVersion, lastReleasedStableVersion, newVersion })) {
    return;
  }

  const subjectList = breakingCommitSubjects.map((subject) => `  - ${subject}`).join('\n');
  throw new Error(
    `Refusing to release ${newVersion}: ${String(breakingCommitSubjects.length)} unreleased commit(s) ${lastTag ? `since ${lastTag}` : 'in this repository'} declare a breaking change:\n`
      + `${subjectList}\n`
      + `A breaking change must raise the major. Use 'major' or 'premajor', or a manual version above ${currentVersion}'s major -- or drop the breaking declaration from the commit(s).`
  );
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

/**
 * Composes the `CHANGELOG.md` the release would publish, in memory and without writing anything.
 *
 * The new section is built from the first-parent commit subjects since the version the file's own first
 * heading names, and the previous sections are carried underneath it unchanged.
 *
 * @param newVersion - The version whose section is being composed.
 * @param changelogPath - The absolute path of `CHANGELOG.md`.
 * @returns A {@link Promise} that resolves to the full composed content.
 */
async function composeChangelog(newVersion: string, changelogPath: string): Promise<string> {
  const HEADER_LINES_COUNT = 2;
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

  return newChangeLog;
}

/**
 * Runs every check the settled changelog is held to over its NEW section, and returns what they reported.
 *
 * Only the new section is checked, and deliberately so -- the reason is on
 * {@link toChangelogSectionDocument}'s own module.
 *
 * BOTH checks run over every settle, and neither short-circuits the other. An author who has a hard-wrapped
 * line and a coined word is told about both at once, in one round of the review, rather than fixing one and
 * being sent back for the other.
 *
 * @param changelogContent - The full composed `CHANGELOG.md` content.
 * @param version - The version whose section is about to be published.
 * @param changelogPath - The absolute path the section is checked AS, which is what makes both checks this
 * repository's own rather than generic ones.
 * @returns A {@link Promise} that resolves to the findings, or an empty array when the section is clean.
 */
async function getChangelogSectionFindings(changelogContent: string, version: string, changelogPath: string): Promise<ChangelogFinding[]> {
  const content = toChangelogSectionDocument(changelogContent, version);

  const markdownlintFindings = await lintMarkdownContent({
    content,
    filePath: changelogPath
  });
  const spellingFindings = await spellcheckContent({
    content,
    filePath: changelogPath
  });

  return [
    ...markdownlintFindings.map((text) => ({
      scriptName: LINT_MD_SCRIPT_NAME,
      text
    })),
    ...spellingFindings.map((text) => ({
      scriptName: SPELLCHECK_SCRIPT_NAME,
      text
    }))
  ];
}

/**
 * Resolves the highest non-prerelease version ever tagged.
 *
 * The prerelease case needs this and cannot use {@link getLastTag}: after a `premajor`, the nearest tag IS
 * the prerelease, so the question "was the major already raised?" has to be asked against the last STABLE
 * release instead.
 *
 * @returns The highest stable tagged version, or `null` when the package has never had a stable release.
 */
async function getLastReleasedStableVersion(): Promise<null | string> {
  const tagsOutput = await execFromRoot('git tag --list', { isQuiet: true });
  const stableVersions = tagsOutput
    .split(/\r?\n/)
    .map((tag) => valid(tag.trim()))
    .filter((version): version is string => version !== null && prerelease(version) === null)
    .sort(rcompare);

  return stableVersions[0] ?? null;
}

/**
 * Resolves the nearest tag reachable from `HEAD` — the last release, whatever its branch history.
 *
 * @returns The tag name, or an empty string when the repository has no tag yet, in which case the caller
 * reads the whole history instead.
 */
async function getLastTag(): Promise<string> {
  const lastTag = await execFromRoot('git describe --tags --abbrev=0', {
    isQuiet: true,
    shouldIgnoreExitCode: true
  });
  return lastTag.trim();
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
  const changelogPath = resolvePathFromRootSafe(CHANGELOG_FILE_NAME);
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
      return /^\d+\.\d+\.\d+(?:-[\w\d.-]+)?$/.test(versionUpdateType) ? VersionUpdateType.Manual : VersionUpdateType.Invalid;
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
  let filePaths = [
    join('dist', parseNpmPackFilename(resultOutput))
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

/**
 * Hands the composed changelog to the user for review on a scratch copy OUTSIDE the repository, and returns
 * whatever they left behind. The scratch folder is removed even when the review fails.
 *
 * The scratch copy is what makes "settled before it is written" possible at all: the review used to edit
 * `CHANGELOG.md` itself, so by the time anything could check the result it was already in the working tree.
 *
 * @param newChangeLog - The composed `CHANGELOG.md` content to hand over for review.
 * @param findings - The findings the previous round of this review left unfixed, printed above the prompt so
 * the author sees what has to change. Empty on the first round.
 * @returns A {@link Promise} that resolves to the reviewed content.
 */
async function reviewChangelog(newChangeLog: string, findings: ChangelogFinding[]): Promise<string> {
  const scratchFolder = await mkdtemp(join(toPosixPath(tmpdir()), 'obsidian-integration-testing-changelog-'));
  const scratchChangelogPath = join(toPosixPath(scratchFolder), CHANGELOG_FILE_NAME);

  try {
    await writeFile(scratchChangelogPath, newChangeLog, 'utf-8');

    if (findings.length > 0) {
      console.log(`${CHANGELOG_FILE_NAME} does not pass ${toFailedScriptNames(findings)} yet:\n${toFindingLines(findings)}`);
    }

    const codeVersion = await execFromRoot('code --version', {
      isQuiet: true,
      shouldIgnoreExitCode: true
    });

    if (codeVersion) {
      console.log(`Please update the ${CHANGELOG_FILE_NAME} file. Close Visual Studio Code when you are done...`);
      await execFromRoot(['code', '-w', scratchChangelogPath], {
        isQuiet: true,
        shouldIgnoreExitCode: true
      });
    } else {
      console.log('Could not find Visual Studio Code in your PATH. Using console mode instead.');
      await createInterface(process.stdin, process.stdout).question(
        `Please update the ${scratchChangelogPath} file. Press Enter when you are done...`
      );
    }

    return await readFile(scratchChangelogPath, 'utf-8');
  } finally {
    await rm(scratchFolder, {
      force: true,
      recursive: true
    });
  }
}

/**
 * Holds the composed changelog to `lint:md`'s and `spellcheck`'s checks until its NEW section passes both.
 *
 * The checks run on the SETTLED text, so the review sits inside the loop rather than before it: the author is
 * still sitting at the editor, so they are handed the findings and the same scratch copy back. A review that
 * returns byte-identical text is the author declining to fix them, which ends the loop instead of reopening
 * for ever. There is nobody to hand a finding to in a non-interactive release, so that path throws on the
 * first one.
 *
 * @param newChangeLog - The composed `CHANGELOG.md` content.
 * @param newVersion - The version whose section is about to be published.
 * @param changelogPath - The absolute path the section is checked AS, which is what makes the checks this
 * repository's own rather than generic ones.
 * @returns A {@link Promise} that resolves to the settled content, ready to be written.
 * @throws If the new section does not pass `lint:md` and `spellcheck`, and nobody fixes it.
 */
async function settleChangelog(newChangeLog: string, newVersion: string, changelogPath: string): Promise<string> {
  const isReviewDue = process.stdin.isTTY;

  if (!isReviewDue) {
    console.log(
      `Non-interactive session detected; the generated ${CHANGELOG_FILE_NAME} is used as-is, and a ${LINT_MD_SCRIPT_NAME} or ${SPELLCHECK_SCRIPT_NAME} finding stops the release rather than opening a review.`
    );
  }

  let settledChangeLog = newChangeLog;
  let findings: ChangelogFinding[] = [];

  for (;;) {
    if (isReviewDue) {
      const reviewedChangeLog = await reviewChangelog(settledChangeLog, findings);
      if (findings.length > 0 && reviewedChangeLog === settledChangeLog) {
        throw toChangelogFindingsError(findings, newVersion);
      }

      settledChangeLog = reviewedChangeLog;
    }

    findings = await getChangelogSectionFindings(settledChangeLog, newVersion, changelogPath);

    if (findings.length === 0) {
      return settledChangeLog;
    }

    if (!isReviewDue) {
      throw toChangelogFindingsError(findings, newVersion);
    }
  }
}

/**
 * Builds the error that stops a release whose new changelog section does not pass `lint:md` or `spellcheck`.
 *
 * It is thrown from the composition step, which is BEFORE anything is written, so the recovery it describes is
 * the whole recovery: there is nothing to revert, and the release re-runs from the top.
 *
 * @param findings - The findings, as {@link getChangelogSectionFindings} collected them.
 * @param version - The version whose section was being published.
 * @returns The error to throw.
 */
function toChangelogFindingsError(findings: ChangelogFinding[], version: string): Error {
  const scriptNames = toFailedScriptNames(findings);
  // The escape hatch belongs to `spellcheck` alone, so it is offered only when `spellcheck` is one of the
  // scripts that reported. Printing it under a lone `lint:md` failure would send the author to edit
  // cspell.json over a bare URL, which is the same lie `toFailedScriptNames` exists to avoid.
  const hasSpellingFindings = findings.some((finding) => finding.scriptName === SPELLCHECK_SCRIPT_NAME);
  const escapeHatch = hasSpellingFindings ? ' For a word this project really does use, add it to cspell.json instead.' : '';
  return new Error(
    `The ${version} section of ${CHANGELOG_FILE_NAME} does not pass ${scriptNames}:\n`
      + `${toFindingLines(findings)}\n`
      + 'The changelog is settled before it is written, so this stops the release with the repository untouched'
      + ' and nothing to revert. The line numbers are the ones the written file would have had. Fix the release'
      + ' notes -- in the commit messages they were generated from, or at the review step -- and re-run the'
      + ` release.${escapeHatch} Releasing anyway would land the defect on the default branch inside the release`
      + ` commit, where the next ${scriptNames} on anyone's branch reports it.`
  );
}

/**
 * Names the npm scripts that actually reported something, in the order they ran.
 *
 * Naming both unconditionally would be the easy version and would be a lie half the time: a release stopped
 * by a coined word would tell its author to go and look at `lint:md`, which passed.
 *
 * @param findings - The findings to name the scripts of.
 * @returns The script names, joined for prose -- `lint:md`, `spellcheck`, or `lint:md and spellcheck`.
 */
function toFailedScriptNames(findings: ChangelogFinding[]): string {
  const scriptNames = [LINT_MD_SCRIPT_NAME, SPELLCHECK_SCRIPT_NAME].filter((scriptName) => findings.some((finding) => finding.scriptName === scriptName));
  return scriptNames.join(' and ');
}

/**
 * Renders the findings for a message, each line tagged with the script that reported it.
 *
 * @param findings - The findings to render.
 * @returns The rendered lines, one finding per line.
 */
function toFindingLines(findings: ChangelogFinding[]): string {
  return findings.map((finding) => `[${finding.scriptName}] ${finding.text}`).join('\n');
}

function toFirstLine(string_: string): string {
  return string_.split(/\r?\n/).filter(Boolean).slice(0, 1).join('');
}

/**
 * Settles the release's `CHANGELOG.md` and writes it.
 *
 * Composition, the interactive review and the `lint:md` and `spellcheck` checks all happen in memory, and
 * the write is the last thing that happens: a section that does not pass leaves the working tree pristine
 * and the release re-runnable, rather than leaving the defect in the file for the release commit to pick up.
 *
 * @param newVersion - The version whose section is being published.
 */
async function updateChangelog(newVersion: string): Promise<void> {
  const changelogPath = resolvePathFromRootSafe(CHANGELOG_FILE_NAME);
  const newChangeLog = await composeChangelog(newVersion, changelogPath);
  const settledChangeLog = await settleChangelog(newChangeLog, newVersion, changelogPath);
  await writeFile(changelogPath, settledChangeLog, 'utf-8');
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

  // Resolved here rather than after the gates, so the breaking-change assertion below can refuse in
  // seconds instead of after a full `test:coverage`. Nothing between here and `updateVersionInFiles`
  // touches `package.json`, so resolving it early cannot change what gets cut.
  const newVersion = await getNewVersion(versionUpdateType);
  await assertBreakingChangesAreReleasedAsMajor(newVersion);

  await npmRun('format:check');
  await npmRun('spellcheck');
  await npmRun('lint:md');
  await npmRun('build');
  await npmRun('lint');
  await npmRun('test:coverage');

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

/**
 * One finding reported over the settled changelog section, tagged with the npm script whose check produced
 * it.
 *
 * The tag is what lets one message name `lint:md`, `spellcheck` or both, truthfully. Both checks run over
 * every settle, so an author who has to fix a hard-wrapped line and a coined word fixes them in ONE round of
 * the review rather than being sent back twice. It is also not decoration on the line itself: the two tools'
 * output shapes are similar enough to be mistaken for each other, and the fix for one is not the fix for the
 * other.
 */
interface ChangelogFinding {
  /**
   * The npm script that would have reported this on the branch.
   */
  readonly scriptName: string;

  /**
   * The reported line, exactly as that script's own output would have carried it.
   */
  readonly text: string;
}

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
  await execFromRoot([...getPackageManagerRunCommand(), command]);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

async function readPackageJson(cwd?: string): Promise<PackageJson> {
  return await readJson<PackageJson>(getPackageJsonPath(cwd));
}

function resolvePathFromRoot(path: string, cwd?: string): null | string {
  const rootFolder = getRootFolder(cwd);
  return rootFolder ? resolve(rootFolder, path) : null;
}

function resolvePathFromRootSafe(path: string, cwd?: string): string {
  return resolvePathFromRoot(path, cwd) ?? path;
}

async function writeJson(path: string, data: unknown): Promise<void> {
  const JSON_INDENT = 2;
  await writeFile(path, `${ensureNonNullable(JSON.stringify(data, null, JSON_INDENT))}\n`);
}
