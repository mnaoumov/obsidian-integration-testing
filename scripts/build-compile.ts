import {
  checkProjectTypes,
  parseTsConfig,
  toCanonical
} from '@mnaoumov/typescript-dev-toolkit/check-project-types';
import { resolveToolCommand } from '@mnaoumov/typescript-dev-toolkit/package-manager';
import {
  execFromRoot,
  getRootFolder
} from '@mnaoumov/typescript-dev-toolkit/root';
import { join } from 'node:path/posix';

import { exitIfScriptDisabled } from './helpers/env-toggle.ts';

exitIfScriptDisabled();

const NODE_MODULES_SEGMENT = '/node_modules/';

await main();

function areProjectTypesValid(): boolean {
  const root = getRootFolder();

  if (!root) {
    throw new Error('Could not find root folder');
  }

  const rootCanonical = toCanonical(root);
  const { fileNames, options } = parseTsConfig(join(root, 'tsconfig.json'));

  return options.skipLibCheck
    ? checkProjectTypes({
      options,
      rootNames: fileNames,
      shouldKeepFile: (fileName) => shouldKeepProjectFile(fileName, rootCanonical)
    })
    : true;
}

async function main(): Promise<void> {
  await execFromRoot([...resolveToolCommand({ tool: 'tsc' }), '--build', '--force']);

  if (!areProjectTypesValid()) {
    throw new Error('TypeScript declaration validation failed.');
  }
}

function shouldKeepProjectFile(fileName: string, rootCanonical: string): boolean {
  return fileName.startsWith(`${rootCanonical}/`) && !fileName.includes(NODE_MODULES_SEGMENT);
}
