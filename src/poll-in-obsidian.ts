/**
 * @file
 *
 * Node-side "kick off, then poll" helper over {@link evalInObsidian}.
 *
 * A single `evalInObsidian` closure cannot run longer than CDP's ~30s
 * `Runtime.evaluate` cap, so a long-running in-Obsidian operation (e.g. a whole
 * plugin/vault bootstrap) cannot be awaited inside one closure. This helper does
 * it from Node instead: it optionally runs a short `start` closure once to kick
 * the work off, then repeatedly runs a short `poll` closure — each a separate,
 * well-under-30s eval — until the Node-side `until` predicate accepts a poll
 * result, or a Node-side timeout elapses. It removes the per-test hand-rolled
 * `evalInObsidian` + `sleep` loop.
 *
 * The timing loop lives in the pure, unit-tested {@link pollUntil}; this module is
 * the integration-only wiring (it drives a live Obsidian), covered by an
 * integration test.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian via evalInObsidian) covered by integration tests, not unit tests. */

import type { Promisable } from 'type-fest';

import { setTimeout as sleep } from 'node:timers/promises';

import type { ContextArgs } from './context-id.ts';
import type {
  CommonArgs,
  EvalInObsidianParams,
  GenericObject
} from './eval-in-obsidian.ts';
import type { ObsidianTransport } from './transport.ts';

import { ContextId } from './context-id.ts';
import { evalInObsidian } from './eval-in-obsidian.ts';
import { pollUntil } from './poll-until.ts';

const DEFAULT_POLL_INTERVAL_IN_MILLISECONDS = 500;
const DEFAULT_POLL_TIMEOUT_IN_MILLISECONDS = 120_000;

/**
 * Parameters for {@link pollInObsidian}. Mirrors {@link EvalInObsidianParams} for
 * the shared forwarded fields (`args` / `contextId` / `transport` / `vaultPath`);
 * `start` / `poll` are the in-Obsidian closures and `until` is the Node-side
 * acceptance predicate.
 */
export interface PollInObsidianParams<Args extends GenericObject, PollResult, TContextId extends ContextId<unknown> | undefined = undefined> {
  /**
   * Additional arguments passed to both `start` and `poll` (serialized like
   * {@link EvalInObsidianParams.args}).
   */
  readonly args?: Args;

  /**
   * A {@link ContextId} shared by `start` and `poll`, so `start` can stash
   * non-serializable state that `poll` later reads. When omitted, each closure
   * gets a fresh empty `context`.
   */
  readonly contextId?: TContextId;

  /**
   * Delay between `poll` attempts, in milliseconds.
   *
   * @default `500`
   */
  readonly intervalInMilliseconds?: number;

  /**
   * The closure polled repeatedly inside Obsidian. Keep it short (well under the
   * ~30s CDP cap): it should read and return a JSON-serializable status, not
   * await the long operation itself.
   */
  poll(this: void, args: Args & CommonArgs & ContextArgs<TContextId>): Promisable<PollResult>;

  /**
   * An optional closure run **once** before polling begins, to kick off the
   * long-running work (fire-and-forget from Node's perspective). Keep it short —
   * start the work and return; do not await it to completion here.
   */
  start?(this: void, args: Args & CommonArgs & ContextArgs<TContextId>): Promisable<unknown>;

  /**
   * Total budget before the poll rejects, in milliseconds.
   *
   * @default `120000`
   */
  readonly timeoutInMilliseconds?: number;

  /**
   * Optional detail appended to the timeout error message.
   */
  readonly timeoutMessage?: string;

  /**
   * Override the transport (forwarded to every underlying `evalInObsidian`).
   */
  readonly transport?: ObsidianTransport;

  /**
   * Whether a given `poll` result is acceptable, evaluated in **Node**. Returning
   * `true` resolves {@link pollInObsidian} with that result.
   */
  until(this: void, result: PollResult): boolean;

  /**
   * The vault path to evaluate against (forwarded to every underlying
   * `evalInObsidian`).
   */
  readonly vaultPath?: string;
}

/**
 * Kicks off an optional `start` closure once, then polls `poll` from Node until
 * `until` accepts a result or the timeout elapses.
 *
 * @param params - The poll parameters.
 * @returns A {@link Promise} that resolves with the first accepted `poll` result.
 */
export async function pollInObsidian<Args extends GenericObject, PollResult, TContextId extends ContextId<unknown> | undefined = undefined>(
  params: PollInObsidianParams<Args, PollResult, TContextId>
): Promise<PollResult> {
  const {
    args,
    contextId,
    intervalInMilliseconds = DEFAULT_POLL_INTERVAL_IN_MILLISECONDS,
    poll,
    start,
    timeoutInMilliseconds = DEFAULT_POLL_TIMEOUT_IN_MILLISECONDS,
    timeoutMessage,
    transport,
    until,
    vaultPath
  } = params;

  async function runEval<Result>(fn: (fnArgs: Args & CommonArgs & ContextArgs<TContextId>) => Promisable<Result>): Promise<Result> {
    const evalParams: EvalInObsidianParams<Args, Result, TContextId> = {
      fn,
      ...(args !== undefined && { args }),
      ...(contextId !== undefined && { contextId }),
      ...(transport !== undefined && { transport }),
      ...(vaultPath !== undefined && { vaultPath })
    };
    return evalInObsidian<Args, Result, TContextId>(evalParams);
  }

  if (start) {
    await runEval(start);
  }

  return pollUntil<PollResult>({
    attempt: async () => runEval(poll),
    intervalInMilliseconds,
    nowInMilliseconds: () => Date.now(),
    sleep: async (milliseconds: number) => {
      await sleep(milliseconds);
    },
    timeoutInMilliseconds,
    until,
    ...(timeoutMessage !== undefined && { timeoutMessage })
  });
}

/* v8 ignore stop */
