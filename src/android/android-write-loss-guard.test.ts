import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { noopAsync } from '../noop.ts';
import {
  buildAndroidWriteLossReport,
  drainAndroidWriteLossRewrites,
  installAndroidWriteLossGuard
} from './android-write-loss-guard.ts';

interface FakeAdapter {
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- The regression replaces stat to simulate a failed size probe.
  stat: (path: string) => Promise<FakeStat | null>;
  readonly write: (path: string, data: string) => Promise<void>;
  readonly writeBinary: (path: string, data: ArrayBuffer) => Promise<void>;
}

interface FakeDisk {
  // How many of the next writes land empty.
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- The fake disk decrements this counter for each simulated lost write.
  lossesLeft: number;
  readonly sizes: Map<string, number>;
  readonly writes: string[];
}

interface FakeStat {
  readonly size: number;
}

function createFakeAdapter(disk: FakeDisk): FakeAdapter {
  function land(path: string, size: number): void {
    disk.writes.push(path);
    if (disk.lossesLeft > 0) {
      disk.lossesLeft--;
      disk.sizes.set(path, 0);
      return;
    }
    disk.sizes.set(path, size);
  }

  return {
    async stat(path): Promise<FakeStat | null> {
      await noopAsync();
      const size = disk.sizes.get(path);
      return size === undefined ? null : { size };
    },
    async write(path, data): Promise<void> {
      await noopAsync();
      land(path, new TextEncoder().encode(data).byteLength);
    },
    async writeBinary(path, data): Promise<void> {
      await noopAsync();
      land(path, data.byteLength);
    }
  };
}

function installOn(disk: FakeDisk): FakeAdapter {
  const adapter = createFakeAdapter(disk);
  vi.stubGlobal('app', { vault: { adapter } });
  vi.stubGlobal('__obsidianIntegrationTestingWriteLossGuard', undefined);
  expect(installAndroidWriteLossGuard()).toBe('installed');
  return adapter;
}

function newDisk(lossesLeft: number): FakeDisk {
  return { lossesLeft, sizes: new Map(), writes: [] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('installAndroidWriteLossGuard', () => {
  it('should leave a write that landed alone', async () => {
    const disk = newDisk(0);
    const adapter = installOn(disk);

    await adapter.write('note.md', 'hello');

    expect(disk.writes).toEqual(['note.md']);
    expect(drainAndroidWriteLossRewrites()).toEqual([]);
  });

  it('should write a text file again when it landed empty', async () => {
    const disk = newDisk(1);
    const adapter = installOn(disk);

    await adapter.write('note.md', 'hello');

    expect(disk.writes).toEqual(['note.md', 'note.md']);
    expect(disk.sizes.get('note.md')).toBe(5);
    expect(drainAndroidWriteLossRewrites()).toEqual(['note.md (5 bytes, attempt 1)']);
  });

  it('should write a binary file again when it landed empty', async () => {
    const disk = newDisk(1);
    const adapter = installOn(disk);

    await adapter.writeBinary('image.png', new ArrayBuffer(3));

    expect(disk.sizes.get('image.png')).toBe(3);
    expect(drainAndroidWriteLossRewrites()).toEqual(['image.png (3 bytes, attempt 1)']);
  });

  it('should stop after two rewrites rather than loop on a repeat loss', async () => {
    const disk = newDisk(5);
    const adapter = installOn(disk);

    await adapter.write('note.md', 'hello');

    expect(disk.writes).toHaveLength(3);
    expect(drainAndroidWriteLossRewrites()).toEqual(['note.md (5 bytes, attempt 1)', 'note.md (5 bytes, attempt 2)']);
  });

  it('should never rewrite empty data', async () => {
    const disk = newDisk(1);
    const adapter = installOn(disk);

    await adapter.write('empty.md', '');

    expect(disk.writes).toEqual(['empty.md']);
  });

  it('should not rewrite a file whose size merely differs', async () => {
    const disk = newDisk(0);
    const adapter = installOn(disk);
    const originalStat = adapter.stat;
    adapter.stat = async (path): Promise<FakeStat | null> => {
      await originalStat(path);
      return { size: 2 };
    };

    await adapter.write('note.md', 'hello');

    expect(disk.writes).toEqual(['note.md']);
  });

  it('should install only once per page', () => {
    installOn(newDisk(0));

    expect(installAndroidWriteLossGuard()).toBe('already-installed');
  });

  it('should not install without a vault adapter', () => {
    vi.stubGlobal('app', undefined);
    vi.stubGlobal('__obsidianIntegrationTestingWriteLossGuard', undefined);

    expect(installAndroidWriteLossGuard()).toBe('no-vault-adapter');
  });
});

describe('drainAndroidWriteLossRewrites', () => {
  it('should return nothing when the guard is not installed', () => {
    vi.stubGlobal('__obsidianIntegrationTestingWriteLossGuard', undefined);

    expect(drainAndroidWriteLossRewrites()).toEqual([]);
  });

  it('should forget what it returned', async () => {
    const adapter = installOn(newDisk(1));
    await adapter.write('note.md', 'hello');

    drainAndroidWriteLossRewrites();

    expect(drainAndroidWriteLossRewrites()).toEqual([]);
  });
});

describe('buildAndroidWriteLossReport', () => {
  it('should say nothing when nothing was re-written', () => {
    expect(buildAndroidWriteLossReport([])).toBeUndefined();
    expect(buildAndroidWriteLossReport(undefined)).toBeUndefined();
    expect(buildAndroidWriteLossReport({ hasApp: true })).toBeUndefined();
  });

  it('should name every rewrite', () => {
    expect(buildAndroidWriteLossReport(['a.md (1 bytes, attempt 1)', 'b.md (2 bytes, attempt 1)'])).toBe(
      '[android-write-loss-guard] Re-wrote 2 file(s) the emulator wrote empty: a.md (1 bytes, attempt 1); b.md (2 bytes, attempt 1)'
    );
  });
});
