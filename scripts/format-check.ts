import { exitIfScriptDisabled } from '@mnaoumov/typescript-dev-toolkit/env-toggle';
import { format } from '@mnaoumov/typescript-dev-toolkit/formatters/dprint';
import process from 'node:process';

exitIfScriptDisabled();

const [, , ...paths] = process.argv;

await format({ paths, rewrite: false });
