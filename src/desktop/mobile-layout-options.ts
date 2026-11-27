/**
 * @file
 *
 * Pure half of the desktop mobile-layout mode (`enableMobileLayout`): the
 * phone-sized viewport and its validation, the CDP override payload, the page
 * scripts that switch Obsidian's mobile emulation and read where the page is,
 * and the Node-side wait for the reload that the switch triggers.
 *
 * Re-implemented from the idea in `src/e2e/helpers/mobile.ts` and
 * `device-metrics.ts` of
 * [`obsidian-plugin-dev-kit`](https://github.com/Dimagious/obsidian-plugin-dev-kit)
 * at aa82d95 (v0.4.0, MIT): a 390x844 viewport at twice the pixel density,
 * pinned with CDP before `app.emulateMobile(true)` reloads the window. No code
 * was copied.
 */

/**
 * What the page reports about the mobile layout, read by
 * {@link buildMobileLayoutProbeExpression}.
 */
export interface MobileLayoutPageState {
  /**
   * Whether `app.workspace.layoutReady` is `true`.
   */
  readonly isLayoutReady: boolean;

  /**
   * Whether Obsidian's `EmulateMobile` local storage key is set.
   */
  readonly isMobileEmulationStored: boolean;

  /**
   * Whether the body carries `is-mobile`.
   */
  readonly isMobileLayout: boolean;

  /**
   * Whether the reload marker set before the switch is still on the page, which
   * means the page has not reloaded yet.
   */
  readonly isReloadPending: boolean;

  /**
   * `window.innerWidth`.
   */
  readonly widthInPixels: number;
}

/**
 * The viewport a mobile layout is drawn at.
 */
export interface MobileLayoutViewport {
  /**
   * The device pixel ratio.
   */
  readonly deviceScaleFactor: number;

  /**
   * The viewport height, in CSS pixels.
   */
  readonly heightInPixels: number;

  /**
   * The viewport width, in CSS pixels.
   */
  readonly widthInPixels: number;
}

/**
 * The size half of the `enableMobileLayout` options.
 */
export interface MobileLayoutViewportOptions {
  /**
   * The device pixel ratio. A capture with no size of its own is this many
   * times the viewport in each dimension.
   *
   * @default `2`
   */
  readonly deviceScaleFactor?: number;

  /**
   * The viewport height, in CSS pixels.
   *
   * @default `844`
   */
  readonly heightInPixels?: number;

  /**
   * The viewport width, in CSS pixels. Obsidian draws its phone layout below
   * 600 pixels and its tablet layout from 600 pixels up, in both dimensions.
   *
   * @default `390`
   */
  readonly widthInPixels?: number;
}

/**
 * Options of {@link resolveMobileLayoutViewport}: the viewport options themselves.
 */
export type ResolveMobileLayoutViewportOptions = MobileLayoutViewportOptions;

/**
 * Parameters of {@link waitForMobileLayoutState}.
 */
export interface WaitForMobileLayoutStateParams {
  /**
   * How long to wait between reads.
   */
  readonly intervalInMilliseconds: number;

  /**
   * Whether the mobile layout is being turned on, or `null` to wait for the
   * width and the readiness only.
   */
  readonly isOn: boolean | null;

  /**
   * The clock.
   */
  readonly nowInMilliseconds: (this: void) => number;

  /**
   * Reads the page once. Resolves `null` when the page cannot answer (mid-reload),
   * and rejects only for a failure that waiting cannot fix.
   */
  readonly readState: (this: void) => Promise<MobileLayoutPageState | null>;

  /**
   * Sleeps for the given number of milliseconds.
   */
  readonly sleep: (this: void, milliseconds: number) => Promise<void>;

  /**
   * The budget for the whole wait.
   */
  readonly timeoutInMilliseconds: number;

  /**
   * The viewport width to wait for, or `null` to not check it.
   */
  readonly widthInPixels: null | number;
}

const DEFAULT_DEVICE_SCALE_FACTOR = 2;
const DEFAULT_HEIGHT_IN_PIXELS = 844;
const DEFAULT_WIDTH_IN_PIXELS = 390;

/**
 * The viewport a mobile layout uses when none is given: an iPhone 14 at
 * twice the pixel density.
 */
export const DEFAULT_MOBILE_LAYOUT_VIEWPORT: MobileLayoutViewport = {
  deviceScaleFactor: DEFAULT_DEVICE_SCALE_FACTOR,
  heightInPixels: DEFAULT_HEIGHT_IN_PIXELS,
  widthInPixels: DEFAULT_WIDTH_IN_PIXELS
};

/**
 * The default budget for one switch of the mobile layout, reload included.
 */
export const DEFAULT_MOBILE_LAYOUT_TIMEOUT_IN_MILLISECONDS = 60_000;

/**
 * How often the wait reads the page.
 */
export const MOBILE_LAYOUT_POLL_INTERVAL_IN_MILLISECONDS = 100;

/**
 * The `window` property set before the switch, which the reload clears.
 */
export const MOBILE_LAYOUT_RELOAD_MARKER = '__obsidianIntegrationTestingMobileLayoutReloadMarker';

/**
 * How long the switch script waits before it calls `app.emulateMobile`, so the
 * evaluation that scheduled it can answer before the page goes away.
 */
const SWITCH_DELAY_IN_MILLISECONDS = 50;

/**
 * Parameters of {@link buildMobileLayoutTimeoutMessage}: the error's own.
 */
export type BuildMobileLayoutTimeoutMessageParams = MobileLayoutTimeoutErrorConstructorParams;

/**
 * Parameters of {@link describeMobileLayoutPending}.
 */
export interface DescribeMobileLayoutPendingParams {
  /**
   * Whether the mobile layout is being turned on, or `null` to not check the
   * layout (only the width and the readiness).
   */
  readonly isOn: boolean | null;

  /**
   * The page state, or `null` when the page did not answer.
   */
  readonly state: MobileLayoutPageState | null;

  /**
   * The viewport width to expect, or `null` to not check it.
   */
  readonly widthInPixels: null | number;
}

/**
 * Parameters of the {@link MobileLayoutTimeoutError} constructor.
 */
export interface MobileLayoutTimeoutErrorConstructorParams {
  /**
   * Whether the mobile layout was being turned on, or `null` when only the
   * viewport width was awaited.
   */
  readonly isOn: boolean | null;

  /**
   * What was still missing when the budget ran out.
   */
  readonly reasons: readonly string[];

  /**
   * The budget the wait ran under.
   */
  readonly timeoutInMilliseconds: number;
}

/**
 * Thrown when the page does not reach the asked-for layout within the budget.
 */
export class MobileLayoutTimeoutError extends Error {
  /**
   * Whether the mobile layout was being turned on, or `null` when only the
   * viewport width was awaited.
   */
  public readonly isOn: boolean | null;

  /**
   * What was still missing when the budget ran out.
   */
  public readonly reasons: readonly string[];

  /**
   * The budget the wait ran under.
   */
  public readonly timeoutInMilliseconds: number;

  /**
   * Creates the error.
   *
   * @param params - What the wait asked for and what it found.
   */
  public constructor(params: MobileLayoutTimeoutErrorConstructorParams) {
    super(buildMobileLayoutTimeoutMessage(params));
    this.name = 'MobileLayoutTimeoutError';
    this.isOn = params.isOn;
    this.reasons = params.reasons;
    this.timeoutInMilliseconds = params.timeoutInMilliseconds;
  }
}

/**
 * Builds the `Emulation.setDeviceMetricsOverride` payload for a viewport.
 *
 * `mobile` stays `false`: Chromium's own mobile mode adds touch emulation and a
 * meta-viewport pass that Obsidian does not expect. The override only makes the
 * viewport phone-sized; `app.emulateMobile(true)` does the rest.
 *
 * @param viewport - The viewport.
 * @returns The CDP payload.
 */
export function buildMobileLayoutOverridePayload(viewport: MobileLayoutViewport): Record<string, unknown> {
  return {
    deviceScaleFactor: viewport.deviceScaleFactor,
    height: viewport.heightInPixels,
    mobile: false,
    width: viewport.widthInPixels
  };
}

/**
 * Builds the expression that reads {@link MobileLayoutPageState} as JSON. It
 * never throws: a page without `app` yet reads as not laid out.
 *
 * @returns The expression.
 */
export function buildMobileLayoutProbeExpression(): string {
  return `(function() {
  var app = window.app;
  var body = window.document.body;
  var isStored = false;
  try { isStored = !!window.localStorage.getItem('EmulateMobile'); } catch (e) { isStored = false; }
  return JSON.stringify({
    isLayoutReady: !!(app && app.workspace && app.workspace.layoutReady === true),
    isMobileEmulationStored: isStored,
    isMobileLayout: !!(body && body.classList.contains('is-mobile')),
    isReloadPending: window[${JSON.stringify(MOBILE_LAYOUT_RELOAD_MARKER)}] === true,
    widthInPixels: window.innerWidth
  });
})()`;
}

/**
 * Builds the expression that marks the page and then, from a timer, switches
 * Obsidian's mobile emulation, which reloads the window. The timer lets the
 * evaluation answer before the page goes away.
 *
 * @param isOn - Whether to turn the emulation on.
 * @returns The expression; it evaluates to `'scheduled'`, or `'missing'` when
 *   the page has no `app.emulateMobile`.
 */
export function buildMobileLayoutSwitchExpression(isOn: boolean): string {
  return `(function() {
  var app = window.app;
  if (!app || typeof app.emulateMobile !== 'function') { return 'missing'; }
  window[${JSON.stringify(MOBILE_LAYOUT_RELOAD_MARKER)}] = true;
  window.setTimeout(function() { app.emulateMobile(${String(isOn)}); }, ${String(SWITCH_DELAY_IN_MILLISECONDS)});
  return 'scheduled';
})()`;
}

/**
 * Builds the message of a {@link MobileLayoutTimeoutError}.
 *
 * @param params - What the wait asked for and what it found.
 * @returns The message.
 */
export function buildMobileLayoutTimeoutMessage(params: BuildMobileLayoutTimeoutMessageParams): string {
  const action = params.isOn === null ? 'resized' : (params.isOn ? 'turned on' : 'turned off');
  return `The mobile layout was not ${action} within ${String(params.timeoutInMilliseconds)} ms: ${params.reasons.join('; ')}.`;
}

/**
 * Checks whether two viewports are the same.
 *
 * @param left - One viewport.
 * @param right - The other.
 * @returns Whether every field is equal.
 */
export function checkIsSameMobileLayoutViewport(left: MobileLayoutViewport, right: MobileLayoutViewport): boolean {
  return left.deviceScaleFactor === right.deviceScaleFactor && left.heightInPixels === right.heightInPixels
    && left.widthInPixels === right.widthInPixels;
}

/**
 * Says what keeps the page from the asked-for layout. Empty means it is there.
 *
 * @param params - The state, the direction and the width to expect.
 * @returns The reasons.
 */
export function describeMobileLayoutPending(params: DescribeMobileLayoutPendingParams): string[] {
  const { isOn, state, widthInPixels } = params;
  if (state === null) {
    return ['the page did not answer (it is still reloading)'];
  }
  const layoutReason = isOn ? 'the body lacks is-mobile' : 'the body still has is-mobile';
  const checks: readonly (false | string)[] = [
    state.isReloadPending && 'the page has not reloaded since the emulation was switched',
    !state.isLayoutReady && 'the workspace layout is not ready',
    isOn !== null && state.isMobileLayout !== isOn && layoutReason,
    widthInPixels !== null && state.widthInPixels !== widthInPixels
    && `the viewport is ${String(state.widthInPixels)} pixels wide, not ${String(widthInPixels)}`
  ];
  return checks.filter((reason) => reason !== false);
}

/**
 * Parses the JSON {@link buildMobileLayoutProbeExpression} returns.
 *
 * @param json - The evaluation result.
 * @returns The state, or `null` when the text is not a state.
 */
export function parseMobileLayoutPageState(json: string): MobileLayoutPageState | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { isLayoutReady, isMobileEmulationStored, isMobileLayout, isReloadPending, widthInPixels } = record;
  const isState = typeof isLayoutReady === 'boolean' && typeof isMobileEmulationStored === 'boolean'
    && typeof isMobileLayout === 'boolean' && typeof isReloadPending === 'boolean' && typeof widthInPixels === 'number';
  return isState ? { isLayoutReady, isMobileEmulationStored, isMobileLayout, isReloadPending, widthInPixels } : null;
}

/**
 * Resolves and validates the viewport of a mobile layout.
 *
 * @param options - The viewport options.
 * @returns The viewport.
 * @throws Error when a value is not a positive finite number, or a size is not
 *   a whole number.
 */
export function resolveMobileLayoutViewport(options: ResolveMobileLayoutViewportOptions = {}): MobileLayoutViewport {
  const viewport: MobileLayoutViewport = {
    deviceScaleFactor: options.deviceScaleFactor ?? DEFAULT_MOBILE_LAYOUT_VIEWPORT.deviceScaleFactor,
    heightInPixels: options.heightInPixels ?? DEFAULT_MOBILE_LAYOUT_VIEWPORT.heightInPixels,
    widthInPixels: options.widthInPixels ?? DEFAULT_MOBILE_LAYOUT_VIEWPORT.widthInPixels
  };
  for (const name of ['deviceScaleFactor', 'heightInPixels', 'widthInPixels'] as const) {
    const value = viewport[name];
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`enableMobileLayout: ${name} must be a positive number, got ${String(value)}.`);
    }
  }
  for (const name of ['heightInPixels', 'widthInPixels'] as const) {
    if (!Number.isSafeInteger(viewport[name])) {
      throw new TypeError(`enableMobileLayout: ${name} must be a whole number of CSS pixels, got ${String(viewport[name])}.`);
    }
  }
  return viewport;
}

/**
 * Reads the page until it reaches the asked-for layout, or throws a
 * {@link MobileLayoutTimeoutError} naming what was missing.
 *
 * @param params - The reader, the target, the budget and the clock.
 * @returns The state that met the target.
 */
export async function waitForMobileLayoutState(params: WaitForMobileLayoutStateParams): Promise<MobileLayoutPageState> {
  const { intervalInMilliseconds, isOn, nowInMilliseconds, readState, sleep, timeoutInMilliseconds, widthInPixels } = params;
  const deadline = nowInMilliseconds() + timeoutInMilliseconds;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- The loop exits through return or throw.
  while (true) {
    const state = await readState();
    const reasons = describeMobileLayoutPending({ isOn, state, widthInPixels });
    if (state !== null && reasons.length === 0) {
      return state;
    }
    if (nowInMilliseconds() >= deadline) {
      throw new MobileLayoutTimeoutError({ isOn, reasons, timeoutInMilliseconds });
    }
    await sleep(intervalInMilliseconds);
  }
}
