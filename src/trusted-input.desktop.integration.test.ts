/**
 * @file
 *
 * The desktop counterpart of `mobile-trusted-input.android.integration.test.ts`: proves the **Electron**
 * trusted-input path still injects real, `isTrusted` events.
 *
 * It exists because **L39** touched every helper on both platforms — they became `Promise<void>` and each
 * gained a `Platform.isMobile` branch — and until this file there was no test in this repo that drove them
 * on desktop at all (the only desktop coverage lived in `obsidian-dev-utils`' own suite, a different repo).
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
  // Would be testing the other branch while claiming to cover Electron.
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
    expect(result.events.map((event) => event.type)).toContain('mousedown');
    expect(result.events.map((event) => event.type)).toContain('click');
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
});
