/**
 * @file
 *
 * Lints markdown that is still in memory, with this repository's own `lint:md` configuration.
 *
 * `lint:md` can only answer for what is already on disk, so a document composed during a run -- the
 * release's changelog being the one that costs a red `main` -- is checked by nothing until the next gate.
 * This is the sibling of `cspell-content.ts`, with a different tool and the same defect behind it: a
 * hard-wrapped bullet, a badly-nested list or a bare URL lands on `main` inside the `chore: release` commit,
 * and the next release's `lint:md` reports it in a repository nobody was working on.
 *
 * It goes through `markdownlint-cli2` rather than `markdownlint`'s own string API, and that is the whole
 * point of the module. The question a caller is asking is *"would `lint:md` have failed on this text?"*, and
 * only the `markdownlint-cli2` layer knows: it is what finds the root `.markdownlint-cli2.mjs` -- which
 * imports `scripts/markdownlint-cli2-config.ts` through `jiti` -- and loads the custom rules that
 * configuration names. Reaching for the string API means hand-rolling that resolution, which is a copy of
 * `markdownlint-cli2` that can only ever drift from it.
 *
 * It calls that layer IN-PROCESS, which is the opposite of what the `cspell` half does, and the difference
 * is not an inconsistency. `cspell`'s content path is stdin-bound -- its `stdin://` reader consumes the host
 * process's own `process.stdin`, which the release's interactive changelog review also uses -- so that check
 * has to be a child process. `markdownlint-cli2` takes the content as a plain argument, so there is nothing
 * to shell out for.
 *
 * This is `obsidian-dev-utils`' `src/script-utils/linters/markdownlint-content.ts`, ported rather than
 * imported: this repo depends on that library not at all (L17), so its copy of the release tooling carries
 * the logic instead. Two things the sibling needs are dropped here. Its `optionsDefault` base exists for a
 * consumer repository that has no markdownlint configuration yet; this one always has its own, measured
 * before this module was written -- a 200-column line passes a non-file document because `MD013` is off in
 * `scripts/markdownlint-cli2-config.ts`. And its `getLibDebugger` line has no counterpart because this repo
 * has no debug channel, so `logMessage` -- the banner and the progress lines, never a finding -- is dropped
 * on the floor.
 */

import { main as markdownlintCli2 } from 'markdownlint-cli2';
import process from 'node:process';

import {
  getRootFolder,
  toPosixPath
} from './root.ts';

/**
 * Parameters for {@link lintMarkdownContent}.
 */
export interface LintMarkdownContentParams {
  /**
   * The markdown to lint.
   */
  readonly content: string;

  /**
   * The path the content is linted AS -- normally the path it is about to be written to. It decides how the
   * path-relative rules resolve (`relative-links` walks from the file's own folder), and it is what every
   * reported finding is named after.
   */
  readonly filePath: string;
}

/**
 * Lints markdown content that is not on disk, with the configuration `lint:md` would have used for it.
 *
 * @param params - The {@link LintMarkdownContentParams}.
 * @returns A {@link Promise} that resolves to the findings, each one the line the `lint:md` output would
 * have carried -- `<path>:<line>[:<column>] error <rule> <description>` -- or an empty array when there are
 * none.
 */
export async function lintMarkdownContent(params: LintMarkdownContentParams): Promise<string[]> {
  const { content, filePath } = params;
  const findings: string[] = [];

  const exitCode = await markdownlintCli2({
    directory: getRootFolder() ?? process.cwd(),
    logError: (message: string): void => {
      findings.push(message);
    },
    logMessage: noop,
    // The content is the only input. Without this the configuration's own `globs` would be expanded too, and
    // a check on one document would lint the whole repository -- slowly, and reporting findings its caller
    // has no business failing on.
    noGlobs: true,
    nonFileContents: { [toPosixPath(filePath)]: content }
  });

  // Whether this is a FAILURE is the tool's own answer, not a count of the lines it printed: a rule
  // configured with `severity: warning` is printed through `logError` like any other and still exits `0`, so
  // returning the lines alone would fail a release on something `lint:md` itself passes.
  return exitCode === SUCCESS_EXIT_CODE ? [] : findings;
}

/**
 * Discards a `markdownlint-cli2` progress line.
 */
function noop(): void {
  // The banner, the glob summary and the file count. There is no debug channel in this repository to send
  // them to, and printing them would put four lines of tooling noise in the middle of a release's
  // interactive changelog review.
}

/**
 * The exit code `markdownlint-cli2` returns when it reported nothing that counts as a failure.
 */
const SUCCESS_EXIT_CODE = 0;
