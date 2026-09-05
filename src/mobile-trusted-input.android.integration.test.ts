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
 * Runs in its own Vitest project (`integration-tests:android-trusted-input`) against a real emulator via
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
 * 240s + the 120s the network-ready gate (T934, L45) can add on a guest that
 * never reports a validated default network. The old figure was already a
 * practical number rather than the sum of its parts — Appium start and session
 * connection alone budget 180s each — so this raises it by exactly what the new
 * phase can cost, rather than re-deriving a worst case nothing waits out.
 */
const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 360_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 120_000;

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
          await lib.waitUntil({ predicate: () => events.some((event) => event.type === 'click') });

          return { events, hasOnlyTrustedEvents: events.every((event) => event.isTrusted) };
        } finally {
          target.remove();
        }
      },
      vaultPath: vault.path
    });

    // The point of the whole feature. An untrusted dispatch would satisfy every other assertion here.
    expect(result.hasOnlyTrustedEvents).toBe(true);
    expect(result.events.map((event) => event.type)).toContain('click');
    expect(result.events.map((event) => event.type)).toContain('touchstart');
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

  it('should obey real hit-testing, so a covered element is NOT clicked', async () => {
    // The mutation check T599 established: a trusted tap goes to whatever is on top at that point, while a
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
