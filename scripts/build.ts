import { exitIfScriptDisabled } from '@mnaoumov/typescript-dev-toolkit/env-toggle';
import { getPackageManagerRunCommand } from '@mnaoumov/typescript-dev-toolkit/package-manager';
import { execFromRoot } from '@mnaoumov/typescript-dev-toolkit/root';

exitIfScriptDisabled();

const BUILD_STEPS = [
  'build:clean',
  'build:compile',
  'build:lib',
  'build:types'
];

for (const step of BUILD_STEPS) {
  await execFromRoot([...getPackageManagerRunCommand(), step]);
}
