import { lint } from '@mnaoumov/typescript-dev-toolkit/linters/markdownlint';
import process from 'node:process';

import { exitIfScriptDisabled } from './helpers/env-toggle.ts';

exitIfScriptDisabled();

const [, , ...paths] = process.argv;

// `docs/**` links are base-absolute and resolve only against the built site; `docs-link-check.ts` checks those.
await lint({ linkCheckExcludeGlobs: ['docs/**'], paths, shouldFix: false });
