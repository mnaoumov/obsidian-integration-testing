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

/**
 * The input of a compose run whose focus is stolen.
 */
interface StolenFocusInput extends Record<string, unknown> {
  readonly notePath: string;
  readonly shouldFailOnUnchangedDocument: boolean;
}

/**
 * What a compose run whose focus is stolen reports back.
 */
interface StolenFocusResult {
  readonly errorMessage: null | string;
  readonly value: string;
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

  async function composeWithStolenFocus(input: StolenFocusInput): Promise<StolenFocusResult> {
    return await evalInObsidian<StolenFocusInput, StolenFocusResult>({
      callback: async ({ app, lib: { composeIntoEditor }, notePath, obsidianModule, shouldFailOnUnchangedDocument }) => {
        const file = await app.vault.create(notePath, '');
        const leaf = app.workspace.getLeaf(true);
        await leaf.openFile(file, { state: { mode: 'source' } });
        if (!(leaf.view instanceof obsidianModule.MarkdownView)) {
          throw new TypeError('The note did not open in a Markdown view.');
        }

        const { editor } = leaf.view;
        const doc = editor.cm.contentDOM.ownerDocument;
        // A focus trap: the editor's focus is handed straight to another field, so the composition goes there.
        const trapInputEl = doc.body.createEl('input', { cls: 'oit-focus-trap' });
        function stealFocus($event: FocusEvent): void {
          if ($event.target instanceof Node && editor.cm.contentDOM.contains($event.target)) {
            doc.win.setTimeout(() => {
              trapInputEl.focus();
            }, 0);
          }
        }

        trapInputEl.focus();
        doc.addEventListener('focusin', stealFocus);
        let errorMessage: null | string = null;
        try {
          await composeIntoEditor({ editor, shouldFailOnUnchangedDocument, text: 'brb ' });
        } catch (error) {
          errorMessage = String(error);
        } finally {
          doc.removeEventListener('focusin', stealFocus);
        }

        const result = { errorMessage, value: editor.getValue() };
        trapInputEl.remove();
        leaf.detach();
        return result;
      },
      input,
      vaultPath: vault.path
    });
  }

  it('should return silently by default when the composition left the document unchanged', async () => {
    const result = await composeWithStolenFocus({ notePath: 'stolen-default.md', shouldFailOnUnchangedDocument: false });

    expect(result).toEqual({ errorMessage: null, value: '' });
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should throw with shouldFailOnUnchangedDocument when the composition left the document unchanged', async () => {
    const result = await composeWithStolenFocus({ notePath: 'stolen-strict.md', shouldFailOnUnchangedDocument: true });

    expect(result.value).toBe('');
    expect(result.errorMessage).toContain('the document was unchanged');
    expect(result.errorMessage).toContain('"brb "');
    expect(result.errorMessage).toContain('oit-focus-trap');
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should not throw with shouldFailOnUnchangedDocument when the composition landed', async () => {
    const value = await evalInObsidian<Record<string, never>, string>({
      callback: async ({ app, lib: { composeIntoEditor }, obsidianModule }) => {
        const file = await app.vault.create('strict-landed.md', '');
        const leaf = app.workspace.getLeaf(true);
        await leaf.openFile(file, { state: { mode: 'source' } });
        if (!(leaf.view instanceof obsidianModule.MarkdownView)) {
          throw new TypeError('The note did not open in a Markdown view.');
        }

        const { editor } = leaf.view;
        await composeIntoEditor({ editor, shouldFailOnUnchangedDocument: true, text: 'brb ' });
        const result = editor.getValue();
        leaf.detach();
        return result;
      },
      vaultPath: vault.path
    });

    expect(value).toBe('brb ');
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
        const popoutWindow = leaf.view.containerEl.win;
        await composeIntoEditor({ editor, text: 'brb ' });
        await waitUntil({ message: 'the composition to reach the popout editor', predicate: () => editor.getValue() === 'brb ' });
        const result = editor.getValue();
        leaf.detach();
        // Closing the popout hands focus back to the main window later; a next test focusing its editor before that would lose it.
        await waitUntil({ message: 'the popout window to close', predicate: () => popoutWindow.closed });
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
            const activeElement = editor.cm.contentDOM.ownerDocument.activeElement;
            const focusState = `the editor has focus: ${String(editor.hasFocus())}, the active element: ${activeElement?.tagName ?? 'none'}.${activeElement?.className ?? ''}`;
            throw new Error(`${String(error)}; the document holds ${JSON.stringify(editor.getValue())}; ${focusState}`, { cause: error });
          }
        }

        /*
         * A composition goes to whatever holds focus, and under load the workspace can move focus after the note
         * opens (a leaf activation, a popout closing). So the editor must hold focus across two reads a settle apart.
         */
        async function focusEditor(): Promise<void> {
          const FOCUS_SETTLE_IN_MILLISECONDS = 300;
          let focusedSince = 0;
          await waitUntil({
            message: 'the editor to hold focus',
            predicate: () => {
              if (!editor.hasFocus()) {
                editor.focus();
                focusedSince = 0;
                return false;
              }

              focusedSince ||= Date.now();
              return Date.now() - focusedSince >= FOCUS_SETTLE_IN_MILLISECONDS;
            },
            timeoutInMilliseconds: 15_000
          });
        }

        await focusEditor();
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
