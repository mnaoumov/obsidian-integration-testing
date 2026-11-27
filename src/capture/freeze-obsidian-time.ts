/**
 * @file
 *
 * Fixes the clock the page reads, so a frame that shows a date or a time (a
 * daily note, a file's modified time, a "2 minutes ago") is the same every run.
 *
 * Re-implemented from `freezeTime` in `obsidian-plugin-dev-kit`
 * (`src/e2e/demo/create-demo.ts`, at aa82d95, MIT), which used Playwright's
 * `clock.setFixedTime`; no code was copied. This harness has no Playwright, so
 * the window's `Date` is replaced by a `Proxy` over it:
 *
 * - **`new Date()` and `Date.now()` return the fixed moment**, and `Date()`
 *   called as a function returns its string. A `Date` given arguments is built
 *   from them as before.
 * - **`instanceof Date` keeps working for dates made before the freeze**,
 *   because a `Proxy` of a function hands `instanceof` the original
 *   `Date.prototype`. A subclass would not: a date made earlier is no instance
 *   of it.
 * - **`moment` follows** without a patch of its own, since `moment()` reads
 *   `Date.now()` through the global `Date`.
 * - **Timers are untouched**, so `setTimeout` and `requestAnimationFrame` still
 *   run. Like Playwright's fixed time, code that measures elapsed time with
 *   `Date.now()` sees none pass while the clock is frozen.
 *
 * Only the vault's own window is frozen; a popout has its own `Date`.
 */

/* v8 ignore start -- Integration-time code (drives a live Obsidian) covered by integration tests, not unit tests. */

import type { EvalInObsidianParams } from '../eval/eval-in-obsidian.ts';
import type { ObsidianTransport } from '../transport/transport.ts';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { normalizeOptionalProperties } from '../normalize-optional-properties.ts';
import { resolveFrozenTimestamp } from './capture-quality-options.ts';

/**
 * Parameters for {@link freezeObsidianTime}.
 */
export interface FreezeObsidianTimeParams {
  /**
   * The moment to fix the clock at: a `Date`, an ISO date-time string such as
   * `2026-03-14T09:26:00`, or a timestamp in milliseconds.
   */
  readonly date: Date | number | string;

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
 * What {@link freezeObsidianTime} returns.
 */
export interface FrozenObsidianTime {
  /**
   * Puts the window's own `Date` back.
   *
   * @returns A {@link Promise} that resolves once the clock runs again.
   */
  readonly restore: () => Promise<void>;

  /**
   * The fixed moment, in milliseconds since the epoch.
   */
  readonly timestamp: number;
}

type FreezeTimeInput = Record<'timestamp', number>;

// The original `Date`, kept on the window so the restore (a separate
// evaluation) can put it back, and so a second freeze wraps the original rather
// than the first freeze's proxy. Kept local rather than declared globally, so
// it never leaks into consumer types.
interface FrozenTimeHolder {
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- Freezing and restoring the clock replaces and clears this window state.
  __obsidianIntegrationTestingOriginalDate?: DateConstructor | undefined;
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- Freezing and restoring the clock replaces this window state.
  Date: DateConstructor;
}

/**
 * Fixes the window's clock at one moment until the returned restore runs.
 *
 * A second freeze moves the clock to its own moment; one restore then puts the
 * real clock back.
 *
 * @param params - The moment, and transport and vault overrides.
 * @returns A {@link Promise} that resolves to the {@link FrozenObsidianTime}.
 * @throws Error if the moment is not a valid date.
 */
export async function freezeObsidianTime(params: FreezeObsidianTimeParams): Promise<FrozenObsidianTime> {
  const { date, transport, vaultPath } = params;
  const timestamp = resolveFrozenTimestamp(date);

  await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<FreezeTimeInput, void>>({
    callback({ timestamp: frozenTimestamp }): void {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the original-Date record is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
      const holder = globalThis as unknown as FrozenTimeHolder;
      const OriginalDate = holder.__obsidianIntegrationTestingOriginalDate ?? holder.Date;
      holder.__obsidianIntegrationTestingOriginalDate = OriginalDate;
      function now(): number {
        return frozenTimestamp;
      }
      holder.Date = new Proxy(OriginalDate, {
        apply(): string {
          return new OriginalDate(frozenTimestamp).toString();
        },
        construct(target, constructorArguments: unknown[], newTarget: DateConstructor): object {
          // A `Date` given arguments is built from them as before; the single
          // overload TypeScript resolves here does not describe the variadic one.
          const effectiveArguments = (constructorArguments.length === 0 ? [frozenTimestamp] : constructorArguments) as [number];
          return Reflect.construct(target, effectiveArguments, newTarget);
        },
        get(target, property, receiver): unknown {
          if (property === 'now') {
            return now;
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return value;
        }
      });
    },
    input: { timestamp },
    transport,
    vaultPath
  }));

  return {
    async restore(): Promise<void> {
      await evalInObsidian(normalizeOptionalProperties<EvalInObsidianParams<Record<string, never>, void>>({
        callback(): void {
          // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the original-Date record is our internal Window augmentation, intentionally kept local (not declared globally) to avoid leaking into consumer types.
          const holder = globalThis as unknown as FrozenTimeHolder;
          const originalDate = holder.__obsidianIntegrationTestingOriginalDate;
          if (!originalDate) {
            return;
          }
          holder.Date = originalDate;
          holder.__obsidianIntegrationTestingOriginalDate = undefined;
        },
        transport,
        vaultPath
      }));
    },
    timestamp
  };
}

/* v8 ignore stop */
