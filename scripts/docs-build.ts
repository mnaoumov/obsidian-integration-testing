import { resolveToolCommand } from '@mnaoumov/typescript-dev-toolkit/package-manager';
import { execFromRoot } from '@mnaoumov/typescript-dev-toolkit/root';

import { exitIfScriptDisabled } from './helpers/env-toggle.ts';

exitIfScriptDisabled();

await execFromRoot([...resolveToolCommand({ tool: 'jiti' }), 'scripts/docs-gen/generate-api-docs.ts']);
await execFromRoot([...resolveToolCommand({ tool: 'jiti' }), 'scripts/docs-gen/generate-og-images.ts']);
await execFromRoot([...resolveToolCommand({ tool: 'astro' }), 'build']);
await execFromRoot([...resolveToolCommand({ tool: 'jiti' }), 'scripts/docs-link-check.ts']);
