/**
 * @file
 *
 * Pure helpers for tracking how far Obsidian Mobile has got through its startup
 * after `location.reload()`, and for describing where it stalled when a budget
 * runs out.
 *
 * Startup is watched as a **ladder of milestones**, not a single boolean,
 * because the two halves of it cost wildly different amounts of time and only
 * one of them is Obsidian's fault. Reaching `globalThis.app` is the app cold
 * start — the WebView reloading, the guest still churning — and on a cold or
 * contended emulator it can take minutes. Everything after it is Obsidian
 * opening the vault and loading plugins, which **L19** measured at ~1s (≤8.4s
 * under 12-core + disk + memory stress). Charging both to one 90s wall clock is
 * what made a first run after a machine restart fail by design, so the transport
 * runs them as two budgets and uses these helpers to tell them apart.
 *
 * Kept separate from the integration-only `transport-appium` (excluded from unit
 * tests) so the classification and message formatting stay unit-testable — the
 * polling itself needs a real device.
 */

/**
 * How far Obsidian has got through its startup, as seen from one WebView probe.
 *
 * Ordered from least to most advanced; {@link compareAppStartupMilestones}
 * relies on that order.
 */
export type AppStartupMilestone =
  | 'layout-ready'
  | 'no-app'
  | 'no-webview'
  | 'no-workspace'
  | 'workspace-not-ready';

/**
 * Which of the two startup budgets was being spent when it ran out.
 */
export type AppStartupPhase = 'app-start' | 'layout-ready';

/**
 * Parameters for {@link buildStartupTimeoutMessage}.
 */
export interface BuildStartupTimeoutMessageParams {
  /**
  How long this phase's budget had been spent when it ran out.
   */
  readonly elapsedInMilliseconds: number;

  /**
  The furthest milestone reached before the budget ran out.
   */
  readonly milestone: AppStartupMilestone;

  /**
  The phase whose budget ran out.
   */
  readonly phase: AppStartupPhase;

  /**
  How many probes were made during the phase.
   */
  readonly pollCount: number;

  /**
  The slowest single probe round-trip observed during the phase.
   */
  readonly slowestRoundTripInMilliseconds: number;

  /**
  The budget that ran out.
   */
  readonly timeoutInMilliseconds: number;
}

/**
 * The raw shape a WebView startup probe reports back.
 *
 * Mirrors what the injected probe function can observe without importing
 * anything: whether the global `app` object exists yet, whether its `workspace`
 * does, and whether that workspace has finished laying out.
 */
export interface StartupProbeResult {
  /**
  Whether `globalThis.app` is defined.
   */
  readonly hasApp: boolean;

  /**
  Whether `app.workspace` is defined.
   */
  readonly hasWorkspace: boolean;

  /**
  Whether `app.workspace.layoutReady` is truthy.
   */
  readonly isLayoutReady: boolean;
}

/**
 * The milestone ladder, least to most advanced. The index in this array *is*
 * the ordering used by {@link compareAppStartupMilestones}.
 */
const MILESTONE_ORDER: readonly AppStartupMilestone[] = [
  'no-webview',
  'no-app',
  'no-workspace',
  'workspace-not-ready',
  'layout-ready'
];

/**
 * The milestone at which the app-start phase is satisfied: `globalThis.app`
 * exists, so the WebView has reloaded and Obsidian's own boot has begun. What
 * remains from here is Obsidian work, which the tight layout-ready budget
 * covers.
 */
const APP_STARTED_MILESTONE: AppStartupMilestone = 'no-workspace';

/**
 * Human-readable descriptions of each milestone, used in the timeout message so
 * the failure names what never happened instead of only what was hoped for.
 */
const MILESTONE_DESCRIPTIONS: Record<AppStartupMilestone, string> = {
  'layout-ready': 'the workspace finished laying out',
  'no-app': 'the WebView answered, but `globalThis.app` never appeared',
  'no-webview': 'the WebView never answered a single probe',
  'no-workspace': '`globalThis.app` appeared, but `app.workspace` never did',
  'workspace-not-ready': '`app.workspace` exists, but `layoutReady` never became true'
};

/**
 * What each phase was waiting for, used in the timeout message.
 */
const PHASE_DESCRIPTIONS: Record<AppStartupPhase, string> = {
  'app-start': 'Obsidian Mobile did not finish starting',
  'layout-ready': 'Obsidian layout did not become ready'
};

/**
 * Builds the diagnostic message for a startup budget that ran out.
 *
 * It names the milestone actually reached, the poll count and the slowest probe
 * round-trip, because those three together separate the failure modes **L19**
 * could not tell apart from the old message: a genuine Obsidian slowdown shows
 * many fast polls stalled at one milestone, whereas a contended guest shows a
 * handful of polls each taking tens of seconds.
 *
 * @param params - The phase, the milestone reached, and the timing evidence.
 * @returns A human-readable error message.
 */
export function buildStartupTimeoutMessage(params: BuildStartupTimeoutMessageParams): string {
  const {
    elapsedInMilliseconds,
    milestone,
    phase,
    pollCount,
    slowestRoundTripInMilliseconds,
    timeoutInMilliseconds
  } = params;

  return `${PHASE_DESCRIPTIONS[phase]} within ${String(timeoutInMilliseconds)}ms `
    + `(elapsed ${String(elapsedInMilliseconds)}ms). Furthest progress: ${MILESTONE_DESCRIPTIONS[milestone]}. `
    + `Probed ${String(pollCount)} time(s), slowest round-trip ${String(slowestRoundTripInMilliseconds)}ms. `
    + 'A handful of probes each taking tens of seconds means a contended guest, not a slow Obsidian — '
    + 'let the emulator go idle before the run, or raise `deviceIdleTimeoutInMilliseconds`.';
}

/**
 * Reports whether the app-start phase is satisfied at this milestone.
 *
 * @param milestone - The milestone the latest probe reported.
 * @returns `true` once `globalThis.app` exists, so the layout-ready budget may start.
 */
export function checkAppStarted(milestone: AppStartupMilestone): boolean {
  return compareAppStartupMilestones(milestone, APP_STARTED_MILESTONE) >= 0;
}

/**
 * Reports whether the layout-ready phase is satisfied at this milestone.
 *
 * @param milestone - The milestone the latest probe reported.
 * @returns `true` once the workspace has finished laying out.
 */
export function checkLayoutReady(milestone: AppStartupMilestone): boolean {
  return milestone === 'layout-ready';
}

/**
 * Turns a WebView probe into a milestone.
 *
 * A probe that could not run at all — `undefined`, because `browser.execute()`
 * threw while the page was mid-reload — is the least advanced milestone rather
 * than an error: during a reload it is the expected reading.
 *
 * @param probeResult - What the probe reported, or `undefined` when it threw.
 * @returns The milestone that reading represents.
 */
export function classifyAppStartupProbe(probeResult: StartupProbeResult | undefined): AppStartupMilestone {
  if (!probeResult) {
    return 'no-webview';
  }
  if (!probeResult.hasApp) {
    return 'no-app';
  }
  if (!probeResult.hasWorkspace) {
    return 'no-workspace';
  }
  return probeResult.isLayoutReady ? 'layout-ready' : 'workspace-not-ready';
}

/**
 * Orders two milestones on the startup ladder.
 *
 * @param left - The first milestone.
 * @param right - The second milestone.
 * @returns A negative number when `left` is less advanced, `0` when equal, a positive number when more advanced.
 */
export function compareAppStartupMilestones(left: AppStartupMilestone, right: AppStartupMilestone): number {
  return MILESTONE_ORDER.indexOf(left) - MILESTONE_ORDER.indexOf(right);
}
