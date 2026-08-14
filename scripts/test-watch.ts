import { exitIfScriptDisabled } from './helpers/env-toggle.ts';
import { execFromRoot } from './helpers/root.ts';

exitIfScriptDisabled();

await execFromRoot('vitest --project unit-tests --project unit-tests:docs-generator');
