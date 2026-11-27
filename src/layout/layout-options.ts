/**
 * @file
 *
 * The pure half of `assertLayout` and `findLayoutProblems`: option resolution, defaults, the cap on
 * findings and the failure text. Everything that reads the page lives in
 * `assert-layout.ts`.
 *
 * Ported (whitebox) from `src/e2e/helpers/layout.ts` of
 * [`obsidian-plugin-dev-kit`](https://github.com/Dimagious/obsidian-plugin-dev-kit)
 * at aa82d95 (v0.4.0), Copyright (c) 2026 Dmitriy Yurkin, used under the MIT
 * License. Re-written against this package's naming and `null` conventions.
 */

/**
 * Options of the focus-ring check.
 */
export interface FocusRingCheckOptions {
  /**
   * CSS selector of elements the ring check skips, matched against the element
   * and its ancestors: a control replaced on blur, or one that shows focus some
   * other way.
   */
  readonly ignoreSelector?: string;

  /**
   * The walk ends after this many Tab presses if focus has not left the root
   * by then. A whole number from 1 to {@link MAXIMUM_FOCUS_STOP_COUNT}.
   *
   * @default {@link DEFAULT_MAXIMUM_FOCUS_STOP_COUNT}
   */
  readonly maximumStopCount?: number;

  /**
   * Report it as a `focus-escape` problem when Tab moves focus out of the
   * root, as for a modal that must trap focus. Otherwise leaving the root just
   * ends the walk.
   *
   * @default `false`
   */
  readonly shouldStayInside?: boolean;

  /**
   * CSS selector of the element where the walk starts.
   *
   * @default The first visible, enabled element of the root that can take focus.
   */
  readonly startSelector?: string;
}

/**
 * The checks `assertLayout` runs, as each problem names them.
 */
export type LayoutCheckName = 'focus-escape' | 'focus-ring' | 'overflow' | 'touch-target';

/**
 * What `assertLayout` and `findLayoutProblems` look at.
 *
 * Every check can be turned off; turning them all off is an error, so a check
 * never passes by checking nothing.
 */
export interface LayoutCheckOptions {
  /**
   * Every Tab stop inside {@link root} shows a focus ring: focus changes an
   * outline or a box-shadow of the element or its `::before` / `::after`.
   *
   * Off by default, because it presses Tab and moves focus.
   *
   * @default `false`
   */
  readonly focusRing?: boolean | FocusRingCheckOptions;

  /**
   * No element inside {@link root} is wider than its box
   * (`scrollWidth > clientWidth + 1`), scroll panes included.
   *
   * @default `true`
   */
  readonly overflow?: boolean | OverflowCheckOptions;

  /**
   * CSS selector of the part of the window to check: a modal, a view, a
   * settings tab. Required, so a check never passes by looking at nothing.
   */
  readonly root: string;

  /**
   * Every visible touch target inside {@link root} is at least
   * {@link TouchTargetCheckOptions.minimumSizeInPixels} wide and high.
   *
   * @default On when Obsidian runs its mobile layout (`Platform.isMobile`), off otherwise.
   */
  readonly touchTargets?: boolean | TouchTargetCheckOptions;
}

/**
 * A kind of problem that had more findings than the list carries.
 */
export interface LayoutCut {
  readonly check: LayoutCheckName;
  readonly total: number;
}

/**
 * One thing a layout check found.
 */
export interface LayoutFinding {
  /**
   * What is wrong, with the measured numbers.
   */
  readonly detail: string;

  /**
   * The element, named the way a person finds it (`button.mod-cta`).
   */
  readonly where: string;
}

/**
 * One problem, with the check that found it.
 */
export interface LayoutProblem extends LayoutFinding {
  readonly check: LayoutCheckName;
}

/**
 * Options of the overflow check.
 */
export interface OverflowCheckOptions {
  /**
   * CSS selector of elements to leave out, matched against the element and its
   * ancestors: a code block or a table that scrolls on purpose.
   */
  readonly ignoreSelector?: string;
}

/**
 * The resolved focus-ring check.
 */
export interface ResolvedFocusRingCheck {
  readonly ignoreSelector: null | string;
  readonly isEnabled: boolean;
  readonly maximumStopCount: number;
  readonly shouldStayInside: boolean;
  readonly startSelector: null | string;
}

/**
 * {@link LayoutCheckOptions} after validation, with every default filled in.
 */
export interface ResolvedLayoutCheckOptions {
  readonly focusRing: ResolvedFocusRingCheck;
  readonly overflow: ResolvedOverflowCheck;
  readonly root: string;
  readonly touchTargets: ResolvedTouchTargetCheck;
}

/**
 * The resolved overflow check.
 */
export interface ResolvedOverflowCheck {
  readonly ignoreSelector: null | string;
  readonly isEnabled: boolean;
}

/**
 * The resolved touch-target check.
 */
export interface ResolvedTouchTargetCheck {
  readonly ignoreSelector: null | string;

  /**
   * `null` when the caller did not say: decided from the window (mobile or not).
   */
  readonly isEnabled: boolean | null;
  readonly minimumSizeInPixels: number;
  readonly selector: string;
}

/**
 * Options of the touch-target check.
 */
export interface TouchTargetCheckOptions {
  /**
   * CSS selector of targets to leave out, matched against the target and its
   * ancestors: a checkbox drawn small inside a larger row.
   */
  readonly ignoreSelector?: string;

  /**
   * Smallest width and height, in CSS pixels.
   *
   * @default {@link DEFAULT_MINIMUM_TOUCH_SIZE_IN_PIXELS}
   */
  readonly minimumSizeInPixels?: number;

  /**
   * CSS selector of what counts as a target inside the root.
   *
   * @default {@link DEFAULT_TOUCH_TARGET_SELECTOR}
   */
  readonly selector?: string;
}

/**
 * Smaller than this, in CSS pixels, is hard to hit with a thumb. Apple's
 * guidance is 44 and Material's 48.
 */
export const DEFAULT_MINIMUM_TOUCH_SIZE_IN_PIXELS = 44;

/**
 * What a finger presses: the elements the touch check looks at when the
 * caller does not say. The attribute values are unquoted identifiers, which CSS
 * allows, so the generated API page needs no escaped quotes in its frontmatter.
 */
export const DEFAULT_TOUCH_TARGET_SELECTOR = 'button, a[href], select, input:not([type=hidden]), textarea, summary, [role=button], [role=tab], [role=menuitem]';

/**
 * How many Tab presses the walk makes by default.
 */
export const DEFAULT_MAXIMUM_FOCUS_STOP_COUNT = 20;

/**
 * The most Tab presses a walk may be asked for.
 */
export const MAXIMUM_FOCUS_STOP_COUNT = 100;

/**
 * At most this many findings of one kind are reported, so a broken layout
 * does not list the whole tree.
 */
export const MAXIMUM_FINDINGS_PER_CHECK = 10;

const ROOT_KEYS = ['focusRing', 'overflow', 'root', 'touchTargets'];
const OVERFLOW_KEYS = ['ignoreSelector'];
const TOUCH_TARGET_KEYS = ['ignoreSelector', 'minimumSizeInPixels', 'selector'];
const FOCUS_RING_KEYS = ['ignoreSelector', 'maximumStopCount', 'shouldStayInside', 'startSelector'];

const LAYOUT_CHECK_LABELS: Record<LayoutCheckName, string> = {
  'focus-escape': 'focus left the root',
  'focus-ring': 'no focus ring',
  'overflow': 'horizontal overflow',
  'touch-target': 'touch target too small'
};

/**
 * Parameters of {@link buildFocusStartMessage}.
 */
export interface BuildFocusStartMessageParams {
  readonly outcome: FocusWalkStartFailure;
  readonly root: string;
  readonly startSelector: null | string;
}

/**
 * Parameters of {@link buildLayoutFailureMessage}.
 */
export interface BuildLayoutFailureMessageParams {
  readonly cuts: readonly LayoutCut[];
  readonly minimumSizeInPixels: number;
  readonly problems: readonly LayoutProblem[];
  readonly root: string;
}

/**
 * What {@link capLayoutProblems} returns.
 */
export interface CappedLayoutProblems {
  readonly cuts: LayoutCut[];
  readonly problems: LayoutProblem[];
}

/**
 * Why a focus walk could not start, other than a missing root.
 */
export type FocusWalkStartFailure = 'no-start' | 'not-focused' | 'outside-root';

/**
 * Builds the message for a walk that could not start.
 *
 * @param params - Why it could not start, the root and the start selector.
 * @returns The message, which says what to do.
 */
export function buildFocusStartMessage(params: BuildFocusStartMessageParams): string {
  const { outcome, root, startSelector } = params;
  const rootText = JSON.stringify(root);
  switch (outcome) {
    case 'no-start': {
      return startSelector === null
        ? `assertLayout(): nothing inside ${rootText} can take focus (no visible, enabled button, link, input, select or tabindex="0"), `
          + 'so there are no Tab stops to check. Turn focusRing off, or check the root selector.'
        : `assertLayout(): focusRing.startSelector ${JSON.stringify(startSelector)} matches nothing. Check the selector.`;
    }
    case 'not-focused': {
      const startText = startSelector === null ? '' : ` (${JSON.stringify(startSelector)})`;
      return `assertLayout(): the element where the Tab walk starts${startText} did not take focus. `
        + `Pick a focusable element inside ${rootText} (a button, a link, an input, or tabindex="0").`;
    }
    default: {
      // 'outside-root', the one outcome left.
      return `assertLayout(): focusRing.startSelector ${JSON.stringify(startSelector)} is not inside ${rootText}, `
        + 'so the walk would check nothing of it. Pick an element inside the root.';
    }
  }
}

/**
 * Builds the failure text: one line per problem, so a run lists everything
 * that is wrong at once, then a hint per kind of problem.
 *
 * @param params - The root, the problems, the touch size and the cuts.
 * @returns The message.
 */
export function buildLayoutFailureMessage(params: BuildLayoutFailureMessageParams): string {
  const { cuts, minimumSizeInPixels, problems, root } = params;
  const problemLines = problems.map((problem) => `  - ${LAYOUT_CHECK_LABELS[problem.check]}: ${problem.where} (${problem.detail})`);
  const cutLines = cuts.map((cut) => {
    const shownCount = problems.filter((problem) => problem.check === cut.check).length;
    return `  - ${LAYOUT_CHECK_LABELS[cut.check]}: (first ${String(shownCount)} of ${String(cut.total)})`;
  });
  const lines = [...problemLines, ...cutLines];

  const checks = new Set(problems.map((problem) => problem.check));
  const hints = [
    checks.has('touch-target')
      ? `Touch targets must be at least ${String(minimumSizeInPixels)} px; raise the size in CSS for the mobile layout, `
        + 'or pass touchTargets: { ignoreSelector } for an element that is not a target.'
      : null,
    checks.has('focus-ring')
      ? 'A focus ring is an outline or a box-shadow that focus changes, on the element or its ::before/::after '
        + '(a resting box-shadow does not count); a theme that sets outline: none needs a replacement.'
      : null,
    checks.has('focus-escape') ? 'Keep Tab inside a modal: focus the first control again when Tab leaves the last one.' : null
  ].filter((hint) => hint !== null);

  const noun = problems.length === 1 ? 'problem' : 'problems';
  return [`assertLayout(): ${String(problems.length)} ${noun} inside ${JSON.stringify(root)}:`, ...lines, ...hints].join('\n');
}

/**
 * Builds the message for a call that turned every check off.
 *
 * @returns The message.
 */
export function buildNoChecksMessage(): string {
  return 'assertLayout(): nothing to check. Every check is off (touch targets are only on by default in the mobile layout). '
    + 'Turn one on: overflow, touchTargets or focusRing.';
}

/**
 * Builds the message for a root selector that matches nothing.
 *
 * @param root - The root selector.
 * @returns The message.
 */
export function buildRootMissingMessage(root: string): string {
  return `assertLayout(): nothing matches the root ${JSON.stringify(root)}. `
    + 'Open the part of the window you want to check before the call, and check the selector.';
}

/**
 * Cuts a problem list to `limit` per kind, keeping the order. The totals of
 * the kinds that were cut come back too, so the failure can say "first 10 of N".
 *
 * @param problems - Every problem found.
 * @param limit - How many of one kind to keep.
 * @returns The kept problems and the cuts.
 */
export function capLayoutProblems(problems: readonly LayoutProblem[], limit: number): CappedLayoutProblems {
  const kept: LayoutProblem[] = [];
  const totals = new Map<LayoutCheckName, number>();
  for (const problem of problems) {
    const total = (totals.get(problem.check) ?? 0) + 1;
    totals.set(problem.check, total);
    if (total <= limit) {
      kept.push(problem);
    }
  }

  const cuts = [...totals]
    .filter(([, total]) => total > limit)
    .map(([check, total]): LayoutCut => ({ check, total }));
  return { cuts, problems: kept };
}

/**
 * Validates the options a test passed (it may be plain JavaScript or a cast)
 * and fills in the defaults.
 *
 * @param options - The options as passed.
 * @returns The resolved options.
 * @throws Error naming the offending key, and the keys that are allowed.
 */
export function resolveLayoutCheckOptions(options: unknown): ResolvedLayoutCheckOptions {
  if (!isRecord(options)) {
    throw new Error('assertLayout(): pass an object with the root to check, for example assertLayout({ root: \'.modal\' }).');
  }

  rejectUnknownKeys(options, ROOT_KEYS, 'the options');
  const root = readOptionalSelector(options['root'], 'root');
  if (root === null) {
    throw new Error(
      'assertLayout(): root is required, the CSS selector of the part of the window to check, for example assertLayout({ root: \'.modal\' }).'
    );
  }

  return {
    focusRing: resolveFocusRing(options['focusRing']),
    overflow: resolveOverflow(options['overflow']),
    root,
    touchTargets: resolveTouchTargets(options['touchTargets'])
  };
}

function formatValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalSelector(value: unknown, label: string): null | string {
  if (value === undefined) {
    return null;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`assertLayout(): ${label} must be a non-empty CSS selector, got ${formatValue(value)}.`);
  }

  return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`assertLayout(): unknown key(s) in ${label}: ${unknownKeys.join(', ')}. Allowed keys: ${allowedKeys.join(', ')}.`);
  }
}

function resolveFocusRing(value: unknown): ResolvedFocusRingCheck {
  if (value === undefined || typeof value === 'boolean') {
    return {
      ignoreSelector: null,
      isEnabled: value ?? false,
      maximumStopCount: DEFAULT_MAXIMUM_FOCUS_STOP_COUNT,
      shouldStayInside: false,
      startSelector: null
    };
  }

  if (!isRecord(value)) {
    throw new Error(
      'assertLayout(): focusRing must be true, false or an object { ignoreSelector?, maximumStopCount?, shouldStayInside?, startSelector? }, '
        + `got ${formatValue(value)}.`
    );
  }

  rejectUnknownKeys(value, FOCUS_RING_KEYS, 'focusRing');
  const maximumStopCount = value['maximumStopCount'];
  if (
    maximumStopCount !== undefined
    && (typeof maximumStopCount !== 'number' || !Number.isSafeInteger(maximumStopCount) || maximumStopCount < 1
      || maximumStopCount > MAXIMUM_FOCUS_STOP_COUNT)
  ) {
    throw new Error(
      `assertLayout(): focusRing.maximumStopCount must be a whole number from 1 to ${String(MAXIMUM_FOCUS_STOP_COUNT)}, `
        + `got ${formatValue(maximumStopCount)}.`
    );
  }

  const shouldStayInside = value['shouldStayInside'];
  if (shouldStayInside !== undefined && typeof shouldStayInside !== 'boolean') {
    throw new Error(`assertLayout(): focusRing.shouldStayInside must be true or false, got ${formatValue(shouldStayInside)}.`);
  }

  return {
    ignoreSelector: readOptionalSelector(value['ignoreSelector'], 'focusRing.ignoreSelector'),
    isEnabled: true,
    maximumStopCount: maximumStopCount ?? DEFAULT_MAXIMUM_FOCUS_STOP_COUNT,
    shouldStayInside: shouldStayInside ?? false,
    startSelector: readOptionalSelector(value['startSelector'], 'focusRing.startSelector')
  };
}

function resolveOverflow(value: unknown): ResolvedOverflowCheck {
  if (value === undefined || typeof value === 'boolean') {
    return { ignoreSelector: null, isEnabled: value ?? true };
  }

  if (!isRecord(value)) {
    throw new Error(`assertLayout(): overflow must be true, false or an object { ignoreSelector? }, got ${formatValue(value)}.`);
  }

  rejectUnknownKeys(value, OVERFLOW_KEYS, 'overflow');
  return { ignoreSelector: readOptionalSelector(value['ignoreSelector'], 'overflow.ignoreSelector'), isEnabled: true };
}

function resolveTouchTargets(value: unknown): ResolvedTouchTargetCheck {
  if (value === undefined || typeof value === 'boolean') {
    return {
      ignoreSelector: null,
      isEnabled: value ?? null,
      minimumSizeInPixels: DEFAULT_MINIMUM_TOUCH_SIZE_IN_PIXELS,
      selector: DEFAULT_TOUCH_TARGET_SELECTOR
    };
  }

  if (!isRecord(value)) {
    throw new Error(
      'assertLayout(): touchTargets must be true, false or an object { ignoreSelector?, minimumSizeInPixels?, selector? }, '
        + `got ${formatValue(value)}.`
    );
  }

  rejectUnknownKeys(value, TOUCH_TARGET_KEYS, 'touchTargets');
  const minimumSizeInPixels = value['minimumSizeInPixels'];
  if (
    minimumSizeInPixels !== undefined
    && (typeof minimumSizeInPixels !== 'number' || !Number.isFinite(minimumSizeInPixels) || minimumSizeInPixels <= 0)
  ) {
    throw new Error(
      `assertLayout(): touchTargets.minimumSizeInPixels must be a number of CSS pixels above 0, got ${formatValue(minimumSizeInPixels)}.`
    );
  }

  return {
    ignoreSelector: readOptionalSelector(value['ignoreSelector'], 'touchTargets.ignoreSelector'),
    isEnabled: true,
    minimumSizeInPixels: minimumSizeInPixels ?? DEFAULT_MINIMUM_TOUCH_SIZE_IN_PIXELS,
    selector: readOptionalSelector(value['selector'], 'touchTargets.selector') ?? DEFAULT_TOUCH_TARGET_SELECTOR
  };
}
