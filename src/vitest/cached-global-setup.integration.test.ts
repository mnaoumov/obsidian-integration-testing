import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  expect,
  it
} from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface FixtureResult {
  readonly error: Error | null;
  readonly output: string;
}

it('maps a cached global-setup failure to the original TypeScript source', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'cached-global-setup-'));
  const globalSetupPath = join(ROOT, 'dist/lib/esm/vitest/global-setup.mjs').replaceAll('\\', '/');
  const populatePath = join(ROOT, 'dist/lib/esm/vault/demo-vault/demo-vault-populate.mjs').replaceAll('\\', '/');
  symlinkSync(join(ROOT, 'node_modules'), join(fixture, 'node_modules'), 'junction');
  try {
    mkdirSync(join(fixture, 'demo-vault'));
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(fixture, 'vitest.config.ts'),
      `
export default {
  test: {
    fsModuleCache: true,
    fsModuleCachePath: './cache',
    globalSetup: ['./global-setup.ts'],
    include: ['./diagnostic.test.ts'],
    maxWorkers: 1,
    fileParallelism: false
  }
};
`
    );
    writeFileSync(
      join(fixture, 'global-setup.ts'),
      `
import { createSetup } from ${JSON.stringify(globalSetupPath)};
import { buildDemoVaultPopulate } from ${JSON.stringify(populatePath)};
export const { setup, teardown } = createSetup({
  populate: () => buildDemoVaultPopulate({
    demoVaultPath: ${JSON.stringify(join(fixture, 'demo-vault'))},
    injectPlugins: [{ pluginId: 'fix-require-modules' }]
  })
});
`
    );
    writeFileSync(
      join(fixture, 'diagnostic.test.ts'),
      String.raw`
import { expect, inject, it } from 'vitest';
it('receives the source-mapped missing-plugin diagnostic', () => {
  const error = inject('setupError');
  expect(error.message).toContain('fix-require-modules');
  expect(error.message).toContain('bootstrap-demo-vault');
  expect(error.message.replaceAll('\\', '/')).toMatch(
    /seedPlugin \(.*src\/vault\/demo-vault\/demo-vault-populate\.ts:374:\d+\)/
  );
  expect(error.message).not.toContain('could not format');
});
`
    );
    const result = await new Promise<FixtureResult>((resolve) => {
      execFile(process.execPath, [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=default'], {
        cwd: fixture,
        timeout: 20_000,
        windowsHide: true
      }, (error, stdout, stderr) => {
        resolve({ error, output: stdout + stderr });
      });
    });
    expect(result.error, result.output).toBeNull();
    expect(result.output).toContain('1 passed');
  } finally {
    unlinkSync(join(fixture, 'node_modules'));
    rmSync(fixture, { force: true, recursive: true });
  }
});
