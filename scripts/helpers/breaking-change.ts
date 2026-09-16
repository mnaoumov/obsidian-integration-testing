/**
 * @file
 *
 * The two decisions behind the release gate that refuses a non-major bump over an unreleased breaking
 * change: which unreleased commits declare one, and whether the version about to be cut actually raises
 * the major over them.
 *
 * `npm run version` takes the bump as an explicit argument and feeds it straight to semver's `inc`, so
 * nothing between `validate` and `addGitTag` ever reads a commit footer. A `minor` cut over an unreleased
 * `BREAKING CHANGE` was therefore accepted silently, and the footer surfaced exactly once — in the
 * `CHANGELOG.md` draft, which `updateChangelog` builds from the FIRST LINE of each commit message, so the
 * footer was not even in the draft. The subject's `!` was, but only to a reader who noticed it; and a
 * non-interactive release reviews no draft at all.
 *
 * Both functions here are pure, which is the reason they are not in `scripts/version.ts`: that module runs
 * `await main()` at top level, so nothing can import it to test it. The git reads stay there and the
 * judgement lives here.
 *
 * **What this deliberately does NOT do** is infer the bump type outright, `standard-version` style. The
 * argument stays explicit; this only stops one that is provably wrong.
 */

import {
  major,
  prerelease
} from 'semver';

/**
 * The inputs {@link isMajorRaise} decides from.
 */
export interface IsMajorRaiseParams {
  /**
   * The version in `package.json` right now — the one being released FROM.
   */
  readonly currentVersion: string;

  /**
   * The highest non-prerelease version ever tagged, or `null` when the package has never had a stable
   * release. This is what makes the prerelease case decidable; see {@link isMajorRaise}.
   */
  readonly lastReleasedStableVersion: null | string;

  /**
   * The RESOLVED version about to be cut — `inc`'s output for a `major`/`minor`/… argument, or the manual
   * `x.y.z` itself. Never the raw argument: `major` and a manual `15.0.0` are the same fact here, and the
   * argument alone cannot say so.
   */
  readonly newVersion: string;
}

/**
 * Splits a commit message into its lines, tolerating both line endings.
 */
const LINE_SEPARATOR_REG_EXP = /\r?\n/;

/**
 * A `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer, which Conventional Commits requires at the start of a
 * line. Tested per line rather than with the `m` flag so a CRLF payload behaves identically.
 */
const BREAKING_FOOTER_REG_EXP = /^BREAKING[ -]CHANGE:/;

/**
 * A Conventional Commits subject whose `!` sits immediately before the `:` — `feat!: …`,
 * `refactor(types)!: …`. The `!` has to be in that one position: a subject that merely contains an
 * exclamation mark (`fix: do not panic!`) declares nothing.
 */
const BREAKING_SUBJECT_REG_EXP = /^[a-z][\w-]*(?:\([^\r\n()]*\))?!:/i;

/**
 * Finds the commits that declare a breaking change and returns their subjects.
 *
 * @param rawGitLogOutput - The raw stdout of `git log <range> --format=%B -z`, i.e. NUL-separated whole
 * commit messages. Whole messages, not subjects: a footer lives in the body, so the first-line view the
 * changelog takes cannot see it.
 * @returns The subject line of each breaking commit, in the order `git log` reported them. Empty when
 * nothing unreleased is breaking.
 */
export function findBreakingCommitSubjects(rawGitLogOutput: string): string[] {
  return rawGitLogOutput
    .split('\0')
    .filter((commitMessage) => commitMessage.trim() !== '')
    .filter((commitMessage) => isBreakingCommitMessage(commitMessage))
    .map((commitMessage) => toSubject(commitMessage));
}

/**
 * Tells whether a commit message declares a breaking change, by either of the two forms Conventional
 * Commits defines: a `!` before the `:` in the subject, or a `BREAKING CHANGE:` / `BREAKING-CHANGE:`
 * footer at the start of a line.
 *
 * @param commitMessage - The whole commit message, subject and body.
 * @returns `true` when the message declares a breaking change.
 */
export function isBreakingCommitMessage(commitMessage: string): boolean {
  const lines = commitMessage.split(LINE_SEPARATOR_REG_EXP);
  return BREAKING_SUBJECT_REG_EXP.test(toSubject(commitMessage)) || lines.some((line) => BREAKING_FOOTER_REG_EXP.test(line));
}

/**
 * Tells whether the release being cut raises the major — the only bump a breaking change may ship in.
 *
 * Two ways to satisfy it, and the second is the whole reason this is not a one-line comparison:
 *
 * - The new version's major is above the current one's. `major`, `premajor` and a manual `x.y.z` above the
 *   current major all land here, which is why the RESOLVED version is what gets compared rather than the
 *   argument the user typed.
 * - The current version is a **prerelease whose major is already above the last stable release** — a
 *   `14.0.0-beta.0` cut from `13.x`. A `prerelease` bump on it raises no major and must still be allowed:
 *   the raise happened when the `premajor` was cut, and every commit since rides the same unreleased major.
 *   A package that has never had a stable release is the same case with nothing to compare against.
 *
 * @param params - See {@link IsMajorRaiseParams}.
 * @returns `true` when a breaking change may ship in this release.
 */
export function isMajorRaise(params: IsMajorRaiseParams): boolean {
  const {
    currentVersion,
    lastReleasedStableVersion,
    newVersion
  } = params;

  const currentMajor = major(currentVersion);
  const newMajor = major(newVersion);

  if (newMajor !== currentMajor) {
    return newMajor > currentMajor;
  }

  if (prerelease(currentVersion) === null) {
    return false;
  }

  return lastReleasedStableVersion === null || currentMajor > major(lastReleasedStableVersion);
}

function toSubject(commitMessage: string): string {
  return (commitMessage.split(LINE_SEPARATOR_REG_EXP).find((line) => line.trim() !== '') ?? '').trim();
}
