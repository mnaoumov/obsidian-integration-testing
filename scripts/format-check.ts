import { format } from '@mnaoumov/typescript-dev-toolkit/formatters/dprint';
import process from 'node:process';

import { exitIfScriptDisabled } from './helpers/env-toggle.ts';

exitIfScriptDisabled();

const [, , ...paths] = process.argv;

await format({ paths, rewrite: false });
