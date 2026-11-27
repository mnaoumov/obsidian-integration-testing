/**
 * @file
 *
 * `waitForSettledPage`: waits until a part of the Obsidian window has had no
 * DOM change for a quiet window, no font is loading, and every image in view
 * inside it has loaded, so a screenshot or a layout assertion that follows
 * sees a page that is done drawing. On a timeout it names what kept changing.
 *
 * Ported (whitebox) from `settle()` in `src/e2e/helpers/create-helpers.ts` and
 * the settle page scripts in `src/e2e/helpers/page-scripts.ts` of
 * [`obsidian-plugin-dev-kit`](https://github.com/Dimagious/obsidian-plugin-dev-kit)
 * at aa82d95 (v0.4.0), Copyright (c) 2026 Dmitriy Yurkin, used under the MIT
 * License:
 *
 * > Permission is hereby granted, free of charge, to any person obtaining a
 * > copy of this software and associated documentation files (the
 * > "Software"), to deal in the Software without restriction, including
 * > without limitation the rights to use, copy, modify, merge, publish,
 * > distribute, sublicense, and/or sell copies of the Software, and to permit
 * > persons to whom the Software is furnished to do so, subject to the
 * > following conditions: The above copyright notice and this permission
 * > notice shall be included in all copies or substantial portions of the
 * > Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 *
 * Re-implemented on this package's architecture: every page read is a
 * self-contained `evalInObsidian` closure, the watch lives on a window
 * property between polls, and the loop runs in Node (`waitForSettledState`).
 * Animations and transitions are not DOM changes, so an endless CSS animation
 * never keeps the page from settling.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian) covered by integration tests, not unit tests. */

import { setTimeout as sleep } from 'node:timers/promises';

import type { ObsidianTransport } from '../transport/transport.ts';
import type {
  PageSettleState,
  SettleOptions
} from './settle-options.ts';

import { errorToString } from '../error-to-string.ts';
import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { normalizeOptionalProperties } from '../normalize-optional-properties.ts';
import {
  buildSettleRootMissingMessage,
  PageNotSettledError,
  resolveSettleOptions,
  SETTLE_POLL_INTERVAL_IN_MILLISECONDS,
  waitForSettledState
} from './settle-options.ts';

/**
 * Options of {@link waitForSettledPage}.
 */
export interface WaitForSettledPageOptions extends SettleOptions {
  /**
   * Override the transport. When omitted, the transport the current test
   * context is driving is used.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The vault whose Obsidian window to watch. When omitted, the current test
   * context's vault is used.
   */
  readonly vaultPath?: string;
}

interface SettleWatch {
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- The observer moves it forward on every mutation.
  lastChange: number;
  readonly observer: MutationObserver;
  readonly root: Element;
}

// A `window` property rather than a closure variable: the watch spans several
// evaluations. Kept local rather than declared globally, like every other
// holder of a harness `window` property, so it never leaks into consumer types.
interface SettleWatchHolder {
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- Each wait installs and removes the watch.
  __obsidianIntegrationTestingSettleWatch?: SettleWatch | undefined;
}

interface TransportTarget {
  readonly transport?: ObsidianTransport;
  readonly vaultPath?: string;
}

// The closure input is a `type` alias rather than an interface: an interface
// carries no index signature, so it does not satisfy `evalInObsidian`'s
// `Record<string, unknown>` input constraint.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- See above.
type WatchInput = {
  readonly rootSelector: null | string;
};

/**
 * Waits until the page (or the part `root` names) has had no DOM change for
 * the quiet window, no font is loading and every image in view inside it has
 * loaded.
 *
 * @param options - The quiet window, the root, the budget, and the target.
 * @returns A {@link Promise} that resolves once the page is settled.
 * @throws {@link PageNotSettledError} when the budget runs out, naming what
 * kept changing.
 */
export async function waitForSettledPage(options: WaitForSettledPageOptions = {}): Promise<void> {
  const { quietInMilliseconds, root, timeoutInMilliseconds } = resolveSettleOptions(options);
  const target = normalizeOptionalProperties<TransportTarget>({
    transport: options.transport,
    vaultPath: options.vaultPath
  });

  const isWatching = await evalInObsidian<WatchInput, boolean>({
    ...target,
    callback({ rootSelector }): boolean {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the settle watch is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
      const holder = globalThis as unknown as SettleWatchHolder;
      holder.__obsidianIntegrationTestingSettleWatch?.observer.disconnect();
      delete holder.__obsidianIntegrationTestingSettleWatch;
      const element = rootSelector === null ? document.body : document.querySelector(rootSelector);
      if (!element) {
        return false;
      }
      const observer = new MutationObserver(() => {
        if (holder.__obsidianIntegrationTestingSettleWatch) {
          holder.__obsidianIntegrationTestingSettleWatch.lastChange = performance.now();
        }
      });
      holder.__obsidianIntegrationTestingSettleWatch = { lastChange: performance.now(), observer, root: element };
      observer.observe(element, { attributes: true, characterData: true, childList: true, subtree: true });
      return true;
    },
    input: { rootSelector: root }
  });
  if (!isWatching) {
    throw new Error(buildSettleRootMissingMessage(root));
  }

  try {
    let reasons: string[];
    try {
      reasons = await waitForSettledState({
        intervalInMilliseconds: SETTLE_POLL_INTERVAL_IN_MILLISECONDS,
        nowInMilliseconds: () => Date.now(),
        quietInMilliseconds,
        readState: async () => await readSettleState(target),
        sleep: async (milliseconds: number) => {
          await sleep(milliseconds);
        },
        timeoutInMilliseconds
      });
    } catch (error) {
      // The window can be gone by now (a reload, a crash); the wait is still what the caller needs to hear about.
      throw new PageNotSettledError({
        cause: error,
        quietInMilliseconds,
        reasons: [`the page could not be read: ${errorToString(error)}`],
        root,
        timeoutInMilliseconds
      });
    }
    if (reasons.length > 0) {
      throw new PageNotSettledError({ quietInMilliseconds, reasons, root, timeoutInMilliseconds });
    }
  } finally {
    await stopSettleWatch(target);
  }
}

async function readSettleState(target: TransportTarget): Promise<PageSettleState> {
  return await evalInObsidian<Record<string, never>, PageSettleState>({
    ...target,
    callback(): PageSettleState {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the settle watch is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
      const watch = (globalThis as unknown as SettleWatchHolder).__obsidianIntegrationTestingSettleWatch;
      if (!watch) {
        return { incompleteImageCount: 0, isFontLoading: false, sinceLastChangeInMilliseconds: null };
      }
      const height = innerHeight;
      const width = innerWidth;
      const incompleteImageCount = [...watch.root.querySelectorAll('img')].filter((image) => {
        const box = image.getBoundingClientRect();
        return !image.complete && box.bottom > 0 && box.right > 0 && box.top < height && box.left < width;
      }).length;
      return {
        incompleteImageCount,
        isFontLoading: document.fonts.status === 'loading',
        sinceLastChangeInMilliseconds: performance.now() - watch.lastChange
      };
    }
  });
}

async function stopSettleWatch(target: TransportTarget): Promise<void> {
  try {
    await evalInObsidian({
      ...target,
      callback(): void {
        // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the settle watch is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
        const holder = globalThis as unknown as SettleWatchHolder;
        holder.__obsidianIntegrationTestingSettleWatch?.observer.disconnect();
        delete holder.__obsidianIntegrationTestingSettleWatch;
      }
    });
  } catch {
    // Only the cleanup failed, and a page that cannot be read has no watch left to stop.
  }
}

/* v8 ignore stop */
