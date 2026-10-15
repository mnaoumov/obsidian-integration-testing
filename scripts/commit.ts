import { exitIfScriptDisabled } from '@mnaoumov/typescript-dev-toolkit/env-toggle';
import { resolveToolCommand } from '@mnaoumov/typescript-dev-toolkit/package-manager';
import { execFromRoot } from '@mnaoumov/typescript-dev-toolkit/root';

exitIfScriptDisabled();

await execFromRoot(resolveToolCommand({ tool: 'czg' }));
