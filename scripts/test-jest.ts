import { exitIfScriptDisabled } from '@mnaoumov/typescript-dev-toolkit/env-toggle';
import { execFromRoot } from '@mnaoumov/typescript-dev-toolkit/root';

exitIfScriptDisabled();

async function main(): Promise<void> {
  await execFromRoot('node --experimental-vm-modules node_modules/jest/bin/jest.js --no-cache');
}

await main();
