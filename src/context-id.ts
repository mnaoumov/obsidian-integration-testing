/**
 * @packageDocumentation
 *
 * Typed context identifiers for persisting non-serializable values
 * across {@link evalInObsidian} calls.
 */

import { evalInObsidian } from './obsidian-cli.ts';

/**
 * Wraps a {@link ContextOf} extraction into an object with a `context` property.
 */
export interface ContextArgs<TContextId extends ContextId<unknown> | undefined = undefined> {
  context: ContextOf<TContextId>;
}

/**
 * Extracts the context type from a {@link ContextId}.
 */
export type ContextOf<T> = T extends ContextId<infer Context> ? Context : never;

/**
 * A typed context identifier for persisting non-serializable values
 * across {@link evalInObsidian} calls.
 *
 * The context is a persistent object stored on `window` in the Obsidian process.
 * All calls sharing the same `ContextId` share the same context object,
 * allowing non-serializable values (e.g. `TFile`, `Editor`) to survive across calls.
 *
 * Implements `AsyncDisposable` for use with `await using`.
 */
export class ContextId<_Context> implements AsyncDisposable {
  private readonly id: string;

  /**
   * Creates a new context id.
   */
  public constructor() {
    const SLICE_START = 2;
    this.id = `__ctx_${String(Math.random()).slice(SLICE_START)}`;
  }

  /**
   * Removes this context from the Obsidian process.
   *
   * @param vaultPath - The path to the Obsidian vault. Defaults to `process.cwd()`.
   */
  public async dispose(vaultPath?: string): Promise<void> {
    await evalInObsidian({
      args: { id: this.id },
      /* v8 ignore start -- Serialized via toString() and executed inside the Obsidian process. Covered by integration tests. */
      fn({ id }): void {
        interface ContextHolder {
          __obsidianContexts__: Record<string, unknown>;
        }
        const holder = window as Partial<ContextHolder>;
        if (holder.__obsidianContexts__) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- No other way.
          delete holder.__obsidianContexts__[id];
        }
      },
      /* v8 ignore stop */
      shouldSkipPreflightChecks: true,
      ...(vaultPath === undefined ? {} : { vaultPath })
    });
  }

  /**
   * Disposes this context id.
   *
   * @returns A promise that resolves when the context id is disposed.
   */
  public async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  /**
   * Returns the JSON representation of the context id.
   *
   * @returns The JSON representation of the context id.
   */
  public toJSON(): string {
    return this.id;
  }

  /**
   * Returns the string representation of the context id.
   *
   * @returns The string representation of the context id.
   */
  public toString(): string {
    return this.id;
  }
}
