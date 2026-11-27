/**
 * @file
 *
 * The pure half of `waitForSettledPage`: option resolution, the Node-side wait
 * loop over an injected page reader, the reasons a page is not settled yet,
 * and the failure text. Everything that reads the page lives in
 * `wait-for-settled-page.ts`.
 *
 * Ported (whitebox) from `src/e2e/helpers/settle.ts` and the settle half of
 * `src/e2e/helpers/page-scripts.ts` of
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
 * Re-written against this package's naming and `null` conventions. The source
 * waits with Playwright's `waitForFunction`; here the loop runs in Node, one
 * short `evalInObsidian` per poll, so it is not bound by the per-eval cap and
 * works on Android too. The page answers one question per poll (what is
 * still changing), so "settled" and "the reasons it is not" cannot disagree.
 */

/**
 * How long the page must stay free of DOM changes to count as settled. Longer
 * than the 100 ms debounce Obsidian's views and many plugins use for a
 * refresh, so a refresh that a change schedules still lands inside the wait;
 * short enough that a settled page costs a fraction of a second.
 */
export const DEFAULT_SETTLE_QUIET_IN_MILLISECONDS = 150;

/**
 * How long {@link waitForSettledState} waits for a settled page before it
 * gives up.
 */
export const DEFAULT_SETTLE_TIMEOUT_IN_MILLISECONDS = 10_000;

/**
 * Delay between two reads of the page.
 */
export const SETTLE_POLL_INTERVAL_IN_MILLISECONDS = 50;

/**
 * Parameters of {@link buildSettleTimeoutMessage}: the same as the error's.
 */
export type BuildSettleTimeoutMessageParams = PageNotSettledErrorConstructorParams;

/**
 * Parameters of the {@link PageNotSettledError} constructor.
 */
export interface PageNotSettledErrorConstructorParams {
  /**
   * The error that stopped the wait, when the page could not be read.
   */
  readonly cause?: unknown;

  readonly quietInMilliseconds: number;
  readonly reasons: readonly string[];
  readonly root: null | string;
  readonly timeoutInMilliseconds: number;
}

/**
 * What the page reports about itself on one poll.
 */
export interface PageSettleState {
  /**
   * The number of images inside the watched root that are in the viewport and
   * have not finished loading. A broken image counts as finished.
   */
  readonly incompleteImageCount: number;

  /**
   * Whether `document.fonts.status` is `loading`.
   */
  readonly isFontLoading: boolean;

  /**
   * Milliseconds since the last DOM mutation inside the root (or since the
   * watch started), or `null` when the watch is gone, as after a reload.
   */
  readonly sinceLastChangeInMilliseconds: null | number;
}

/**
 * The resolved options of a settle wait.
 */
export interface ResolvedSettleOptions {
  readonly quietInMilliseconds: number;

  /**
   * `null` watches the whole `<body>`.
   */
  readonly root: null | string;
  readonly timeoutInMilliseconds: number;
}

/**
 * Parameters of {@link resolveSettleOptions}: the options as given.
 */
export type ResolveSettleOptionsParams = SettleOptions;

/**
 * Options of a settle wait.
 */
export interface SettleOptions {
  /**
   * Milliseconds without a DOM mutation inside `root` that count as quiet.
   * Must be below `timeoutInMilliseconds`.
   *
   * @default {@link DEFAULT_SETTLE_QUIET_IN_MILLISECONDS}
   */
  readonly quietInMilliseconds?: number;

  /**
   * CSS selector of the part of the window to watch for changes and images.
   * Pass it when something elsewhere keeps changing (a clock, a progress
   * bar) that the shot or assertion does not care about.
   *
   * @default the whole `<body>`
   */
  readonly root?: string;

  /**
   * How long to wait for a settled page before throwing.
   *
   * @default {@link DEFAULT_SETTLE_TIMEOUT_IN_MILLISECONDS}
   */
  readonly timeoutInMilliseconds?: number;
}

/**
 * Parameters of {@link waitForSettledState}.
 */
export interface WaitForSettledStateParams {
  readonly intervalInMilliseconds: number;
  readonly nowInMilliseconds: (this: void) => number;
  readonly quietInMilliseconds: number;
  readonly readState: (this: void) => Promise<PageSettleState>;
  readonly sleep: (this: void, milliseconds: number) => Promise<void>;
  readonly timeoutInMilliseconds: number;
}

/**
 * Thrown when the page did not settle within the budget. `reasons` says what
 * was still changing when the budget ran out.
 */
export class PageNotSettledError extends Error {
  /**
   * The quiet window that was asked for.
   */
  public readonly quietInMilliseconds: number;

  /**
   * What was still changing when the budget ran out.
   */
  public readonly reasons: readonly string[];

  /**
   * The root selector that was watched, or `null` for the whole body.
   */
  public readonly root: null | string;

  /**
   * The budget the wait ran under.
   */
  public readonly timeoutInMilliseconds: number;

  /**
   * Creates the error.
   *
   * @param params - What the wait asked for, what it found, and the cause.
   */
  public constructor(params: PageNotSettledErrorConstructorParams) {
    super(buildSettleTimeoutMessage(params), params.cause === undefined ? undefined : { cause: params.cause });
    this.name = 'PageNotSettledError';
    this.quietInMilliseconds = params.quietInMilliseconds;
    this.reasons = params.reasons;
    this.root = params.root;
    this.timeoutInMilliseconds = params.timeoutInMilliseconds;
  }
}

/**
 * Builds the message for a root selector that matches nothing, or a page with
 * no `<body>` to watch.
 *
 * @param root - The selector, or `null` for the whole body.
 * @returns The message.
 */
export function buildSettleRootMissingMessage(root: null | string): string {
  return root === null
    ? 'waitForSettledPage: the page has no <body> to watch, or cannot observe DOM changes.'
    : `waitForSettledPage: nothing matches root "${root}", so there is nothing to watch. Check the selector, and that the part of the window it names is on screen.`;
}

/**
 * Builds the message of a wait that ran out of time.
 *
 * @param params - What the wait asked for and what it found.
 * @returns The message.
 */
export function buildSettleTimeoutMessage(params: BuildSettleTimeoutMessageParams): string {
  const where = params.root === null ? 'the page' : `"${params.root}"`;
  const why = params.reasons.length > 0 ? params.reasons.join('; ') : 'it settled just after the budget ran out';
  return `waitForSettledPage: ${where} was not quiet for ${String(params.quietInMilliseconds)} ms within ${String(params.timeoutInMilliseconds)} ms (${why}). Raise timeoutInMilliseconds if the app is slow, pass root to watch only the part that matters (something elsewhere keeps changing), or lower quietInMilliseconds.`;
}

/**
 * Lists what keeps the page from being settled. Empty means settled.
 *
 * @param state - What the page reported.
 * @param quietInMilliseconds - The quiet window asked for.
 * @returns The reasons, in a fixed order: DOM, fonts, images.
 */
export function describeUnsettledReasons(state: PageSettleState, quietInMilliseconds: number): string[] {
  if (state.sinceLastChangeInMilliseconds === null) {
    return ['the watch was lost, probably because the window reloaded during the wait'];
  }
  const count = state.incompleteImageCount;
  const candidates: (false | string)[] = [
    state.sinceLastChangeInMilliseconds < quietInMilliseconds
    && `the DOM changed ${String(Math.round(state.sinceLastChangeInMilliseconds))} ms ago`,
    state.isFontLoading && 'a font is still loading',
    count > 0 && `${String(count)} ${count === 1 ? 'image' : 'images'} in view ${count === 1 ? 'has' : 'have'} not finished loading`
  ];
  return candidates.filter((reason) => reason !== false);
}

/**
 * Checks the options of a settle wait.
 *
 * @param params - The options as given.
 * @returns The options with defaults applied.
 */
export function resolveSettleOptions(params: ResolveSettleOptionsParams): ResolvedSettleOptions {
  const quietInMilliseconds = params.quietInMilliseconds ?? DEFAULT_SETTLE_QUIET_IN_MILLISECONDS;
  const timeoutInMilliseconds = params.timeoutInMilliseconds ?? DEFAULT_SETTLE_TIMEOUT_IN_MILLISECONDS;
  if (!Number.isFinite(quietInMilliseconds) || quietInMilliseconds < 0) {
    throw new RangeError(`waitForSettledPage: quietInMilliseconds must be a number of milliseconds from 0, got ${String(quietInMilliseconds)}.`);
  }
  if (!Number.isFinite(timeoutInMilliseconds) || timeoutInMilliseconds <= 0) {
    throw new RangeError(`waitForSettledPage: timeoutInMilliseconds must be a positive number of milliseconds, got ${String(timeoutInMilliseconds)}.`);
  }
  if (quietInMilliseconds >= timeoutInMilliseconds) {
    throw new RangeError(
      `waitForSettledPage: quietInMilliseconds (${String(quietInMilliseconds)} ms) is not below timeoutInMilliseconds (${String(timeoutInMilliseconds)} ms), so the page could never be quiet long enough. Lower quietInMilliseconds, or raise timeoutInMilliseconds.`
    );
  }
  if (params.root !== undefined && (typeof params.root !== 'string' || params.root === '')) {
    throw new TypeError(`waitForSettledPage: root must be a non-empty CSS selector, got ${JSON.stringify(params.root)}.`);
  }
  return { quietInMilliseconds, root: params.root ?? null, timeoutInMilliseconds };
}

/**
 * Reads the page until it is settled or the budget runs out. At least one read
 * always happens, and no read starts past the deadline.
 *
 * @param params - The reader, the clock and the budget.
 * @returns The reasons from the last read: empty when the page settled.
 */
export async function waitForSettledState(params: WaitForSettledStateParams): Promise<string[]> {
  const deadline = params.nowInMilliseconds() + params.timeoutInMilliseconds;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Loop exits via return.
  while (true) {
    const reasons = describeUnsettledReasons(await params.readState(), params.quietInMilliseconds);
    if (reasons.length === 0 || params.nowInMilliseconds() >= deadline) {
      return reasons;
    }
    await params.sleep(params.intervalInMilliseconds);
  }
}
