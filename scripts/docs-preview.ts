import { previewDocsSite } from '@mnaoumov/typescript-dev-toolkit/docs-site/docs-site-commands';
import { exitIfScriptDisabled } from '@mnaoumov/typescript-dev-toolkit/env-toggle';

import { DOCS_SITE_CONFIG } from './docs-site-config.ts';

exitIfScriptDisabled();

await previewDocsSite(DOCS_SITE_CONFIG);
