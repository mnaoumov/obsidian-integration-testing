/**
 * @file
 *
 * Proves the IME composition helpers reach CodeMirror as real compositions. It runs in
 * `integration-tests:desktop-trusted-input` and in `integration-tests:android` (AGENTS.md L88).
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { TemporaryVault } from '../vault/temporary-vault.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 840_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 120_000;

/**
 * The input of a compose run.
 */
interface ComposeInput extends Record<string, unknown> {
  readonly chunking: 'character' | 'word';
  readonly notePath: string;
  readonly text: string;
}

/**
 * What a compose run reports back.
 */
interface ComposeResult {
  readonly commitCount: number;
  readonly events: string[];
  readonly value: string;
}

/**
 * What the open-composition test reports back.
 */
interface OpenCompositionResult {
  readonly composingAfterCommit: boolean;
  readonly composingWhileOpen: boolean;
  readonly valueAfterCommit: string;
  readonly valueWhileOpen: string;
}

describe('IME composition', () => {
  const vault = new TemporaryVault();

  beforeAll(async () => {
    await vault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await vault.dispose();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  async function compose(input: ComposeInput): Promise<ComposeResult> {
    return await evalInObsidian<ComposeInput, ComposeResult>({
      callback: async ({ app, chunking, lib: { composeIntoEditor }, notePath, obsidianModule, text }) => {
        const file = await app.vault.create(notePath, '');
        const leaf = app.workspace.getLeaf(true);
        await leaf.openFile(file, { state: { mode: 'source' } });
        if (!(leaf.view instanceof obsidianModule.MarkdownView)) {
          throw new TypeError('The note did not open in a Markdown view.');
        }

        const { editor } = leaf.view;
        const events: string[] = [];
        function record($event: Event): void {
          // Not filtered on `isTrusted`: Electron reports the commit's `compositionend` as untrusted.
          events.push($event.type);
        }

        const eventTypes = ['compositionstart', 'compositionupdate', 'compositionend'];
        for (const type of eventTypes) {
          editor.cm.contentDOM.addEventListener(type, record);
        }

        await composeIntoEditor({ chunking, editor, text });

        for (const type of eventTypes) {
          editor.cm.contentDOM.removeEventListener(type, record);
        }

        const result = { commitCount: events.filter((type) => type === 'compositionend').length, events, value: editor.getValue() };
        leaf.detach();
        return result;
      },
      input,
      vaultPath: vault.path
    });
  }

  it('should compose word by word, the commit carrying the separator', async () => {
    const result = await compose({ chunking: 'word', notePath: 'word.md', text: 'brb now ' });

    expect(result.value).toBe('brb now ');
    expect(result.commitCount).toBe(2);
    expect(result.events.filter((type) => type === 'compositionstart')).toHaveLength(2);
    expect(result.events.filter((type) => type === 'compositionupdate').length).toBeGreaterThanOrEqual('brb'.length + 'now'.length);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should run one composition per character', async () => {
    const result = await compose({ chunking: 'character', notePath: 'character.md', text: 'brb ' });

    expect(result.value).toBe('brb ');
    expect(result.commitCount).toBe('brb '.length);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should compose into an editor in a popout on desktop', async () => {
    const value = await evalInObsidian<Record<string, never>, null | string>({
      callback: async ({ app, lib: { composeIntoEditor, waitUntil }, obsidianModule }) => {
        if (!obsidianModule.Platform.isDesktopApp) {
          return null;
        }

        const file = await app.vault.create('popout.md', '');
        const leaf = app.workspace.openPopoutLeaf();
        await leaf.openFile(file, { state: { mode: 'source' } });
        if (!(leaf.view instanceof obsidianModule.MarkdownView)) {
          throw new TypeError('The note did not open in a Markdown view.');
        }

        const { editor } = leaf.view;
        await composeIntoEditor({ editor, text: 'brb ' });
        await waitUntil({ message: 'the composition to reach the popout editor', predicate: () => editor.getValue() === 'brb ' });
        const result = editor.getValue();
        leaf.detach();
        return result;
      },
      vaultPath: vault.path
    });

    expect(value === null || value === 'brb ').toBe(true);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should keep a composition open until it is committed', async () => {
    const result = await evalInObsidian<Record<string, never>, OpenCompositionResult>({
      callback: async ({ app, lib: { commitComposition, setComposition, waitUntil }, obsidianModule }) => {
        const file = await app.vault.create('open.md', '');
        const leaf = app.workspace.getLeaf(true);
        await leaf.openFile(file, { state: { mode: 'source' } });
        if (!(leaf.view instanceof obsidianModule.MarkdownView)) {
          throw new TypeError('The note did not open in a Markdown view.');
        }

        const { editor } = leaf.view;

        async function waitForValue(expectedValue: string, message: string): Promise<void> {
          try {
            // The one-core Android guest takes seconds to inject the Backspace presses of an early-ended composition (L88).
            await waitUntil({ message, predicate: () => editor.getValue() === expectedValue, timeoutInMilliseconds: 15_000 });
          } catch (error) {
            throw new Error(`${String(error)}; the document holds ${JSON.stringify(editor.getValue())}`, { cause: error });
          }
        }

        editor.focus();
        await setComposition({ text: 'br' });
        await setComposition({ text: 'brb' });
        await waitForValue('brb', 'the composition to reach the document');
        // The Android WebView can end a composition on its own at any time (L88), so it is only read on desktop.
        const isComposingWhileOpen = obsidianModule.Platform.isMobile || editor.cm.composing;
        const valueWhileOpen = editor.getValue();

        await commitComposition({ text: 'brb ' });
        await waitForValue('brb ', 'the commit to reach the document');
        await waitUntil({ message: 'the composition to end', predicate: () => !editor.cm.composing });

        const valueAfterCommit = editor.getValue();
        const isComposingAfterCommit = editor.cm.composing;
        leaf.detach();
        return { composingAfterCommit: isComposingAfterCommit, composingWhileOpen: isComposingWhileOpen, valueAfterCommit, valueWhileOpen };
      },
      vaultPath: vault.path
    });

    expect(result).toEqual({ composingAfterCommit: false, composingWhileOpen: true, valueAfterCommit: 'brb ', valueWhileOpen: 'brb' });
  }, TEST_TIMEOUT_IN_MILLISECONDS);
});
