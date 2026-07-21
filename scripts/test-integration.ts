import { execFromRoot } from './helpers/root.ts';

await execFromRoot([
  'vitest',
  '--project',
  'integration-tests',
  '--project',
  'integration-tests:owned-attach',
  '--project',
  'integration-tests:bare-attach',
  '--project',
  'integration-tests:enable-community-plugins'
]);
