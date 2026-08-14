import { exitIfScriptDisabled } from './helpers/env-toggle.ts';
import { execFromRoot } from './helpers/root.ts';

exitIfScriptDisabled();

await execFromRoot(['npx', 'jiti', 'scripts/docs-gen/generate-api-docs.ts']);
await execFromRoot(['npx', 'jiti', 'scripts/docs-gen/generate-og-images.ts']);
await execFromRoot(['npx', 'astro', 'build']);
await execFromRoot(['npx', 'jiti', 'scripts/docs-link-check.ts']);
