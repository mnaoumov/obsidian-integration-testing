import { exitIfScriptDisabled } from './helpers/env-toggle.ts';
import { resolveToolCommand } from './helpers/package-manager.ts';
import { execFromRoot } from './helpers/root.ts';
import {
  DESKTOP_INTEGRATION_TEST_PROJECTS,
  toProjectArguments
} from './helpers/vitest-projects.ts';

exitIfScriptDisabled();

await execFromRoot([
  ...resolveToolCommand({ tool: 'vitest' }),
  ...toProjectArguments(DESKTOP_INTEGRATION_TEST_PROJECTS)
]);
