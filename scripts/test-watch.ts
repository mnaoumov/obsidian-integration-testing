import { exitIfScriptDisabled } from '@mnaoumov/typescript-dev-toolkit/env-toggle';
import { resolveToolCommand } from '@mnaoumov/typescript-dev-toolkit/package-manager';
import { execFromRoot } from '@mnaoumov/typescript-dev-toolkit/root';

import {
  toProjectArguments,
  UNIT_TEST_PROJECTS
} from './helpers/vitest-projects.ts';

exitIfScriptDisabled();

await execFromRoot([
  ...resolveToolCommand({ tool: 'vitest' }),
  ...toProjectArguments(UNIT_TEST_PROJECTS)
]);
