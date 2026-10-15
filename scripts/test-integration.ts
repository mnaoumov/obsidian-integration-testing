import { resolveToolCommand } from '@mnaoumov/typescript-dev-toolkit/package-manager';
import { execFromRoot } from '@mnaoumov/typescript-dev-toolkit/root';

import { exitIfScriptDisabled } from './helpers/env-toggle.ts';
import {
  DESKTOP_INTEGRATION_TEST_PROJECTS,
  toProjectArguments
} from './helpers/vitest-projects.ts';

exitIfScriptDisabled();

await execFromRoot([
  ...resolveToolCommand({ tool: 'vitest' }),
  ...toProjectArguments(DESKTOP_INTEGRATION_TEST_PROJECTS)
]);
