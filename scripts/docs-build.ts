import { getDocsSiteAssetsDirectory } from '@mnaoumov/typescript-dev-toolkit/docs-site/docs-site-assets';
import { generateOgImages } from '@mnaoumov/typescript-dev-toolkit/docs-site/og-images';
import { exitIfScriptDisabled } from '@mnaoumov/typescript-dev-toolkit/env-toggle';
import { resolveToolCommand } from '@mnaoumov/typescript-dev-toolkit/package-manager';
import { execFromRoot } from '@mnaoumov/typescript-dev-toolkit/root';
import { join } from 'node:path';

exitIfScriptDisabled();

const DOCS_DIRECTORY = join(import.meta.dirname, '..', 'docs');

await execFromRoot([...resolveToolCommand({ tool: 'jiti' }), 'scripts/docs-gen/generate-api-docs.ts']);
await generateOgImages({
  brandText: 'obsidian-integration-testing',
  contentDocsDirectory: join(DOCS_DIRECTORY, 'src', 'content', 'docs'),
  faviconPath: join(DOCS_DIRECTORY, 'public', 'favicon.svg'),
  fontsDirectory: join(getDocsSiteAssetsDirectory(), 'fonts'),
  outputDirectory: join(DOCS_DIRECTORY, 'public', 'og')
});
await execFromRoot([...resolveToolCommand({ tool: 'astro' }), 'build']);
await execFromRoot([...resolveToolCommand({ tool: 'jiti' }), 'scripts/docs-link-check.ts']);
