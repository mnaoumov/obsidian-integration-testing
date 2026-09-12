/**
 * @file
 *
 * The decisive test for the mobile trusted-input path (**L39**): it asserts that what reaches the DOM on
 * Android is **`isTrusted === true`**, which is the single property that makes these helpers worth having.
 *
 * Without this assertion the whole feature is unverified — an untrusted `dispatchEvent` would satisfy every
 * *other* observation a test can make (the listener fires, the counter increments) while Obsidian and
 * CodeMirror, which gate on `e.isTrusted`, ignore it. That is the false-confidence failure mode the
 * trusted-input work exists to end, so it is checked directly rather than inferred from an effect.
 *
 * Runs in its own Vitest project (`integration-tests:android`) against a real emulator via
 * Appium. It is deliberately NOT part of the default `integration-tests` aggregate, which is desktop.
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

/*
 * 240s + the 120s the network-ready gate (L45) can add on a guest that
 * never reports a validated default network. The old figure was already a
 * practical number rather than the sum of its parts — Appium start and session
 * connection alone budget 180s each — so this raises it by exactly what the new
 * phase can cost, rather than re-deriving a worst case nothing waits out.
 */
const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 360_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 120_000;

/**
 * What the long-press test reports back: the events that reached the pressed element, and the menu the
 * press produced.
 */
interface LongPressResult {
  readonly events: ObservedEvent[];
  readonly menuItems: string[];
}

/**
 * One observed DOM event: its type, and whether the browser vouched for it.
 */
interface ObservedEvent {
  readonly isTrusted: boolean;
  readonly type: string;
}

/**
 * What a probe run reports back from the WebView.
 */
interface ProbeResult {
  readonly events: ObservedEvent[];
  readonly hasOnlyTrustedEvents: boolean;
}

describe('mobile trusted input', () => {
  const vault = new TemporaryVault();

  beforeAll(async () => {
    vault.populate({ 'note.md': '# note\n' });
    await vault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    await vault.dispose();
  });

  // Guard, not a feature test. Without a registered transport resolver the harness silently falls back to
  // The desktop owned-CDP default (observed 2026-08-30), and this whole suite would then pass on desktop
  // While claiming to prove something about Android. Assert the platform before asserting anything else.
  it('should actually be running on mobile', async () => {
    const isMobile = await evalInObsidian({
      callback({ obsidianModule }): boolean {
        return obsidianModule.Platform.isMobile;
      },
      vaultPath: vault.path
    });

    expect(isMobile).toBe(true);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  // The second guard, and the reason this file once ran against an EMPTY vault for its whole life:
  // `populate` writes to the HOST filesystem, while the app on Android opens the device's copy. Until
  // `register` learned to push the directory across, the note below never arrived — and nothing raised an
  // Error, because no assertion in this file read the vault's contents. Asserting that the seeded file is
  // Visible from inside the app is what keeps a re-broken push loud instead of silent.
  it('should open the vault the harness populated, not an empty one', async () => {
    const markdownPaths = await evalInObsidian({
      callback({ app }): string[] {
        return app.vault.getMarkdownFiles().map((file) => file.path);
      },
      vaultPath: vault.path
    });

    expect(markdownPaths).toContain('note.md');
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should deliver a TRUSTED tap through clickElement', async () => {
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
        for (const type of ['pointerdown', 'touchstart', 'pointerup', 'touchend', 'click']) {
          target.addEventListener(type, (event: Event) => {
            events.push({ isTrusted: event.isTrusted, type: event.type });
          });
        }

        try {
          await lib.clickElement({ element: target });
          await lib.waitUntil({ message: 'the tap to produce a click', predicate: () => events.some((event) => event.type === 'click') });

          return { events, hasOnlyTrustedEvents: events.every((event) => event.isTrusted) };
        } finally {
          target.remove();
        }
      },
      vaultPath: vault.path
    });

    // The point of the whole feature. An untrusted dispatch would satisfy every other assertion here.
    expect(result.hasOnlyTrustedEvents).toBe(true);

    // COUNTS, not `toContain`. A tap is ONE of each event, and the presence-only form this replaces
    // Passed just as happily on the TWO `pointerdown` / `touchstart` pairs the dispatch route actually
    // Delivered — which is how a doubled tap shipped unnoticed and toggled a consumer's panel open and
    // Straight back shut. Multiplicity is the property that was never asserted, so it is what is
    // Asserted here.
    expect(countByType(result.events)).toStrictEqual({
      click: 1,
      pointerdown: 1,
      pointerup: 1,
      touchend: 1,
      touchstart: 1
    });
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should deliver a TRUSTED key press through pressKey', async () => {
    const result = await evalInObsidian({
      async callback({ lib }): Promise<ProbeResult> {
        const events: ObservedEvent[] = [];

        function listener(event: Event): void {
          events.push({ isTrusted: event.isTrusted, type: event.type });
        }

        // Capture phase: Obsidian's own handlers may stop propagation before a bubbling listener sees it.
        document.addEventListener('keydown', listener, { capture: true });
        try {
          await lib.pressKey({ key: 'Escape' });
          await lib.waitUntil({ message: 'a keydown to reach the document', predicate: () => events.length > 0 });

          return { events, hasOnlyTrustedEvents: events.every((event) => event.isTrusted) };
        } finally {
          document.removeEventListener('keydown', listener, { capture: true });
        }
      },
      vaultPath: vault.path
    });

    expect(result.hasOnlyTrustedEvents).toBe(true);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should obey real hit-testing, so a covered element is NOT clicked', async () => {
    // The mutation check established: a trusted tap goes to whatever is on top at that point, while a
    // Dispatched event reaches its target through any overlay. If this passes, the tap is not a dispatch.
    const wasCoveredElementClicked = await evalInObsidian({
      async callback({ lib }): Promise<boolean> {
        const target = document.body.createDiv();
        target.setCssStyles({ height: '80px', left: '24px', position: 'fixed', top: '220px', width: '160px', zIndex: '1' });

        const overlay = document.body.createDiv();
        overlay.setCssStyles({ height: '80px', left: '24px', position: 'fixed', top: '220px', width: '160px', zIndex: '2147483647' });

        let wasClicked = false;
        target.addEventListener('click', () => {
          wasClicked = true;
        });

        try {
          await lib.clickElement({ element: target });
          return wasClicked;
        } finally {
          target.remove();
          overlay.remove();
        }
      },
      vaultPath: vault.path
    });

    expect(wasCoveredElementClicked).toBe(false);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  // The test whose absence let a broken long-press ship. `button: 'right'` used to be a dispatched touch
  // Pair held apart by a dwell, which Android's gesture recognizer never sees — so it was classified as a
  // Tap, and a long press on a file OPENED it instead of opening its menu. Every other assertion in this
  // File still passed, because none of them pressed anything for longer than an instant.
  //
  // It presses a REAL Obsidian element rather than a probe `div` on purpose: a synthetic element has no
  // Obsidian handler, so it can only ever show that the `contextmenu` arrived, never that a consumer's
  // Menu opens from it. Both halves are asserted here — the trusted event AND the menu it produced.
  it('should open a REAL Obsidian menu from a long press, rather than tapping the element', async () => {
    const result = await evalInObsidian({
      async callback({ app, lib }): Promise<LongPressResult> {
        // Sized against the transport's 30s per-eval cap: four attempts at 1.5s is 6s of drawer opening,
        // Which leaves the 600ms press and the 5s menu wait below a wide margin under it.
        const DRAWER_OPEN_ATTEMPT_COUNT = 4;
        const DRAWER_OPEN_TIMEOUT_IN_MILLISECONDS = 1500;

        // The `note.md` the suite populates is what gets pressed — the test above proves it is there.
        const leaf = app.workspace.getLeavesOfType('file-explorer')[0];
        if (leaf) {
          await app.workspace.revealLeaf(leaf);
        }

        // The item must be ON SCREEN, not merely laid out. The drawer slides in from the left, so during
        // The animation an item already has its full width at a NEGATIVE `left` — and the gesture's centre
        // Point is then off the viewport, which `Input.synthesizeTapGesture` rejects with "Position out of
        // Bounds" rather than pressing anything. Waiting on the centre point rather than on the width is
        // What makes this wait for the drawer to arrive instead of merely to exist.
        function findVisibleNavFile(): HTMLElement | undefined {
          return [...document.querySelectorAll<HTMLElement>('.nav-file-title')].find((item) => {
            const rect = item.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            return rect.width > 0
              && centerX >= 0 && centerX <= globalThis.innerWidth
              && centerY >= 0 && centerY <= globalThis.innerHeight;
          });
        }

        // What the explorer actually rendered is the half of the answer a bare timeout throws away, and
        // It is the half that decides: a drawer that never opened, a vault that came up empty, and an item
        // Laid out past the viewport all produce the same silence otherwise.
        function describeNavFiles(): string {
          const split = `left split ${app.workspace.leftSplit.collapsed ? 'collapsed' : 'expanded'}`;
          const explorer = leaf ? 'file-explorer leaf present' : 'NO file-explorer leaf';
          const viewport = `viewport ${String(globalThis.innerWidth)}x${String(globalThis.innerHeight)}`;
          const items = [...document.querySelectorAll<HTMLElement>('.nav-file-title')];
          if (items.length === 0) {
            return `no .nav-file-title at all, ${split}, ${explorer}, ${viewport}`;
          }

          const boxes = items.map((item) => {
            const rect = item.getBoundingClientRect();
            return `[${String(Math.round(rect.left))},${String(Math.round(rect.top))} ${String(Math.round(rect.width))}x${String(Math.round(rect.height))}]`;
          });
          return `${String(items.length)} .nav-file-title at ${boxes.join(' ')}, ${split}, ${explorer}, ${viewport}`;
        }

        // Opening the drawer ONCE is not enough, and re-asserting it on every poll is worse than useless.
        // Measured over six consecutive runs (2026-09-12): `expand()` takes — `collapsed` goes false and
        // The drawer starts sliding in — and then, ~100ms later and unprompted, `collapsed` flips back to
        // True and the drawer slides straight back out, ending hidden at 0x0 with its item still in the
        // DOM. `revealLeaf` is not the trigger: dropping that call leaves the timeline identical. Nor is
        // It slowness, since five further seconds of polling never bring the drawer back.
        //
        // The collapse is ONE-SHOT, so re-opening does work — but only from REST. `expand()` is NOT
        // Idempotent mid-animation: called while the drawer is sliding it leaves the element hidden with
        // `collapsed === false`, stuck that way for the whole of the remaining wait. An attempt timeout
        // Comfortably longer than the ~300ms slide is what guarantees the next `expand()` is issued from
        // Rest rather than into a moving drawer.
        for (let attempt = 1; attempt <= DRAWER_OPEN_ATTEMPT_COUNT; attempt++) {
          if (app.workspace.leftSplit.collapsed) {
            app.workspace.leftSplit.expand();
          }

          try {
            await lib.waitUntil({
              message: 'the file explorer to render a `.nav-file-title` whose centre is on screen',
              predicate: () => findVisibleNavFile() !== undefined,
              timeoutInMilliseconds: DRAWER_OPEN_TIMEOUT_IN_MILLISECONDS
            });
            break;
          } catch (error) {
            if (attempt === DRAWER_OPEN_ATTEMPT_COUNT) {
              throw new Error(
                `The left drawer never stayed open long enough to press a .nav-file-title, after ${String(attempt)} attempts: ${describeNavFiles()}`,
                { cause: error }
              );
            }
          }
        }

        const navFile = findVisibleNavFile();
        if (!navFile) {
          throw new Error(`The file explorer rendered no visible .nav-file-title to long-press: ${describeNavFiles()}`);
        }

        const events: ObservedEvent[] = [];
        function listener(event: Event): void {
          events.push({ isTrusted: event.isTrusted, type: event.type });
        }

        // Capture phase: Obsidian's own handler opens the menu and may stop propagation on the way.
        navFile.addEventListener('contextmenu', listener, { capture: true });
        try {
          await lib.clickElement({ button: 'right', element: navFile });
          try {
            await lib.waitUntil({
              message: 'the long press to open a `.menu`',
              predicate: () => document.querySelector('.menu') !== null
            });
          } catch (error) {
            // Which events the press delivered is the whole diagnosis when no menu appears: a trusted
            // `contextmenu` with none of Obsidian's menu behind it is a consumer problem, while no
            // `contextmenu` at all is a gesture one. Losing that list to the timeout would leave the two
            // Indistinguishable.
            const observed = events.length === 0
              ? 'none'
              : events.map((event) => `${event.type}(isTrusted=${String(event.isTrusted)})`).join(', ');
            throw new Error(`The long press opened no .menu. Events on the pressed element: ${observed}`, { cause: error });
          }

          return {
            events,
            menuItems: [...document.querySelectorAll('.menu-item-title')].map((item) => item.textContent)
          };
        } finally {
          navFile.removeEventListener('contextmenu', listener, { capture: true });
          // A real menu leaks into the next test unless it is taken down (**L11**).
          for (const menu of document.querySelectorAll('.menu')) {
            menu.remove();
          }
        }
      },
      vaultPath: vault.path
    });

    // The mechanism: the platform recognized a long press and emitted a genuine `contextmenu`.
    expect(result.events.some((event) => event.type === 'contextmenu' && event.isTrusted)).toBe(true);
    // The consumer-visible effect: Obsidian's own file menu, which is what every converted suite needs.
    expect(result.menuItems).toContain('Rename...');
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should refuse a hover rather than silently do nothing', async () => {
    const errorMessage = await evalInObsidian({
      async callback({ lib }): Promise<string> {
        const target = document.body.createDiv();
        try {
          await lib.hoverElement({ element: target });
          return '';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        } finally {
          target.remove();
        }
      },
      vaultPath: vault.path
    });

    expect(errorMessage).toContain('has no meaning on mobile');
  }, TEST_TIMEOUT_IN_MILLISECONDS);
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
