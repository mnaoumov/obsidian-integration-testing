import { exitIfScriptDisabled } from '@mnaoumov/typescript-dev-toolkit/env-toggle';
import { lint } from '@mnaoumov/typescript-dev-toolkit/linters/eslint';
import process from 'node:process';

exitIfScriptDisabled();

const [, , ...paths] = process.argv;

await lint({ paths, shouldFix: true });
