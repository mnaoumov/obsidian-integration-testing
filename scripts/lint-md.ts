import { exitIfScriptDisabled } from '@mnaoumov/typescript-dev-toolkit/env-toggle';
import { lint } from '@mnaoumov/typescript-dev-toolkit/linters/markdownlint';
import process from 'node:process';

exitIfScriptDisabled();

const [, , ...paths] = process.argv;

// `docs/**` links are base-absolute and resolve only against the built site; `docs:build` checks those.
await lint({ linkCheckExcludeGlobs: ['docs/**'], paths, shouldFix: false });
