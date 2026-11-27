/**
 * @file
 *
 * Holds the page still for one capture: CSS transitions off, finite animations
 * jumped to their end, endless ones paused until the capture is done.
 *
 * A CDP screenshot waits for nothing, so a modal caught sliding in, a fading
 * notice or a running spinner was photographed in whatever phase the capture
 * landed on, and the frame changed between runs. Re-implemented from
 * `freezeForShot` / `releaseShot` in `obsidian-plugin-dev-kit`
 * (`src/e2e/demo/page-scripts.ts`, at aa82d95, MIT); no code was copied.
 *
 * - **Transitions are switched off with a constructed `CSSStyleSheet`**, since
 *   the Obsidian lint forbids a `<style>` element (the same route
 *   `assertLayout` takes).
 * - **A finite animation is finished, an endless one paused.** An endless one
 *   has no end to jump to; pausing it and playing it again afterwards puts it
 *   back as it was. One the page had paused itself stays paused.
 * - **Two frames are awaited** so the result is drawn, with a timer as the
 *   fallback for a window that draws no frames.
 *
 * Finishing an animation fires its `finish` and `animationend` events now
 * rather than later, which is the state the page was about to reach anyway.
 * `captureObsidianScreenshot` calls this by default; it is exported for a
 * device capture, which has no page channel of its own.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian) covered by integration tests, not unit tests. */

import type { EvalInObsidianParams } from '../eval/eval-in-obsidian.ts';
import type { ObsidianTransport } from '../transport/transport.ts';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { normalizeOptionalProperties } from '../normalize-optional-properties.ts';

/**
 * Options for {@link freezeAnimations}.
 */
export interface FreezeAnimationsOptions {
  /**
   * Override the transport. When omitted, the transport the current test
   * context is driving is used.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The vault whose Obsidian window to freeze. When omitted, the current test
   * context's vault is used.
   */
  readonly vaultPath?: string;
}

/**
 * What {@link freezeAnimations} returns: what it did, and how to undo it.
 */
export interface FrozenAnimations {
  /**
   * How many running finite animations and transitions were jumped to their
   * end.
   */
  readonly finishedCount: number;

  /**
   * How many endless animations were paused.
   */
  readonly pausedCount: number;

  /**
   * Switches transitions back on and plays the paused animations again.
   *
   * @returns A {@link Promise} that resolves once the page is released.
   */
  readonly restore: () => Promise<void>;
}

type FreezeCounts = Record<'finishedCount' | 'pausedCount', number>;

// A `window` property rather than a closure variable: the freeze and the
// release are two separate evaluations, and the sheet and the animations are
// not serializable. Kept local rather than declared globally, like every other
// holder of a harness `window` property, so it never leaks into consumer types.
interface FrozenAnimationsHolder {
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- Freezing and releasing replaces and clears this window state.
  __obsidianIntegrationTestingFrozenAnimations?: FrozenAnimationsRecord | undefined;
}

interface FrozenAnimationsRecord {
  readonly paused: Animation[];
  readonly sheet: CSSStyleSheet;
}

/**
 * Freezes the animations and transitions of the vault's window.
 *
 * A second freeze before a release first releases the first one, so freezes
 * never stack.
 *
 * @param options - Transport and vault overrides.
 * @returns A {@link Promise} that resolves to the {@link FrozenAnimations}.
 */
export async function freezeAnimations(options?: FreezeAnimationsOptions): Promise<FrozenAnimations> {
  const { transport, vaultPath } = options ?? {};

  const counts = await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<Record<string, never>, FreezeCounts>>({
    async callback(): Promise<FreezeCounts> {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the frozen-animations record is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
      const holder = globalThis as unknown as FrozenAnimationsHolder;
      const existing = holder.__obsidianIntegrationTestingFrozenAnimations;
      if (existing) {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== existing.sheet);
        for (const animation of existing.paused) {
          animation.play();
        }
      }

      const sheet = new CSSStyleSheet();
      sheet.replaceSync('*, *::before, *::after { transition: none !important; }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      const paused: Animation[] = [];
      holder.__obsidianIntegrationTestingFrozenAnimations = { paused, sheet };

      let finishedCount = 0;
      for (const animation of document.getAnimations()) {
        if (animation.effect?.getComputedTiming().endTime === Infinity) {
          if (animation.playState === 'running') {
            animation.pause();
            paused.push(animation);
          }
          continue;
        }

        if (animation.playState === 'finished') {
          continue;
        }

        try {
          animation.finish();
          finishedCount++;
        } catch {
          // An animation with a playback rate of 0 has no end to jump to; it is
          // already standing still.
        }
      }

      await new Promise<void>((resolve) => {
        let isDone = false;
        function settle(): void {
          if (isDone) {
            return;
          }

          isDone = true;
          resolve();
        }
        // A window that draws no frames (an off-screen or occluded one) still
        // runs timers, so a timer is the fallback for the two frames.
        const FRAME_FALLBACK_IN_MILLISECONDS = 100;
        requestAnimationFrame(() => requestAnimationFrame(settle));
        globalThis.setTimeout(settle, FRAME_FALLBACK_IN_MILLISECONDS);
      });

      return { finishedCount, pausedCount: paused.length };
    },
    transport,
    vaultPath
  }));

  return {
    ...counts,
    async restore(): Promise<void> {
      await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<Record<string, never>, void>>({
        callback(): void {
          // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the frozen-animations record is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
          const holder = globalThis as unknown as FrozenAnimationsHolder;
          const record = holder.__obsidianIntegrationTestingFrozenAnimations;
          if (!record) {
            return;
          }

          document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== record.sheet);
          for (const animation of record.paused) {
            animation.play();
          }
          holder.__obsidianIntegrationTestingFrozenAnimations = undefined;
        },
        transport,
        vaultPath
      }));
    }
  };
}

/* v8 ignore stop */
