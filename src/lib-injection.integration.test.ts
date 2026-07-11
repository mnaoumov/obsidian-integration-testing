import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { registerLibResolver } from './lib-registry.ts';
import { TempVault } from './temp-vault.ts';

// Augment the injected `lib` bag with the two providers registered below.
// Same declaration-merging a real provider uses (e.g. obsidian-dev-utils),
// Here targeting the local module that declares `Lib`.
declare module './eval-in-obsidian.ts' {
  interface Lib {
    echo(this: void, value: string): string;
    shout(this: void, value: string): string;
  }
}

const tempVault = new TempVault();
let vaultPath: string;

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60000;

// Two providers: proves multiple resolvers compose (Object.assign) into one flat `lib` bag.
registerLibResolver((): object => ({ echo: (value: string): string => value }));
registerLibResolver((): object => ({ shout: (value: string): string => value.toUpperCase() }));

beforeAll(async () => {
  await tempVault.register();
  vaultPath = tempVault.path;
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await tempVault.dispose();
});

describe('lib injection integration', () => {
  it('should expose a registered resolver function on the flat lib bag', async () => {
    const result = await evalInObsidian({
      fn({ lib }): string {
        return lib.echo('hello');
      },
      vaultPath
    });
    expect(result).toBe('hello');
  });

  it('should support destructuring the lib bag', async () => {
    const result = await evalInObsidian({
      fn({ lib: { echo } }): string {
        return echo('world');
      },
      vaultPath
    });
    expect(result).toBe('world');
  });

  it('should merge multiple resolvers via Object.assign', async () => {
    const result = await evalInObsidian({
      fn({ lib }): MergeResult {
        return { echoed: lib.echo('a'), shouted: lib.shout('b') };
      },
      vaultPath
    });
    expect(result).toStrictEqual({ echoed: 'a', shouted: 'B' });
  });

  it('should not expose keys that no resolver provides', async () => {
    const result = await evalInObsidian({
      fn({ lib }): boolean {
        return !('notProvided' in lib);
      },
      vaultPath
    });
    expect(result).toBe(true);
  });
});

interface MergeResult {
  readonly echoed: string;
  readonly shouted: string;
}
