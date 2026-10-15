import { execFromRoot } from '@mnaoumov/typescript-dev-toolkit/root';

import { exitIfScriptDisabled } from './helpers/env-toggle.ts';

exitIfScriptDisabled();

async function main(): Promise<void> {
  await execFromRoot('node --experimental-vm-modules node_modules/jest/bin/jest.js --no-cache');
}

await main();
