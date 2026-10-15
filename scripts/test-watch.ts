import { resolveToolCommand } from '@mnaoumov/typescript-dev-toolkit/package-manager';
import { execFromRoot } from '@mnaoumov/typescript-dev-toolkit/root';

import { exitIfScriptDisabled } from './helpers/env-toggle.ts';
import {
  toProjectArguments,
  UNIT_TEST_PROJECTS
} from './helpers/vitest-projects.ts';

exitIfScriptDisabled();

await execFromRoot([
  ...resolveToolCommand({ tool: 'vitest' }),
  ...toProjectArguments(UNIT_TEST_PROJECTS)
]);
