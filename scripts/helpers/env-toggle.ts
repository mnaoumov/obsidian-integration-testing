/**
 * @file
 *
 * The per-script off switch every npm script in this repo honors on entry.
 *
 * Every npm script can be skipped by setting an environment variable named after it - the script name
 * uppercased, with every non-alphanumeric character replaced by `_`:
 *
 * | Script         | Switch           |
 * |----------------|------------------|
 * | `lint`         | `LINT=0`         |
 * | `lint:md:fix`  | `LINT_MD_FIX=0`  |
 * | `format:check` | `FORMAT_CHECK=0` |
 *
 * The switch itself - the name derivation, the `.env` load and what counts as "off" - is
 * `@mnaoumov/typescript-dev-toolkit/env-toggle`. That package acts on it only inside its `wrapCliTask`, which
 * this repo's scripts do not use, so the exit lives here.
 */

import { getDisabledScriptEnvVariableName } from '@mnaoumov/typescript-dev-toolkit/env-toggle';
import process from 'node:process';

/**
 * Exits the process successfully, before doing any work, when the npm script currently running has been
 * switched off.
 */
export function exitIfScriptDisabled(): void {
  const disabledScriptEnvVariableName = getDisabledScriptEnvVariableName();
  if (disabledScriptEnvVariableName === null) {
    return;
  }

  process.stdout.write(`Skipped (${disabledScriptEnvVariableName} is off).\n`);
  process.exit(0);
}
