import { exitIfScriptDisabled } from '@mnaoumov/typescript-dev-toolkit/env-toggle';
import { resolveToolCommand } from '@mnaoumov/typescript-dev-toolkit/package-manager';
import { execFromRoot } from '@mnaoumov/typescript-dev-toolkit/root';

import {
  DESKTOP_INTEGRATION_TEST_PROJECTS,
  toProjectArguments
} from './helpers/vitest-projects.ts';

exitIfScriptDisabled();

await execFromRoot([
  ...resolveToolCommand({ tool: 'vitest' }),
  ...toProjectArguments(DESKTOP_INTEGRATION_TEST_PROJECTS)
]);
