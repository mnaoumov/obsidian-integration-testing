/**
 * @file
 *
 * Spellchecks markdown that is still in memory, with this repository's own `spellcheck` configuration.
 *
 * `spellcheck` can only answer for what is already on disk, so a document composed during a run -- the
 * release's changelog being the one that costs a red `main` -- is checked by nothing until the next gate.
 * `updateChangelog` builds each bullet from a commit subject verbatim, and nothing spellchecks a commit
 * subject when it is written, so a coined word lands on `main` inside the `chore: release` commit and the
 * NEXT release aborts on it, in a repository nobody was working on. That is exactly how `repoint` got here
 * (`d8b568e`).
 *
 * It SHELLS OUT rather than calling the `lint()` the `cspell` package exports, and the difference has a
 * reason rather than being an oversight: the only way to hand that function content which is not on disk is
 * a `stdin://` glob, and its reader is the HOST process's own `process.stdin` -- which the release's
 * interactive changelog review also uses. Reaching for it in-process would mean monkey-patching
 * `process.stdin` for the whole process, so the content goes to a child's stdin instead.
 *
 * The `stdin://<path>` form is what makes the check this repository's own rather than a generic one: the
 * virtual document is attributed to a REAL path, so the `cspell.json` beside it -- its `words`, its
 * dictionaries, its `ignorePaths` -- resolves exactly as it would for the written file. A temp file outside
 * the repository would lose all of that, which is why it is not used.
 *
 * This is `obsidian-dev-utils`' `src/script-utils/linters/cspell-content.ts`, ported rather than imported:
 * this repo depends on that library not at all (L17), so its copy of the release tooling carries the logic
 * instead.
 */

import { resolveToolCommand } from './package-manager.ts';
import {
  execFromRoot,
  toPosixPath
} from './root.ts';

/**
 * Parameters for {@link spellcheckContent}.
 */
export interface SpellcheckContentParams {
  /**
   * The content to spellcheck.
   */
  readonly content: string;

  /**
   * The path the content is checked AS -- normally the path it is about to be written to. It decides which
   * `cspell` configuration applies, and it is what every reported finding is named after.
   */
  readonly filePath: string;
}

/**
 * Spellchecks content that is not on disk, with the configuration `spellcheck` would have used for it.
 *
 * @param params - The {@link SpellcheckContentParams}.
 * @returns A {@link Promise} that resolves to the findings, each one the line the `spellcheck` output would
 * have carried -- `<path>:<line>:<column> - Unknown word (<word>)` -- or an empty array when there are none.
 * @throws If `cspell` exits non-zero without reporting anything, which is the tool itself failing rather
 * than a clean document.
 */
export async function spellcheckContent(params: SpellcheckContentParams): Promise<string[]> {
  const { content, filePath } = params;

  const result = await execFromRoot([
    ...resolveToolCommand({ tool: 'cspell' }),
    'lint',
    '--no-progress',
    '--no-must-find-files',
    // The `CSpell: Files checked: ...` summary and the color codes are both noise in a finding that ends up
    // quoted in an error message, and both are printed by default when they are not asked away.
    '--no-summary',
    '--no-color',
    // A POSIX path, because this is parsed as a URL: a Windows path's backslashes do not survive that.
    `stdin://${toPosixPath(filePath)}`
  ], {
    isQuiet: true,
    shouldIgnoreExitCode: true,
    shouldIncludeDetails: true,
    stdin: content
  });

  if (result.exitCode === SUCCESS_EXIT_CODE) {
    return [];
  }

  const findings = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);

  // A non-zero exit with nothing reported is `cspell` itself failing -- an unreadable configuration, a
  // missing dictionary, a binary that would not start. Returning `[]` there would read as a clean document
  // and let the very thing this module exists to catch through, so it fails loudly and hands over what the
  // tool said.
  if (findings.length === 0) {
    throw new Error(`\`cspell\` exited with ${String(result.exitCode)} without reporting anything:\n${result.stderr}`);
  }

  return findings;
}

/**
 * The exit code `cspell` returns when it reported nothing.
 */
const SUCCESS_EXIT_CODE = 0;
