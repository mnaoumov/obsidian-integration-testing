/**
 * @file
 *
 * Behavioral check that the parent-liveness watchdog (**L33**) is actually
 * armed inside a harness-owned instance's renderer.
 *
 * The watchdog's real trigger — the harness process dying without running
 * teardown — cannot be exercised from inside a test that the harness process is
 * itself running. What a test CAN assert is the precondition that makes the
 * trigger work: a live socket from the renderer back to this process. If the
 * socket is open, the kernel closing it on our death is not in doubt; that part
 * is the operating system's job, not ours.
 *
 * So this suite verifies the half that can silently rot — the renderer having
 * Node access, `require('node:net')` resolving, the connection surviving past
 * arming, and re-arming staying idempotent.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { buildParentLivenessWatchdogExpression } from './parent-liveness.ts';
import { TemporaryVault } from './temporary-vault.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;

const temporaryVault = new TemporaryVault();
let vaultPath: string;

beforeAll(async () => {
  await temporaryVault.register();
  vaultPath = temporaryVault.path;
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await temporaryVault.dispose();
});

/**
 * The renderer `window` property the watchdog stores its socket on.
 */
interface ParentLivenessHolder {
  __obsidianIntegrationTestingParentLiveness?: ParentLivenessSocket;
}

/**
 * The subset of the renderer's watchdog socket a test reads.
 */
interface ParentLivenessSocket {
  readyState?: string;
  remotePort?: number;
}

/**
 * What the arming check reports back out of the renderer.
 */
interface WatchdogSocketState {
  isArmed: boolean;
  readyState: string | undefined;
  remotePort: number | undefined;
}

describe('parent-liveness watchdog', () => {
  it('holds an open socket back to the harness process', async () => {
    const state = await evalInObsidian({
      callback(): WatchdogSocketState {
        // eslint-disable-next-line no-restricted-syntax -- Approved double cast: the watchdog's window property is internal to the harness and deliberately not declared globally.
        const holder = globalThis as unknown as ParentLivenessHolder;
        const socket = holder.__obsidianIntegrationTestingParentLiveness;
        return {
          isArmed: Boolean(socket),
          readyState: socket?.readyState,
          remotePort: socket?.remotePort
        };
      },
      vaultPath
    });

    expect(state.isArmed).toBe(true);
    expect(state.readyState).toBe('open');
    expect(state.remotePort).toBeGreaterThan(0);
  });

  it('is idempotent — re-arming reuses the existing socket', async () => {
    const before = await readRemotePort();

    // Re-evaluate the very expression the transport uses. The port is irrelevant
    // Here: a second arming must short-circuit before it ever tries to connect.
    const UNUSED_PORT = 1;
    const result = await evalInObsidian({
      callback({ expression }): string {
        // Runs the harness's own expression exactly as the transport delivers it.
        return String(globalThis.eval(expression));
      },
      input: { expression: buildParentLivenessWatchdogExpression(UNUSED_PORT) },
      vaultPath
    });

    expect(result).toBe('already-armed');
    expect(await readRemotePort()).toBe(before);
  });
});

/**
 * Reads the watchdog socket's remote port from the renderer.
 *
 * @returns The remote port, or `undefined` when no socket is armed.
 */
async function readRemotePort(): Promise<number | undefined> {
  return evalInObsidian({
    callback(): number | undefined {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast, same rationale as above.
      const holder = globalThis as unknown as ParentLivenessHolder;
      return holder.__obsidianIntegrationTestingParentLiveness?.remotePort;
    },
    vaultPath
  });
}
