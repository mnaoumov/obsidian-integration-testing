import { buildDocsSite } from '@mnaoumov/typescript-dev-toolkit/docs-site/docs-site-commands';
import { exitIfScriptDisabled } from '@mnaoumov/typescript-dev-toolkit/env-toggle';

import { DOCS_SITE_CONFIG } from './docs-site-config.ts';

exitIfScriptDisabled();

await buildDocsSite(DOCS_SITE_CONFIG);
