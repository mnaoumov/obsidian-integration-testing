/**
 * @file
 *
 * The desktop counterpart of `mobile-trusted-input.android.integration.test.ts`: proves the **Electron**
 * trusted-input path still injects real, `isTrusted` events.
 *
 * It exists because **L39** touched every helper on both platforms — they became `Promise<void>` and each
 * gained a `Platform.isMobile` branch — and until this file there was no test in this repo that drove them
 * on desktop at all (the only desktop coverage lived in the hand-synced twin's own suite, a different repo).
 * A change to a shared code path deserves proof in the repo that makes it.
 *
 * Runs in its own serial project for the reason **L11** gives consumers: trusted input targets the single
 * shared window's GLOBAL focus and pointer, so pointer-dependent files cannot run against each other.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { TemporaryVault } from './temporary-vault.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 120_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 60_000;

/**
 * What a drag probe reports back: every pointer event, and the `buttons` field of each move.
 */
interface DragProbeResult {
  readonly buttons: number[];
  readonly events: ObservedEvent[];
}

/**
 * One observed DOM event: its type, and whether the browser vouched for it.
 */
interface ObservedEvent {
  readonly isTrusted: boolean;
  readonly type: string;
}

/**
 * What a probe run reports back from the renderer.
 */
interface ProbeResult {
  readonly events: ObservedEvent[];
  readonly hasOnlyTrustedEvents: boolean;
}

describe('desktop trusted input', () => {
  const vault = new TemporaryVault();

  beforeAll(async () => {
    vault.populate({ 'note.md': '# note\n' });
    await vault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await vault.dispose();
  });

  // The mirror of the Android guard: if this suite ever ran on a mobile transport, every assertion below
  // would be testing the other branch while claiming to cover Electron.
  it('should actually be running on desktop', async () => {
    const isDesktopApp = await evalInObsidian({
      callback({ obsidianModule }): boolean {
        return obsidianModule.Platform.isDesktopApp;
      },
      vaultPath: vault.path
    });

    expect(isDesktopApp).toBe(true);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should deliver a TRUSTED click through clickElement', async () => {
    const result = await evalInObsidian({
      async callback({ lib }): Promise<ProbeResult> {
        const target = document.body.createDiv();
        target.setCssStyles({
          background: 'red',
          height: '80px',
          left: '24px',
          position: 'fixed',
          top: '220px',
          width: '160px',
          zIndex: '2147483647'
        });

        const events: ObservedEvent[] = [];
        for (const type of ['mousedown', 'mouseup', 'click']) {
          target.addEventListener(type, (event: Event) => {
            events.push({ isTrusted: event.isTrusted, type: event.type });
          });
        }

        try {
          await lib.clickElement({ element: target });
          await lib.waitUntil({ predicate: () => events.some((event) => event.type === 'click') });

          return { events, hasOnlyTrustedEvents: events.every((event) => event.isTrusted) };
        } finally {
          target.remove();
        }
      },
      vaultPath: vault.path
    });

    expect(result.hasOnlyTrustedEvents).toBe(true);

    // COUNTS, not `toContain` — the mobile twin's presence-only form let a DOUBLED gesture ship
    // unnoticed. Desktop injects straight through `webContents.sendInputEvent` with no broadcast
    // channel to duplicate it, so this is a guard against the class of bug rather than a fix for a
    // live one.
    expect(countByType(result.events)).toStrictEqual({
      click: 1,
      mousedown: 1,
      mouseup: 1
    });
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should deliver a TRUSTED key press through pressKey', async () => {
    const result = await evalInObsidian({
      async callback({ lib }): Promise<ProbeResult> {
        const events: ObservedEvent[] = [];

        function listener(event: Event): void {
          events.push({ isTrusted: event.isTrusted, type: event.type });
        }

        document.addEventListener('keydown', listener, { capture: true });
        try {
          await lib.pressKey({ key: 'Escape' });
          await lib.waitUntil({ predicate: () => events.length > 0 });

          return { events, hasOnlyTrustedEvents: events.every((event) => event.isTrusted) };
        } finally {
          document.removeEventListener('keydown', listener, { capture: true });
        }
      },
      vaultPath: vault.path
    });

    expect(result.hasOnlyTrustedEvents).toBe(true);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should still set a real :hover through hoverElement, which mobile refuses', async () => {
    const wasHovered = await evalInObsidian({
      async callback({ lib }): Promise<boolean> {
        const target = document.body.createDiv();
        target.setCssStyles({ height: '80px', left: '24px', position: 'fixed', top: '220px', width: '160px', zIndex: '2147483647' });

        try {
          await lib.hoverElement({ element: target });
          return target.matches(':hover');
        } finally {
          await lib.unhoverElement({ element: target });
          target.remove();
        }
      },
      vaultPath: vault.path
    });

    expect(wasHovered).toBe(true);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  /*
   * The regression this pair of assertions exists for. A layout box rarely lands on a whole pixel, and
   * `moveMouse` rounds — so an offset taken from the RAW fractional edge rounds back into the element's own
   * pixel column and the pointer never leaves. `left` is `24.796875` here for that reason: the old
   * `left - 1` sends `round(23.796875)` = 24, whose pixel column [24, 25) still overlaps the box, while the
   * snapped `Math.floor(left) - 1` sends 23 and genuinely clears. Before the snap this burned the whole
   * 5 000 ms poll and resolved anyway, with the element still `:hover`.
   */
  it('should clear a real :hover through unhoverElement even when the box edge is fractional', async () => {
    const isStillHovered = await evalInObsidian({
      async callback({ lib }): Promise<boolean> {
        const target = document.body.createDiv();
        target.setCssStyles({ height: '80px', left: '24.796875px', position: 'fixed', top: '220px', width: '160px', zIndex: '2147483647' });

        try {
          await lib.hoverElement({ element: target });
          await lib.unhoverElement({ element: target });
          return target.matches(':hover');
        } finally {
          target.remove();
        }
      },
      vaultPath: vault.path
    });

    expect(isStillHovered).toBe(false);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  // A hover that never landed reads to an assertion exactly like one that did — the element still has its
  // base style — so an unmet post-condition throws instead of resolving quietly. The overlay is what makes
  // the failure deterministic: it takes the hit at the target's center, so the target never matches `:hover`.
  it('should throw from hoverElement when the element never takes the hover', async () => {
    const message = await evalInObsidian({
      async callback({ lib }): Promise<string> {
        const target = document.body.createDiv();
        target.setCssStyles({ height: '80px', left: '24px', position: 'fixed', top: '220px', width: '160px', zIndex: '2147483646' });
        const overlay = document.body.createDiv();
        overlay.setCssStyles({ height: '80px', left: '24px', position: 'fixed', top: '220px', width: '160px', zIndex: '2147483647' });

        try {
          await lib.hoverElement({ element: target });
          return '';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        } finally {
          overlay.remove();
          target.remove();
        }
      },
      vaultPath: vault.path
    });

    expect(message).toContain('never matched `:hover`');
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should deliver a TRUSTED drag through dragMouse, with the button held on every move', async () => {
    const result = await evalInObsidian({
      async callback({ lib }): Promise<DragProbeResult> {
        const target = document.body.createDiv();
        target.setCssStyles({ height: '120px', left: '24px', position: 'fixed', top: '220px', width: '320px', zIndex: '2147483647' });

        const events: ObservedEvent[] = [];
        const buttons: number[] = [];
        for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
          target.addEventListener(type, (event: Event) => {
            events.push({ isTrusted: event.isTrusted, type: event.type });
            if (event.type === 'pointermove' && event instanceof PointerEvent) {
              buttons.push(event.buttons);
            }
          });
        }

        try {
          await lib.dragMouse({ from: { x: 44, y: 280 }, steps: 5, to: { x: 304, y: 280 } });
          await lib.waitUntil({ message: 'the pointerup ending the drag', predicate: () => events.some((event) => event.type === 'pointerup') });
          return { buttons, events };
        } finally {
          target.remove();
        }
      },
      vaultPath: vault.path
    });

    expect(result.events.every((event) => event.isTrusted)).toBe(true);
    const counts = countByType(result.events);
    expect(counts['pointerdown']).toBe(1);
    expect(counts['pointerup']).toBe(1);
    // The leading hover move may or may not land as a move of its own, so at least the five held ones.
    expect(counts['pointermove']).toBeGreaterThanOrEqual(5);
    // The held moves are the last five; each must report the left button down, or a drag handler ends the drag.
    expect(result.buttons.slice(-5)).toStrictEqual([1, 1, 1, 1, 1]);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  /*
   * The case `dragMouse` exists for. Obsidian's canvas shows its connection-drop menu only after a node's
   * connection handle is dragged onto empty canvas: the handle's `pointerdown` starts a pointer-capture drag
   * that begins only once the pointer has moved 5px, and the menu opens from the matching `pointerup`. A
   * click never moves, and a dispatched event is not trusted, so neither reaches the menu.
   */
  it('should open the canvas connection-drop menu by dragging a node connection handle onto empty canvas', async () => {
    const menuItems = await evalInObsidian({
      async callback({ app, lib }): Promise<string[]> {
        const NODE_HEIGHT = 60;
        const NODE_WIDTH = 120;
        const DROP_DISTANCE_IN_PIXELS = 150;
        // Canvas pans when a drag nears its edge (30px), so the drop stays well clear of it.
        const EDGE_CLEARANCE_IN_PIXELS = 60;
        const CENTER_DIVISOR = 2;

        const file = await lib.createNote({
          content: JSON.stringify({
            edges: [],
            nodes: [{ height: NODE_HEIGHT, id: 'source', text: 'Source', type: 'text', width: NODE_WIDTH, x: 0, y: 0 }]
          }),
          path: 'drag.canvas'
        });

        const leaf = app.workspace.getLeaf(true);
        try {
          await leaf.openFile(file);
          if (leaf.view.getViewType() !== 'canvas') {
            throw new Error(`drag.canvas opened a ${leaf.view.getViewType()} view, not a canvas one.`);
          }

          const containerEl = leaf.view.containerEl;
          // The canvas renders its nodes after the view opens, so each element is looked up as it is waited on.
          function findLaidOut(selector: string): HTMLElement | null {
            const element = containerEl.querySelector<HTMLElement>(selector);
            return element && element.getBoundingClientRect().width > 0 ? element : null;
          }

          await lib.waitUntil({ message: 'the canvas node to be laid out', predicate: () => findLaidOut('.canvas-node') !== null });
          const nodeEl = findLaidOut('.canvas-node');
          const wrapperEl = findLaidOut('.canvas-wrapper');
          if (!nodeEl || !wrapperEl) {
            throw new Error('The canvas rendered no node or no wrapper.');
          }

          // The connection handles belong to the node under the pointer, so the pointer goes there first.
          const nodeRect = nodeEl.getBoundingClientRect();
          const wrapperRect = wrapperEl.getBoundingClientRect();
          await lib.moveMouse({ x: nodeRect.left + nodeRect.width / CENTER_DIVISOR, y: nodeRect.top + nodeRect.height / CENTER_DIVISOR });

          // Drag out of whichever side has more empty canvas beside it.
          const roomOnRight = wrapperRect.right - nodeRect.right;
          const roomOnLeft = nodeRect.left - wrapperRect.left;
          const side = roomOnRight >= roomOnLeft ? 'right' : 'left';
          const room = Math.max(roomOnRight, roomOnLeft) - EDGE_CLEARANCE_IN_PIXELS;
          if (room < DROP_DISTANCE_IN_PIXELS / CENTER_DIVISOR) {
            throw new Error(`The canvas has only ${String(room)}px of empty space beside the node to drop on.`);
          }

          const handleSelector = `.canvas-node-connection-point[data-side="${side}"]`;
          await lib.waitUntil({ message: `the ${side} connection handle to be laid out`, predicate: () => findLaidOut(handleSelector) !== null });
          const handleEl = findLaidOut(handleSelector);
          if (!handleEl) {
            throw new Error(`The canvas rendered no ${side} connection handle.`);
          }

          const handleRect = handleEl.getBoundingClientRect();
          const from = { x: handleRect.left + handleRect.width / CENTER_DIVISOR, y: handleRect.top + handleRect.height / CENTER_DIVISOR };
          const distance = Math.min(DROP_DISTANCE_IN_PIXELS, room);
          const to = { x: side === 'right' ? from.x + distance : from.x - distance, y: from.y };

          await lib.dragMouse({ from, to });

          await lib.waitUntil({ message: 'the connection-drop menu to open', predicate: () => document.querySelector('.menu') !== null });

          const titles = [...document.querySelectorAll('.menu .menu-item-title')].map((titleEl) => titleEl.textContent);
          await lib.pressKey({ key: 'Escape' });
          await lib.waitUntil({ message: 'the menu to close', predicate: () => document.querySelector('.menu') === null });
          return titles;
        } finally {
          leaf.detach();
          await app.vault.delete(file);
        }
      },
      vaultPath: vault.path
    });

    expect(menuItems).toContain('Add card');
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  /*
   * A popout is its own Electron web contents, so input sent to the main window's never reaches it. Before
   * the helpers took a target window, every one of them injected into the main window, so a test driving a
   * popout (a settings page opened in a new window, an editor in a popout leaf) could not reach it at all.
   * Each case opens its own popout and detaches it afterwards, which closes the window.
   */
  describe('popout windows', () => {
    it('should press a key in the window it is given, and the main window by default', async () => {
      const result = await evalInObsidian({
        async callback({ app, lib }): Promise<Record<string, string[]>> {
          const leaf = app.workspace.openPopoutLeaf();
          try {
            const popoutWindow = leaf.getContainer().win;
            await lib.waitUntil({ message: 'the popout to load', predicate: () => popoutWindow.document.readyState === 'complete' });

            const keys: Record<string, string[]> = { main: [], popout: [] };
            function recordMain(event: KeyboardEvent): void {
              keys['main']?.push(`${event.key}:${String(event.isTrusted)}`);
            }
            function recordPopout(event: KeyboardEvent): void {
              keys['popout']?.push(`${event.key}:${String(event.isTrusted)}`);
            }

            document.addEventListener('keydown', recordMain, { capture: true });
            popoutWindow.document.addEventListener('keydown', recordPopout, { capture: true });
            try {
              await lib.pressKey({ key: 'Escape', window: popoutWindow });
              await lib.waitUntil({ message: 'the key in the popout', predicate: () => keys['popout']?.length === 1 });
              await lib.pressKey({ key: 'Escape' });
              await lib.waitUntil({ message: 'the key in the main window', predicate: () => keys['main']?.length === 1 });
              return keys;
            } finally {
              document.removeEventListener('keydown', recordMain, { capture: true });
              popoutWindow.document.removeEventListener('keydown', recordPopout, { capture: true });
            }
          } finally {
            leaf.detach();
          }
        },
        vaultPath: vault.path
      });

      expect(result).toStrictEqual({ main: ['Escape:true'], popout: ['Escape:true'] });
    }, TEST_TIMEOUT_IN_MILLISECONDS);

    it('should type into an editor in a popout', async () => {
      const content = await evalInObsidian({
        async callback({ app, lib, obsidianModule }): Promise<string> {
          const file = app.vault.getFileByPath('note.md');
          if (!file) {
            throw new Error('note.md is missing from the vault.');
          }

          const leaf = app.workspace.openPopoutLeaf();
          try {
            await leaf.openFile(file);
            const view = leaf.view;
            if (!(view instanceof obsidianModule.MarkdownView)) {
              throw new TypeError(`The popout opened a ${view.getViewType()} view, not a markdown one.`);
            }

            await lib.waitUntil({ message: 'the popout to load', predicate: () => leaf.getContainer().doc.readyState === 'complete' });
            await lib.typeIntoEditor({ editor: view.editor, text: 'typed' });
            return view.editor.getValue();
          } finally {
            leaf.detach();
          }
        },
        vaultPath: vault.path
      });

      expect(content).toBe('# note\ntyped');
    }, TEST_TIMEOUT_IN_MILLISECONDS);

    it('should click an element in a popout in that popout', async () => {
      const events = await evalInObsidian({
        async callback({ app, lib }): Promise<ObservedEvent[]> {
          const leaf = app.workspace.openPopoutLeaf();
          try {
            const popoutDocument = leaf.getContainer().doc;
            await lib.waitUntil({ message: 'the popout to load', predicate: () => popoutDocument.readyState === 'complete' });

            const target = popoutDocument.body.createDiv();
            target.setCssStyles({ height: '80px', left: '24px', position: 'fixed', top: '120px', width: '160px', zIndex: '2147483647' });
            const observed: ObservedEvent[] = [];
            target.addEventListener('click', (event: Event) => {
              observed.push({ isTrusted: event.isTrusted, type: event.type });
            });

            await lib.clickElement({ element: target });
            await lib.waitUntil({ message: 'the click in the popout', predicate: () => observed.length > 0 });
            return observed;
          } finally {
            leaf.detach();
          }
        },
        vaultPath: vault.path
      });

      expect(events).toStrictEqual([{ isTrusted: true, type: 'click' }]);
    }, TEST_TIMEOUT_IN_MILLISECONDS);

    // An iframe's window has no Electron bridge, so there is no web contents to inject into. Saying so beats
    // delivering the key to the main window, which is what the helper would otherwise have done.
    it('should refuse a window that has no Electron bridge', async () => {
      const message = await evalInObsidian({
        async callback({ lib }): Promise<string> {
          const frame = document.body.createEl('iframe');
          try {
            const frameWindow = frame.contentWindow;
            if (!frameWindow) {
              throw new Error('The iframe has no window.');
            }

            await lib.pressKey({ key: 'Escape', window: frameWindow });
            return '';
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          } finally {
            frame.remove();
          }
        },
        vaultPath: vault.path
      });

      expect(message).toContain('no Electron bridge');
    }, TEST_TIMEOUT_IN_MILLISECONDS);
  });
});

/**
 * Counts observed events by type, so a suite can assert HOW MANY of each a gesture produced.
 *
 * @param events - The events one gesture delivered.
 * @returns A count per event type, with absent types simply missing rather than zero — so
 *   `toStrictEqual` states the whole expected shape in one assertion.
 */
function countByType(events: readonly ObservedEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }

  return counts;
}
