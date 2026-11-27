/**
 * @file
 *
 * `assertLayout` and `findLayoutProblems`: one call that reports what is wrong
 * with the layout of a part of the Obsidian window — horizontal overflow,
 * touch targets under 44 px, and Tab stops that show no focus ring.
 *
 * Ported (whitebox) from `src/e2e/helpers/layout-page-scripts.ts` and the
 * `checkLayout` orchestration in `src/e2e/helpers/create-helpers.ts` of
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
 * Re-implemented on this package's architecture rather than copied: every page
 * read is an `evalInObsidian` closure (self-contained, so each one spells out
 * its own element naming), Tab is pressed with the trusted `lib.pressKey`, so
 * the walk works on Android as well as desktop, transitions are quieted with a
 * constructed `CSSStyleSheet` rather than a `<style>` element, and the pixel
 * fallback for a range or color input compares two `captureObsidianScreenshot`
 * frames. What it skips, and why, is the source's own measured knowledge:
 * ellipsis text, visually hidden boxes, rings drawn on `::after`, and the
 * resting `box-shadow` Obsidian gives every button. The source calls it
 * `checkLayout`; here a `check` prefix names a boolean predicate, so it is
 * `assertLayout`.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian) covered by integration tests, not unit tests. */

import type {
  EvalInObsidianParams,
  GenericObject
} from '../eval/eval-in-obsidian.ts';
import type { ObsidianTransport } from '../transport/transport.ts';
import type {
  FocusWalkStartFailure,
  LayoutCheckName,
  LayoutCheckOptions,
  LayoutCut,
  LayoutFinding,
  LayoutProblem,
  ResolvedFocusRingCheck
} from './layout-options.ts';

import { captureObsidianScreenshot } from '../capture/capture-obsidian-screenshot.ts';
import { importSharp } from '../capture/sharp-loader.ts';
import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { normalizeOptionalProperties } from '../normalize-optional-properties.ts';
import {
  buildFocusStartMessage,
  buildLayoutFailureMessage,
  buildNoChecksMessage,
  buildRootMissingMessage,
  capLayoutProblems,
  MAXIMUM_FINDINGS_PER_CHECK,
  resolveLayoutCheckOptions
} from './layout-options.ts';

/**
 * Parameters of {@link assertLayout}.
 */
export interface AssertLayoutParams extends LayoutCheckOptions {
  /**
   * Override the transport. When omitted, the transport the current test
   * context is driving is used.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The vault whose Obsidian window to check. When omitted, the current test
   * context's vault is used.
   */
  readonly vaultPath?: string;
}

/**
 * Parameters of {@link findLayoutProblems}: the same as {@link assertLayout}'s.
 */
export type FindLayoutProblemsParams = AssertLayoutParams;

/**
 * Parameters of the {@link LayoutAssertionError} constructor.
 */
export interface LayoutAssertionErrorConstructorParams {
  readonly cuts: readonly LayoutCut[];
  readonly minimumSizeInPixels: number;
  readonly problems: readonly LayoutProblem[];
  readonly root: string;
}

interface FocusStop {
  readonly detail: string;
  readonly hasRing: boolean;
  readonly isInRoot: boolean;

  /**
   * The element was already visited by this walk: focus went round in a
   * circle, which ends the walk.
   */
  readonly isRepeat: boolean;

  /**
   * Set when no readable style changed for a range or color input, whose ring
   * Obsidian draws on a vendor pseudo-element (`::-webkit-slider-thumb`) that
   * `getComputedStyle` cannot read: the box to compare as pixels.
   */
  readonly pixelBox: null | PixelBox;
  readonly where: string;
}

// The closure inputs are `type` aliases rather than interfaces: an interface
// carries no index signature, so it does not satisfy `evalInObsidian`'s
// `Record<string, unknown>` input constraint.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- See above: an interface does not satisfy the input constraint.
type FocusStopInput = {
  readonly ignoreSelector: null | string;
  readonly root: string;
};

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- An interface does not satisfy the input constraint.
type FocusWalkStartInput = {
  readonly root: string;
  readonly startSelector: null | string;
};

type FocusWalkStartOutcome = 'no-root' | 'ok' | FocusWalkStartFailure;

// A `window` property rather than a closure variable: the walk and the pixel
// comparison span several evaluations, and elements are not serializable. Kept
// local rather than declared globally, like every other holder of a harness
// `window` property, so it never leaks into consumer types.
interface LayoutCheckHolder {
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- A pixel comparison sets and clears this window state.
  __obsidianIntegrationTestingLayoutPixel?: LayoutPixelRecord | undefined;
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- Each walk starts a fresh visited set.
  __obsidianIntegrationTestingLayoutSeen?: undefined | WeakSet<Element>;
}

interface LayoutFindings {
  readonly findings: LayoutFinding[];
  readonly total: number;
}

interface LayoutPixelRecord {
  readonly el: HTMLElement;
  readonly sheet: CSSStyleSheet;
}

type LayoutResult = LayoutFindings | null;

interface LayoutRun {
  readonly cuts: LayoutCut[];
  readonly minimumSizeInPixels: number;
  readonly problems: LayoutProblem[];
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- An interface does not satisfy the input constraint.
type OverflowInput = {
  readonly ignoreSelector: null | string;
  readonly limit: number;
  readonly root: string;
};

interface PixelBox {
  readonly height: number;
  readonly viewportWidth: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

type PixelStep = 'begin' | 'blur' | 'end';

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- An interface does not satisfy the input constraint.
type PixelStepInput = {
  readonly step: PixelStep;
};

interface RegionDiffersParams {
  readonly box: PixelBox;
  readonly first: Uint8Array;
  readonly second: Uint8Array;
}

interface RootProbe {
  readonly isMobile: boolean;
  readonly isRootFound: boolean;
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- An interface does not satisfy the input constraint.
type RootProbeInput = {
  readonly root: string;
};

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- An interface does not satisfy the input constraint.
type SmallTargetsInput = {
  readonly ignoreSelector: null | string;
  readonly limit: number;
  readonly minimumSizeInPixels: number;
  readonly root: string;
  readonly selector: string;
};

type TransportTarget = Pick<AssertLayoutParams, 'transport' | 'vaultPath'>;

/**
 * Thrown by {@link assertLayout} when it found problems. The message lists
 * every one; {@link problems} carries them as data.
 */
export class LayoutAssertionError extends Error {
  /**
   * The kinds of problem that had more findings than {@link problems} carries.
   */
  public readonly cuts: readonly LayoutCut[];

  /**
   * The problems, at most {@link MAXIMUM_FINDINGS_PER_CHECK} of each kind.
   */
  public readonly problems: readonly LayoutProblem[];

  /**
   * The root selector that was checked.
   */
  public readonly root: string;

  /**
   * Creates the error.
   *
   * @param params - The root, the problems, the touch size and the cuts.
   */
  public constructor(params: LayoutAssertionErrorConstructorParams) {
    super(buildLayoutFailureMessage(params));
    this.name = 'LayoutAssertionError';
    this.cuts = params.cuts;
    this.problems = params.problems;
    this.root = params.root;
  }
}

// The padding around a range or color input that the pixel comparison takes in,
// so a ring drawn just outside the box is still seen.
const PIXEL_BOX_PADDING_IN_PIXELS = 6;

/**
 * Checks the layout of a part of the Obsidian window and throws a
 * {@link LayoutAssertionError} listing every problem found.
 *
 * @param params - What to check, and transport and vault overrides.
 * @returns A {@link Promise} that resolves when nothing is wrong.
 * @throws {@link LayoutAssertionError} listing the problems.
 */
export async function assertLayout(params: AssertLayoutParams): Promise<void> {
  const run = await runLayoutChecks(params);
  if (run.problems.length > 0) {
    throw new LayoutAssertionError({ cuts: run.cuts, minimumSizeInPixels: run.minimumSizeInPixels, problems: run.problems, root: params.root });
  }
}

/**
 * Checks the layout of a part of the Obsidian window and returns what is
 * wrong, for a test that asserts on the list itself.
 *
 * @param params - What to check, and transport and vault overrides.
 * @returns A {@link Promise} that resolves to the problems, at most
 *   {@link MAXIMUM_FINDINGS_PER_CHECK} of each kind; empty when nothing is wrong.
 */
export async function findLayoutProblems(params: FindLayoutProblemsParams): Promise<LayoutProblem[]> {
  const { problems } = await runLayoutChecks(params);
  return problems;
}

async function captureFrame(target: TransportTarget): Promise<Uint8Array> {
  return await captureObsidianScreenshot({
    ...target,
    shouldHideCaret: false,
    shouldHideVaultName: false,
    shouldPinWindowFocus: false,
    shouldVerifyTheme: false
  });
}

async function checkIsPixelStepApplied(target: TransportTarget, step: PixelStep): Promise<boolean> {
  return await evaluate<PixelStepInput, boolean>(target, {
    callback: ({ step: currentStep }) => {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the layout-check record is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
      const holder = globalThis as unknown as LayoutCheckHolder;
      if (currentStep === 'begin') {
        const el = document.activeElement;
        if (!el?.instanceOf(HTMLElement)) {
          return false;
        }
        const sheet = new CSSStyleSheet();
        sheet.replaceSync('*, *::before, *::after { transition: none !important; animation: none !important; }');
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        holder.__obsidianIntegrationTestingLayoutPixel = { el, sheet };
        return true;
      }

      const record = holder.__obsidianIntegrationTestingLayoutPixel;
      if (!record) {
        return false;
      }

      if (currentStep === 'blur') {
        record.el.blur();
        return true;
      }

      record.el.focus({ focusVisible: true } as FocusOptions);
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== record.sheet);
      holder.__obsidianIntegrationTestingLayoutPixel = undefined;
      return document.activeElement === record.el;
    },
    input: { step }
  });
}

/**
 * For a control whose ring is drawn on a vendor pseudo-element: whether the
 * pixels around it change when it loses focus. The element ends up focused
 * again.
 *
 * @param target - Transport and vault.
 * @param box - The control's box, in CSS pixels.
 * @returns Whether focus changes any pixel there.
 */
async function checkIsRingVisibleInPixels(target: TransportTarget, box: PixelBox): Promise<boolean> {
  if (!(await checkIsPixelStepApplied(target, 'begin'))) {
    throw new Error('assertLayout(): the pixel comparison of a focus ring could not start: nothing has focus.');
  }

  let isDifferent = false;
  let failure: Error | null = null;
  try {
    const focusedPng = await captureFrame(target);
    await checkIsPixelStepApplied(target, 'blur');
    const plainPng = await captureFrame(target);
    isDifferent = await checkRegionDiffers({ box, first: focusedPng, second: plainPng });
  } catch (error: unknown) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  // Always give focus back and remove the quieting sheet, also after a failed capture.
  const isFocusedAgain = await checkIsPixelStepApplied(target, 'end');
  if (failure !== null) {
    throw failure;
  }
  if (!isFocusedAgain) {
    throw new Error(
      'assertLayout(): the element did not take focus back after the pixel comparison of its focus ring, '
        + 'so the Tab walk cannot go on. Add it to focusRing.ignoreSelector.'
    );
  }
  return isDifferent;
}

async function checkRegionDiffers(params: RegionDiffersParams): Promise<boolean> {
  const { box, first, second } = params;
  const sharp = await importSharp('assertLayout');
  const firstRaw = await sharp(first).raw().toBuffer({ resolveWithObject: true });
  const secondRaw = await sharp(second).raw().toBuffer({ resolveWithObject: true });
  const { channels, height, width } = firstRaw.info;
  if (secondRaw.info.width !== width || secondRaw.info.height !== height) {
    return true;
  }

  // The frame is in device pixels; the box is in CSS pixels.
  const scale = box.viewportWidth > 0 ? width / box.viewportWidth : 1;
  const left = Math.max(0, Math.floor((box.x - PIXEL_BOX_PADDING_IN_PIXELS) * scale));
  const top = Math.max(0, Math.floor((box.y - PIXEL_BOX_PADDING_IN_PIXELS) * scale));
  const right = Math.min(width, Math.ceil((box.x + box.width + PIXEL_BOX_PADDING_IN_PIXELS) * scale));
  const bottom = Math.min(height, Math.ceil((box.y + box.height + PIXEL_BOX_PADDING_IN_PIXELS) * scale));
  for (let y = top; y < bottom; y++) {
    const rowStart = (y * width + left) * channels;
    const rowEnd = (y * width + right) * channels;
    for (let offset = rowStart; offset < rowEnd; offset++) {
      if (firstRaw.data[offset] !== secondRaw.data[offset]) {
        return true;
      }
    }
  }
  return false;
}

async function evaluate<Input extends GenericObject, Result>(
  target: TransportTarget,
  params: Pick<EvalInObsidianParams<Input, Result>, 'callback' | 'input'>
): Promise<Result> {
  return await evalInObsidian({ ...params, ...target });
}

async function findOverflow(target: TransportTarget, input: OverflowInput): Promise<LayoutResult> {
  return await evaluate<OverflowInput, LayoutResult>(target, {
    callback: ({ ignoreSelector, limit, root: rootSelector }) => {
      const root = document.querySelector(rootSelector);
      if (!root) {
        return null;
      }

      // eslint-disable-next-line unicorn/consistent-function-scoping -- This closure is serialized and evaluated in the renderer, so a helper hoisted to module scope would not exist there.
      function describe(el: Element): string {
        const classNames = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter((name) => name !== '') : [];
        return el.tagName.toLowerCase() + (el.id === '' ? '' : `#${el.id}`) + classNames.map((name) => `.${name}`).join('');
      }

      // eslint-disable-next-line unicorn/consistent-function-scoping -- Serialized closure; see `describe`.
      function isClipping(value: string): boolean {
        return value === 'hidden' || value === 'clip';
      }

      const findings: LayoutFinding[] = [];
      let total = 0;
      for (const el of [root, ...root.querySelectorAll('*')]) {
        if ((el.scrollWidth <= el.clientWidth + 1) || (ignoreSelector !== null && el.closest(ignoreSelector) !== null)) {
          continue;
        }

        // Not layout bugs: text cut with an ellipsis (Obsidian does it for setting
        // names and tabs), and the visually hidden "screen reader only" box.
        const style = getComputedStyle(el);
        const hasEllipsis = style.textOverflow === 'ellipsis' || (style.whiteSpace === 'nowrap' && isClipping(style.overflowX));
        const isTiny = el.clientWidth <= 1 || el.clientHeight <= 1;
        const legacyClip = style.getPropertyValue('clip');
        const isClipped = isClipping(style.overflowX) || isClipping(style.overflowY) || (style.clipPath !== 'none' && style.clipPath !== '')
          || (legacyClip !== 'auto' && legacyClip !== '');
        if (hasEllipsis || (isTiny && isClipped)) {
          continue;
        }

        total++;
        if (findings.length < limit) {
          findings.push({ detail: `scrollWidth ${String(el.scrollWidth)} > clientWidth ${String(el.clientWidth)}`, where: describe(el) });
        }
      }

      return { findings, total };
    },
    input
  });
}

async function findSmallTargets(target: TransportTarget, input: SmallTargetsInput): Promise<LayoutResult> {
  return await evaluate<SmallTargetsInput, LayoutResult>(target, {
    callback: ({ ignoreSelector, limit, minimumSizeInPixels, root: rootSelector, selector }) => {
      const ROUNDING_ALLOWANCE_IN_PIXELS = 0.5;
      const root = document.querySelector(rootSelector);
      if (!root) {
        return null;
      }

      // eslint-disable-next-line unicorn/consistent-function-scoping -- This closure is serialized and evaluated in the renderer, so a helper hoisted to module scope would not exist there.
      function describe(el: Element): string {
        const classNames = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter((name) => name !== '') : [];
        return el.tagName.toLowerCase() + (el.id === '' ? '' : `#${el.id}`) + classNames.map((name) => `.${name}`).join('');
      }

      const floor = minimumSizeInPixels - ROUNDING_ALLOWANCE_IN_PIXELS;
      const findings: LayoutFinding[] = [];
      let total = 0;
      for (const el of root.querySelectorAll(selector)) {
        // A hidden element has no box and cannot be tapped, so its size does not
        // matter. `getClientRects` rather than `offsetParent`, which a
        // `position: fixed` element lacks although it is shown.
        if (el.getClientRects().length === 0 || getComputedStyle(el).visibility === 'hidden' || (ignoreSelector !== null && el.closest(ignoreSelector) !== null)) {
          continue;
        }

        const box = el.getBoundingClientRect();
        if (box.width >= floor && box.height >= floor) {
          continue;
        }

        total++;
        if (findings.length < limit) {
          findings.push({ detail: `${String(Math.round(box.width))} x ${String(Math.round(box.height))} px`, where: describe(el) });
        }
      }

      return { findings, total };
    },
    input
  });
}

async function pressTab(target: TransportTarget): Promise<void> {
  await evaluate<Record<string, never>, null>(target, {
    callback: async ({ lib }): Promise<null> => {
      const TAB_SETTLE_TIMEOUT_IN_MILLISECONDS = 1000;
      const TAB_POLL_INTERVAL_IN_MILLISECONDS = 20;

      const before = document.activeElement;
      await lib.pressKey({ key: 'Tab' });
      // The key reaches the page asynchronously. A stop that does not move (a
      // trap of one element) is read after the timeout, as a repeat.
      const startTime = Date.now();
      while (document.activeElement === before && Date.now() - startTime < TAB_SETTLE_TIMEOUT_IN_MILLISECONDS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, TAB_POLL_INTERVAL_IN_MILLISECONDS);
        });
      }
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
      return null;
    },
    input: {}
  });
}

async function probeRoot(target: TransportTarget, root: string): Promise<RootProbe> {
  return await evaluate<RootProbeInput, RootProbe>(target, {
    callback: ({ obsidianModule, root: rootSelector }) => ({
      isMobile: obsidianModule.Platform.isMobile,
      isRootFound: document.querySelector(rootSelector) !== null
    }),
    input: { root }
  });
}

async function readFocusStop(target: TransportTarget, input: FocusStopInput): Promise<FocusStop | null> {
  return await evaluate<FocusStopInput, FocusStop | null>(target, {
    callback: ({ ignoreSelector, root: rootSelector }) => {
      interface PartStyle {
        readonly isOutlineVisible: boolean;
        readonly outline: string;
        readonly shadow: string;
      }

      const root = document.querySelector(rootSelector);
      const el = document.activeElement;
      if (!root || !el?.instanceOf(HTMLElement) || el === document.body) {
        return null;
      }

      const classNames = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter((name) => name !== '') : [];
      const where = el.tagName.toLowerCase() + (el.id === '' ? '' : `#${el.id}`) + classNames.map((name) => `.${name}`).join('');

      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the layout-check record is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
      const holder = globalThis as unknown as LayoutCheckHolder;
      const seen = holder.__obsidianIntegrationTestingLayoutSeen ?? new WeakSet<Element>();
      holder.__obsidianIntegrationTestingLayoutSeen = seen;
      const isRepeat = seen.has(el);
      seen.add(el);

      const isInRoot = root.contains(el);
      if (!isInRoot) {
        return { detail: 'outside the root', hasRing: true, isInRoot, isRepeat, pixelBox: null, where };
      }
      if (ignoreSelector !== null && el.closest(ignoreSelector) !== null) {
        return { detail: 'ignored', hasRing: true, isInRoot, isRepeat, pixelBox: null, where };
      }

      // A style that has just changed reads as its old value while a transition
      // runs, so transitions are off for both reads.
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('*, *::before, *::after { transition: none !important; animation: none !important; }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

      // Obsidian draws some rings on a pseudo-element (a `.setting-item` rings
      // itself with `:focus-visible::after`), so all three parts are compared.
      const parts = ['', '::before', '::after'];

      function readParts(partOwner: Element): PartStyle[] {
        return parts.map((part) => {
          const style = getComputedStyle(partOwner, part === '' ? null : part);
          return {
            isOutlineVisible: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0,
            outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} offset ${style.outlineOffset}`,
            shadow: style.boxShadow === '' ? 'none' : style.boxShadow
          };
        });
      }

      try {
        const focused = readParts(el);
        el.blur();
        const plain = readParts(el);
        // `focusVisible` keeps `:focus-visible` matching on a script focus.
        el.focus({ focusVisible: true } as FocusOptions);
        if (document.activeElement !== el) {
          throw new Error(
            `${where} did not take focus back after the focus ring check blurred it: it was replaced or detached on blur, `
              + 'so the Tab walk cannot go on. Add it to focusRing.ignoreSelector, or keep the element in place on blur.'
          );
        }

        // A ring is a CHANGE: Obsidian gives every button a resting box-shadow, so
        // "has a shadow" would pass a button whose ring was removed.
        const hasRing = focused.some((now, index) => {
          const resting = plain[index];
          if (resting === undefined) {
            return false;
          }
          const hasOutlineRing = now.isOutlineVisible && now.outline !== resting.outline;
          const hasShadowRing = now.shadow !== 'none' && now.shadow !== resting.shadow;
          return hasOutlineRing || hasShadowRing;
        });

        const isVendorRing = el.instanceOf(HTMLInputElement) && (el.type === 'range' || el.type === 'color');
        const box = el.getBoundingClientRect();
        const own = focused[0];
        const ownOutline = own?.outline.replace(/ offset .*$/, '') ?? '';
        return {
          detail: `focus changes neither the outline (${ownOutline}) nor the box-shadow (${own?.shadow ?? 'none'}), on the element or its ::before, ::after`,
          hasRing,
          isInRoot,
          isRepeat,
          pixelBox: !hasRing && isVendorRing
            ? { height: box.height, viewportWidth: window.innerWidth, width: box.width, x: box.x, y: box.y }
            : null,
          where
        };
      } finally {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
      }
    },
    input
  });
}

async function runLayoutChecks(params: AssertLayoutParams): Promise<LayoutRun> {
  const { transport, vaultPath, ...options } = params;
  const target = normalizeOptionalProperties<TransportTarget>({ transport, vaultPath });
  const resolved = resolveLayoutCheckOptions(options);

  // The root is looked up once, before any check: a missing root fails even
  // when every check is off.
  const probe = await probeRoot(target, resolved.root);
  if (!probe.isRootFound) {
    throw new Error(buildRootMissingMessage(resolved.root));
  }

  const isTouchEnabled = resolved.touchTargets.isEnabled ?? probe.isMobile;
  if (!resolved.overflow.isEnabled && !isTouchEnabled && !resolved.focusRing.isEnabled) {
    throw new Error(buildNoChecksMessage());
  }

  const problems: LayoutProblem[] = [];
  const cuts: LayoutCut[] = [];
  function collect(check: LayoutCheckName, result: LayoutResult): void {
    if (result === null) {
      throw new Error(buildRootMissingMessage(resolved.root));
    }
    problems.push(...result.findings.map((finding): LayoutProblem => ({ check, ...finding })));
    if (result.total > result.findings.length) {
      cuts.push({ check, total: result.total });
    }
  }

  if (resolved.overflow.isEnabled) {
    collect(
      'overflow',
      await findOverflow(target, {
        ignoreSelector: resolved.overflow.ignoreSelector,
        limit: MAXIMUM_FINDINGS_PER_CHECK,
        root: resolved.root
      })
    );
  }

  if (isTouchEnabled) {
    collect(
      'touch-target',
      await findSmallTargets(target, {
        ignoreSelector: resolved.touchTargets.ignoreSelector,
        limit: MAXIMUM_FINDINGS_PER_CHECK,
        minimumSizeInPixels: resolved.touchTargets.minimumSizeInPixels,
        root: resolved.root,
        selector: resolved.touchTargets.selector
      })
    );
  }

  if (resolved.focusRing.isEnabled) {
    const capped = capLayoutProblems(await walkFocus(target, resolved.root, resolved.focusRing), MAXIMUM_FINDINGS_PER_CHECK);
    problems.push(...capped.problems);
    cuts.push(...capped.cuts);
  }

  return { cuts, minimumSizeInPixels: resolved.touchTargets.minimumSizeInPixels, problems };
}

async function startFocusWalk(target: TransportTarget, input: FocusWalkStartInput): Promise<FocusWalkStartOutcome> {
  return await evaluate<FocusWalkStartInput, FocusWalkStartOutcome>(target, {
    callback: ({ root: rootSelector, startSelector }) => {
      const root = document.querySelector(rootSelector);
      if (!root) {
        return 'no-root';
      }

      function isCandidate(el: Element): boolean {
        const isShown = el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        const isDisabled = 'disabled' in el && el.disabled === true;
        return isShown && !isDisabled;
      }

      const focusableSelector = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
      const start = startSelector === null
        ? [...root.querySelectorAll(focusableSelector)].find((candidate) => isCandidate(candidate)) ?? null
        : document.querySelector(startSelector);
      if (!start) {
        return 'no-start';
      }
      if (!root.contains(start)) {
        return 'outside-root';
      }
      if (!start.instanceOf(HTMLElement)) {
        return 'not-focused';
      }

      // `focusVisible` makes Chromium match `:focus-visible` on a script focus
      // even when the last input was a pointer, so the first stop is read as a
      // keyboard user would see it.
      start.focus({ focusVisible: true } as FocusOptions);
      if (document.activeElement !== start) {
        return 'not-focused';
      }

      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the layout-check record is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
      const holder = globalThis as unknown as LayoutCheckHolder;
      holder.__obsidianIntegrationTestingLayoutSeen = new WeakSet<Element>();
      return 'ok';
    },
    input
  });
}

/**
 * Tabs through the root and reports every stop that shows no focus ring (and,
 * with `shouldStayInside`, the Tab that leaves it). The walk ends when focus
 * leaves the root, comes back to a stop it already visited, or after
 * `maximumStopCount` presses. It is an error, never a pass, when it cannot
 * start inside the root or sees no stop at all.
 *
 * @param target - Transport and vault.
 * @param root - The root selector.
 * @param focusRing - The resolved focus-ring options.
 * @returns The problems found.
 */
async function walkFocus(target: TransportTarget, root: string, focusRing: ResolvedFocusRingCheck): Promise<LayoutProblem[]> {
  const start = await startFocusWalk(target, { root, startSelector: focusRing.startSelector });
  if (start === 'no-root') {
    throw new Error(buildRootMissingMessage(root));
  }
  if (start !== 'ok') {
    throw new Error(buildFocusStartMessage({ outcome: start, root, startSelector: focusRing.startSelector }));
  }

  const problems: LayoutProblem[] = [];
  const reportedKeys = new Set<string>();
  for (let stopIndex = 0; stopIndex <= focusRing.maximumStopCount; stopIndex++) {
    if (stopIndex > 0) {
      await pressTab(target);
    }

    let stop = await readFocusStop(target, { ignoreSelector: focusRing.ignoreSelector, root });
    // Tab past the last focusable element can leave nothing focused; that is
    // focus leaving the root too.
    if (stop === null && stopIndex > 0) {
      stop = { detail: 'outside the root', hasRing: true, isInRoot: false, isRepeat: false, pixelBox: null, where: 'body' };
    }
    if (stop?.pixelBox) {
      stop = { ...stop, hasRing: await checkIsRingVisibleInPixels(target, stop.pixelBox), pixelBox: null };
    }

    if (stop === null || (stopIndex === 0 && !stop.isInRoot)) {
      throw new Error(
        `assertLayout(): the Tab walk found no stop inside ${JSON.stringify(root)}: focus is not on an element of the root `
          + 'after it was set. Check that the root stays on the page.'
      );
    }

    if (!stop.isInRoot) {
      if (focusRing.shouldStayInside) {
        problems.push({ check: 'focus-escape', detail: `Tab ${String(stopIndex)} moved focus out of ${JSON.stringify(root)}`, where: stop.where });
      }
      break;
    }

    if (stop.isRepeat) {
      break;
    }

    const key = `${stop.where}|${stop.detail}`;
    if (stop.hasRing || reportedKeys.has(key)) {
      continue;
    }

    reportedKeys.add(key);
    problems.push({ check: 'focus-ring', detail: stop.detail, where: stop.where });
  }

  return problems;
}

/* v8 ignore stop */
