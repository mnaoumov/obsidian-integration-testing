import { exitIfScriptDisabled } from '@mnaoumov/typescript-dev-toolkit/env-toggle';
import { rm } from 'node:fs/promises';

exitIfScriptDisabled();

await rm('dist', { force: true, recursive: true });
