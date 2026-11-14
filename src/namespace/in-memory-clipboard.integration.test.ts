/**
 * @file
 *
 * Proves `lib.useInMemoryClipboard` replaces the renderer clipboard of a hidden, unfocused window, keeps
 * the system clipboard out of the test, and puts the original methods back (AGENTS.md L92).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { TemporaryVault } from '../vault/temporary-vault.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 240_000;

/**
 * The methods of Electron's `clipboard` module the tests call.
 */
interface ElectronClipboardLike {
  readonly readHTML: (this: void) => string;
  readonly readText: (this: void) => string;
  readonly writeText: (this: void, text: string) => void;
}

/**
 * The part of `require('electron')` the tests read.
 */
interface ElectronLike {
  readonly clipboard: ElectronClipboardLike;
}

/**
 * A window as Obsidian Desktop gives it, with `require`.
 */
interface WindowWithRequire {
  readonly require: (id: string) => unknown;
}

describe('useInMemoryClipboard', () => {
  const vault = new TemporaryVault();

  beforeAll(async () => {
    await vault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await vault.dispose();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterEach(async () => {
    await evalInObsidian({
      callback({ lib: { getInMemoryClipboard } }): void {
        getInMemoryClipboard()?.restore();
      },
      vaultPath: vault.path
    });
  });

  it('should answer navigator.clipboard from memory in a window that does not have focus', async () => {
    const result = await evalInObsidian({
      async callback({ lib: { useInMemoryClipboard } }) {
        const clipboard = useInMemoryClipboard({ text: 'seed' });
        const seeded = await navigator.clipboard.readText();
        await navigator.clipboard.writeText('first');
        await navigator.clipboard.writeText('second');
        return {
          readBack: await navigator.clipboard.readText(),
          seeded,
          text: clipboard.text,
          writtenTexts: [...clipboard.writtenTexts]
        };
      },
      vaultPath: vault.path
    });

    expect(result.seeded).toBe('seed');
    expect(result.readBack).toBe('second');
    expect(result.text).toBe('second');
    expect(result.writtenTexts).toEqual(['first', 'second']);
  });

  it('should keep text and HTML written through navigator.clipboard.write and hand them back from read', async () => {
    const result = await evalInObsidian({
      async callback({ lib: { useInMemoryClipboard } }) {
        const clipboard = useInMemoryClipboard();
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob(['<b>bold</b>'], { type: 'text/html' }),
            'text/plain': new Blob(['bold'], { type: 'text/plain' })
          })
        ]);
        async function readType(clipboardItem: ClipboardItem, type: string): Promise<string> {
          const blob = await clipboardItem.getType(type);
          return await blob.text();
        }
        const items = await navigator.clipboard.read();
        const [item] = items;
        return {
          html: clipboard.html,
          itemCount: items.length,
          readHtml: item ? await readType(item, 'text/html') : null,
          readText: item ? await readType(item, 'text/plain') : null,
          writtenTexts: [...clipboard.writtenTexts]
        };
      },
      vaultPath: vault.path
    });

    expect(result).toEqual({
      html: '<b>bold</b>',
      itemCount: 1,
      readHtml: '<b>bold</b>',
      readText: 'bold',
      writtenTexts: ['bold']
    });
  });

  it('should replace Electron\'s clipboard module and share its state with navigator.clipboard', async () => {
    const result = await evalInObsidian({
      async callback({ lib: { useInMemoryClipboard } }) {
        const electron = (globalThis as WindowWithRequire).require('electron') as ElectronLike;
        const electronClipboard = electron.clipboard;
        const clipboard = useInMemoryClipboard({ html: '<i>seed</i>' });
        const seededHtml = electronClipboard.readHTML();
        electronClipboard.writeText('from electron');
        const readByNavigator = await navigator.clipboard.readText();
        await navigator.clipboard.writeText('from navigator');
        return {
          isElectronClipboardReplaced: clipboard.isElectronClipboardReplaced,
          readByElectron: electronClipboard.readText(),
          readByNavigator,
          seededHtml,
          writtenTexts: [...clipboard.writtenTexts]
        };
      },
      vaultPath: vault.path
    });

    expect(result).toEqual({
      isElectronClipboardReplaced: true,
      readByElectron: 'from navigator',
      readByNavigator: 'from electron',
      seededHtml: '<i>seed</i>',
      writtenTexts: ['from electron', 'from navigator']
    });
  });

  it('should stay installed across evaluations and be found again with getInMemoryClipboard', async () => {
    await evalInObsidian({
      callback({ lib: { useInMemoryClipboard } }): void {
        useInMemoryClipboard();
      },
      vaultPath: vault.path
    });
    await evalInObsidian({
      async callback(): Promise<void> {
        await navigator.clipboard.writeText('written in a later evaluation');
      },
      vaultPath: vault.path
    });
    const result = await evalInObsidian({
      callback({ lib: { getInMemoryClipboard } }) {
        const clipboard = getInMemoryClipboard();
        const writtenTexts = clipboard ? [...clipboard.writtenTexts] : null;
        clipboard?.restore();
        return {
          isGoneAfterRestore: getInMemoryClipboard() === null,
          writtenTexts
        };
      },
      vaultPath: vault.path
    });

    expect(result).toEqual({
      isGoneAfterRestore: true,
      writtenTexts: ['written in a later evaluation']
    });
  });

  it('should put the original methods back on restore, and restore an earlier clipboard when a second is installed', async () => {
    const result = await evalInObsidian({
      callback({ lib: { getInMemoryClipboard, useInMemoryClipboard } }) {
        const electron = (globalThis as WindowWithRequire).require('electron') as ElectronLike;
        const originalElectronWriteText = electron.clipboard.writeText;
        const navigatorClipboard = navigator.clipboard;
        // Obsidian puts its own `writeText` on the instance, so restore must put that one back, not delete it.
        const originalOwnWriteText: unknown = Object.getOwnPropertyDescriptor(navigatorClipboard, 'writeText')?.value;

        const first = useInMemoryClipboard({ text: 'first' });
        const second = useInMemoryClipboard({ text: 'second' });
        const isSecondInstalled = getInMemoryClipboard() === second;
        second.restore();
        // A second call is a no-op, and so is restoring a clipboard the second install already restored.
        second.restore();
        first.restore();

        return {
          isElectronWriteTextOriginal: electron.clipboard.writeText === originalElectronWriteText,
          isNavigatorWriteTextOriginal: Object.getOwnPropertyDescriptor(navigatorClipboard, 'writeText')?.value === originalOwnWriteText,
          isSecondInstalled
        };
      },
      vaultPath: vault.path
    });

    expect(result).toEqual({
      isElectronWriteTextOriginal: true,
      isNavigatorWriteTextOriginal: true,
      isSecondInstalled: true
    });
  });
});
