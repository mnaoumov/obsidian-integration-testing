/**
 * @file
 *
 * The desktop mobile-layout mode: `enableMobileLayout` pins the window to a
 * phone-sized viewport and turns Obsidian's own mobile emulation on, so a
 * suite can check a plugin's mobile layout in seconds, on the desktop
 * instance it already has, without an emulator.
 *
 * Obsidian's `app.emulateMobile(on)` stores `EmulateMobile` in local storage
 * and reloads the window, and the next load sets `Platform.isMobile`, adds
 * `is-mobile` (and `is-phone` or `is-tablet` from the viewport) to the body and
 * builds the mobile chrome. The call that triggers the reload cannot answer,
 * so it is made from a timer, and the wait polls from Node until the new page
 * is laid out.
 *
 * It does not replace the Android transport: the Electron app keeps its Node
 * built-ins, `Platform.isDesktopApp` and `Platform.isMobileApp` keep their
 * desktop values, and the trusted-input helpers keep going through Electron.
 * Code that runs only on a phone, or depends on what a phone's WebView lacks,
 * still needs a real device.
 *
 * Re-implemented from the idea in `src/e2e/helpers/mobile.ts`,
 * `device-metrics.ts` and `create-helpers.ts` of
 * [`obsidian-plugin-dev-kit`](https://github.com/Dimagious/obsidian-plugin-dev-kit)
 * at aa82d95 (v0.4.0, MIT). No code was copied.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian) covered by integration tests, not unit tests. */

import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ObsidianTransport } from '../transport/transport.ts';
import type {
  MobileLayoutPageState,
  MobileLayoutViewport,
  MobileLayoutViewportOptions
} from './mobile-layout-options.ts';

import { normalizeOptionalProperties } from '../normalize-optional-properties.ts';
import {
  getTransportOptions,
  getVaultPath
} from '../transport/context-provider.ts';
import { getOrCreateTransport } from '../transport/transport-factory.ts';
import {
  buildMobileLayoutProbeExpression,
  buildMobileLayoutSwitchExpression,
  checkIsSameMobileLayoutViewport,
  DEFAULT_MOBILE_LAYOUT_TIMEOUT_IN_MILLISECONDS,
  MOBILE_LAYOUT_POLL_INTERVAL_IN_MILLISECONDS,
  parseMobileLayoutPageState,
  resolveMobileLayoutViewport,
  waitForMobileLayoutState
} from './mobile-layout-options.ts';

/**
 * Options of {@link disableMobileLayout}.
 */
export interface DisableMobileLayoutOptions {
  /**
   * The budget for the switch, reload included.
   *
   * @default `60000`
   */
  readonly timeoutInMilliseconds?: number;

  /**
   * Override the transport. When omitted, the transport the current test
   * context is driving is used.
   */
  readonly transport?: ObsidianTransport;

  /**
   * The vault whose window to switch. When omitted, the current test context's
   * vault is used.
   */
  readonly vaultPath?: string;
}

/**
 * Options of {@link enableMobileLayout}.
 */
export interface EnableMobileLayoutOptions extends DisableMobileLayoutOptions, MobileLayoutViewportOptions {}

/**
 * Options of {@link withMobileLayout}.
 */
export interface WithMobileLayoutParams<Result> extends EnableMobileLayoutOptions {
  /**
   * Runs with the mobile layout on, on the Node side.
   *
   * @returns The callback's result.
   */
  readonly callback: (this: void) => Promise<Result>;
}

interface ResolvedTarget {
  readonly cwd: string;
  readonly setViewportOverride: NonNullable<ObsidianTransport['setViewportOverride']>;
  readonly transport: ObsidianTransport;
}

interface TransportTarget {
  readonly transport?: ObsidianTransport;
  readonly vaultPath?: string;
}

/**
 * How long one page read may take before it counts as no answer.
 */
const PROBE_TIMEOUT_IN_MILLISECONDS = 5000;

/**
 * The viewport each window was last loaded at by {@link enableMobileLayout}.
 * Obsidian picks the phone or the tablet layout when it loads, so a window
 * already in the mobile layout is reloaded when its viewport changes.
 */
const loadedViewports = new WeakMap<ObsidianTransport, Map<string, MobileLayoutViewport>>();

interface SwitchEmulationParams {
  readonly isOn: boolean;
  readonly target: ResolvedTarget;
  readonly timeoutInMilliseconds: number;
  readonly widthInPixels: null | number;
}

/**
 * Turns the mobile layout off again: clears the viewport override, then turns
 * Obsidian's mobile emulation off, which reloads the window at its own size.
 * A window that is not in the mobile layout is only un-pinned.
 *
 * @param options - The budget and the target.
 * @returns A {@link Promise} that resolves once the desktop layout is back.
 * @throws {@link MobileLayoutTimeoutError} when the window does not reload into the desktop layout in time.
 */
export async function disableMobileLayout(options: DisableMobileLayoutOptions = {}): Promise<void> {
  const target = await resolveTarget(options);
  const timeoutInMilliseconds = options.timeoutInMilliseconds ?? DEFAULT_MOBILE_LAYOUT_TIMEOUT_IN_MILLISECONDS;
  // The override goes first: the desktop layout is laid out at load, so it should load at the window's own size.
  await target.setViewportOverride({ cwd: target.cwd, viewport: null });
  loadedViewports.get(target.transport)?.delete(target.cwd);
  const state = await readState(target);
  if (state !== null && !state.isMobileLayout && !state.isMobileEmulationStored) {
    return;
  }
  await switchEmulation({ isOn: false, target, timeoutInMilliseconds, widthInPixels: null });
}

/**
 * Turns the mobile layout on: pins the window to a phone-sized viewport (390
 * by 844 CSS pixels at twice the pixel density unless told otherwise), then
 * turns Obsidian's mobile emulation on, which reloads the window, and waits
 * until the reloaded page is laid out in the mobile layout at that width.
 *
 * The viewport is set before the reload because Obsidian picks the phone or
 * the tablet layout when it loads. A window already in the mobile layout at the
 * same viewport is not reloaded again.
 *
 * The emulation flag is kept in the profile's local storage, so it applies to
 * every vault window of that Obsidian on its next load. Turn it off with
 * {@link disableMobileLayout}, or use {@link withMobileLayout}, which does.
 *
 * @param options - The viewport, the budget and the target.
 * @returns A {@link Promise} that resolves once the mobile layout is in place.
 * @throws Error when the transport cannot pin a viewport (Android), or the page has no `app.emulateMobile`.
 * @throws {@link MobileLayoutTimeoutError} when the window does not reload into the mobile layout in time.
 */
export async function enableMobileLayout(options: EnableMobileLayoutOptions = {}): Promise<void> {
  const viewport = resolveMobileLayoutViewport(options);
  const target = await resolveTarget(options);
  const timeoutInMilliseconds = options.timeoutInMilliseconds ?? DEFAULT_MOBILE_LAYOUT_TIMEOUT_IN_MILLISECONDS;
  await target.setViewportOverride({ cwd: target.cwd, viewport });
  const state = await waitForMobileLayoutState({
    intervalInMilliseconds: MOBILE_LAYOUT_POLL_INTERVAL_IN_MILLISECONDS,
    isOn: null,
    nowInMilliseconds: Date.now,
    readState: async () => readState(target),
    sleep: async (milliseconds) => sleep(milliseconds),
    timeoutInMilliseconds,
    widthInPixels: viewport.widthInPixels
  });
  let viewports = loadedViewports.get(target.transport);
  if (!viewports) {
    viewports = new Map();
    loadedViewports.set(target.transport, viewports);
  }
  const loadedViewport = viewports.get(target.cwd);
  if (!state.isMobileLayout || !loadedViewport || !checkIsSameMobileLayoutViewport(loadedViewport, viewport)) {
    await switchEmulation({ isOn: true, target, timeoutInMilliseconds, widthInPixels: viewport.widthInPixels });
  }
  viewports.set(target.cwd, viewport);
}

/**
 * Runs a callback with the mobile layout on, and turns it off afterwards,
 * whether the callback returned or threw.
 *
 * @param params - The viewport, the budget, the target and the callback.
 * @returns The callback's result.
 */
export async function withMobileLayout<Result>(params: WithMobileLayoutParams<Result>): Promise<Result> {
  const { callback, ...enableOptions } = params;
  await enableMobileLayout(enableOptions);
  try {
    return await callback();
  } finally {
    await disableMobileLayout(normalizeOptionalProperties<DisableMobileLayoutOptions>({
      timeoutInMilliseconds: enableOptions.timeoutInMilliseconds,
      transport: enableOptions.transport,
      vaultPath: enableOptions.vaultPath
    }));
  }
}

async function readState(target: ResolvedTarget): Promise<MobileLayoutPageState | null> {
  const controller = new AbortController();
  try {
    const json = await Promise.race([
      target.transport.evaluate(buildMobileLayoutProbeExpression(), { cwd: target.cwd }),
      sleep(PROBE_TIMEOUT_IN_MILLISECONDS, '', { signal: controller.signal })
    ]);
    return parseMobileLayoutPageState(json);
  } catch {
    // The page is mid-reload: the old context is gone and the new one cannot answer yet.
    return null;
  } finally {
    controller.abort();
  }
}

async function resolveTarget(options: TransportTarget): Promise<ResolvedTarget> {
  const cwd = options.vaultPath ?? getVaultPath() ?? process.cwd();
  const transport = options.transport ?? await getOrCreateTransport(getTransportOptions());
  if (!transport.setViewportOverride) {
    throw new Error(
      'The mobile layout mode needs a transport that can pin the viewport, which only the desktop CDP transport can. '
        + 'On Android, Obsidian already runs its mobile layout.'
    );
  }
  return { cwd, setViewportOverride: transport.setViewportOverride.bind(transport), transport };
}

async function switchEmulation(params: SwitchEmulationParams): Promise<void> {
  const { isOn, target, timeoutInMilliseconds, widthInPixels } = params;
  const outcome = await target.transport.evaluate(buildMobileLayoutSwitchExpression(isOn), { cwd: target.cwd });
  if (outcome !== 'scheduled') {
    throw new Error(`The page has no app.emulateMobile to switch the mobile layout ${isOn ? 'on' : 'off'} with (got ${outcome}).`);
  }
  await waitForMobileLayoutState({
    intervalInMilliseconds: MOBILE_LAYOUT_POLL_INTERVAL_IN_MILLISECONDS,
    isOn,
    nowInMilliseconds: Date.now,
    readState: async () => readState(target),
    sleep: async (milliseconds) => sleep(milliseconds),
    timeoutInMilliseconds,
    widthInPixels
  });
}

/* v8 ignore stop */
