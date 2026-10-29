/**
 * @file
 *
 * Reads how far an auto-started Appium server has got from its own output, and
 * builds the timeout message from that. Pure and unit-tested; the polling glue
 * lives in the integration-only `transport-factory`.
 *
 * An auto-started server has two phases with very different costs. Until
 * Appium prints its first line, npx is resolving the command. After it, Appium
 * is loading its drivers, and that is where a loaded host spends minutes: a
 * cold load of the uiautomator2 driver reads about 3,400 files, and on
 * 2026-10-29, with the host at 100% CPU, it took 360 s cold against 36 s warm
 * a minute later. The two phases therefore get separate budgets.
 */

/**
 * How far an auto-started Appium server has got.
 *
 * - `launching`: Appium has printed nothing of its own yet, so npx is still
 *   resolving the command.
 * - `loading-driver`: Appium is running and has not started listening yet,
 *   which is the driver load.
 */
export type AppiumStartupPhase = 'launching' | 'loading-driver';

/**
 * Parameters for {@link buildAppiumNotReadyMessage}.
 */
export interface BuildAppiumNotReadyMessageParams {
  /**
   * How long Appium had been running when the budget ran out, measured from its
   * first line. `undefined` while it was still `launching`.
   */
  readonly driverLoadElapsedInMilliseconds: number | undefined;

  /**
   * The driver-load budget.
   */
  readonly driverLoadTimeoutInMilliseconds: number;

  /**
   * The captured tail of the server's output.
   */
  readonly outputTail: string;

  /**
   * The phase the server was in when the budget ran out.
   */
  readonly phase: AppiumStartupPhase;

  /**
   * The launch budget.
   */
  readonly startTimeoutInMilliseconds: number;
}

/**
 * Parameters for {@link resolveAppiumStartupDeadline}.
 */
export interface ResolveAppiumStartupDeadlineParams {
  /**
   * When Appium printed its first line, or `undefined` if it has not.
   */
  readonly appiumOutputSeenAtInMilliseconds: number | undefined;

  /**
   * The driver-load budget, counted from Appium's first line.
   */
  readonly driverLoadTimeoutInMilliseconds: number;

  /**
   * When the server was spawned.
   */
  readonly launchedAtInMilliseconds: number;

  /**
   * The launch budget, counted from the spawn.
   */
  readonly startTimeoutInMilliseconds: number;
}

const NPX_ONLY_SENTENCE = ' Appium never printed a line of its own: npx was still resolving the command when the budget ran out, which is the host\'s load starving npm (an idle host starts the server in under 10s), not Appium failing.';

/**
 * Builds the error message for an auto-started server that never answered
 * `/status`, naming the phase it was stuck in and the option that sets that
 * phase's budget.
 *
 * @param params - The phase, the budgets and the output tail.
 * @returns The message.
 */
export function buildAppiumNotReadyMessage(params: BuildAppiumNotReadyMessageParams): string {
  const outputTail = params.outputTail.trim();
  const outputSection = outputTail.length > 0 ? `\n\nAppium server output (tail):\n${outputTail}` : '';

  if (params.phase === 'launching') {
    const npxSentence = outputTail.length > 0 ? NPX_ONLY_SENTENCE : '';
    return `Auto-started Appium server did not become ready within ${String(params.startTimeoutInMilliseconds)}ms (\`appiumStartTimeoutInMilliseconds\`).${npxSentence}${outputSection}`;
  }

  const elapsed = params.driverLoadElapsedInMilliseconds ?? params.driverLoadTimeoutInMilliseconds;
  return `Auto-started Appium server was still loading its drivers ${String(elapsed)}ms after it printed its first line, past the ${String(params.driverLoadTimeoutInMilliseconds)}ms driver-load budget (\`appiumDriverLoadTimeoutInMilliseconds\`). A cold load of the uiautomator2 driver reads about 3,400 files: on a host at 100% CPU it was measured at 360s, against 36s once the files were cached. So this is the host's load, not Appium failing; a later run finds the files cached, or raise the budget.${outputSection}`;
}

/**
 * Resolves when the readiness wait gives up: the launch budget from the spawn
 * while npx is still resolving the command, then the driver-load budget from
 * Appium's first line.
 *
 * @param params - The two budgets and the two clock starts.
 * @returns The deadline, in epoch milliseconds.
 */
export function resolveAppiumStartupDeadline(params: ResolveAppiumStartupDeadlineParams): number {
  return params.appiumOutputSeenAtInMilliseconds === undefined
    ? params.launchedAtInMilliseconds + params.startTimeoutInMilliseconds
    : params.appiumOutputSeenAtInMilliseconds + params.driverLoadTimeoutInMilliseconds;
}

/**
 * Resolves the phase of an auto-started server from its captured output.
 *
 * Appium's own log lines carry an `[Appium]` tag; npm's notices and npx's
 * messages do not.
 *
 * @param output - The captured output.
 * @returns The phase.
 */
export function resolveAppiumStartupPhase(output: string): AppiumStartupPhase {
  return output.includes('[Appium]') ? 'loading-driver' : 'launching';
}
