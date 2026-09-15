/**
 * @file
 *
 * The desktop CDP transport multiplexes every in-flight command over ONE
 * `message` listener per socket, so the listener count is a constant however many
 * evaluations a suite has in flight at once.
 *
 * It used to add a listener per command and remove it on reply or timeout. That
 * leaks nothing — measured 2026-09-15, the count fell back to zero after a
 * fifteen-wide batch and after a closure that outran the per-eval cap — but it
 * makes the count scale with concurrency, and Node warns at eleven listeners on
 * one `EventTarget`. So a consumer whose suite legitimately ran eleven concurrent
 * `evalInObsidian` calls was told, once per run, that the transport was leaking
 * memory:
 *
 * ```text
 * MaxListenersExceededWarning: Possible EventTarget memory leak detected.
 * 11 message listeners added to WebSocket. MaxListeners is 10.
 * ```
 *
 * A warning that fires on correct use costs more than it is worth: the real
 * signal — an entry added and never removed — becomes indistinguishable from it.
 * Hence the constant, asserted here rather than reasoned about, and asserted on
 * the sockets themselves rather than on any field of the transport.
 *
 * The routing is asserted alongside it, because one shared listener is only
 * correct if each reply still reaches the caller that sent it: the batch hands
 * every closure a different value to echo back.
 */

import { getEventListeners } from 'node:events';
import process from 'node:process';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from './eval-in-obsidian.ts';
import { TemporaryVault } from './temporary-vault.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 120_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 120_000;
/*
 * Five past Node's default `maxListeners` of 10, so a per-command listener would
 * cross it — the exact condition that produced the warning this suite exists for.
 */
const CONCURRENT_EVAL_COUNT = 15;
/*
 * Long enough that every closure in the batch is still in flight when the others
 * are sent, and that the mid-flight reading below lands inside the window.
 */
const CLOSURE_SLEEP_IN_MILLISECONDS = 2000;
const MID_FLIGHT_READING_DELAY_IN_MILLISECONDS = 500;
const EXPECTED_MESSAGE_LISTENER_COUNT = 1;

const originalWebSocket = WebSocket;
const openedSockets: EventTarget[] = [];

/**
 * Records every socket the transport opens, so the assertions can read the
 * listener counts off the sockets rather than off a private field.
 */
class RecordingWebSocket extends originalWebSocket {
  public constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    openedSockets.push(this);
  }
}

globalThis.WebSocket = RecordingWebSocket;

describe('desktop CDP command multiplexing', () => {
  const vault = new TemporaryVault();
  const warnings: string[] = [];
  let midFlightListenerCounts: number[] = [];

  function readMessageListenerCounts(): number[] {
    return openedSockets.map((socket) => getEventListeners(socket, 'message').length);
  }

  function onWarning(warning: Error): void {
    warnings.push(`${warning.name}: ${warning.message}`);
  }

  beforeAll(async () => {
    process.on('warning', onWarning);
    vault.populate({ 'note.md': '# note\n' });
    await vault.register();
  }, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

  afterAll(async () => {
    process.off('warning', onWarning);
    globalThis.WebSocket = originalWebSocket;
    await vault.dispose();
  });

  it('should answer every concurrent evaluation with its own result', async () => {
    const batch = Array.from({ length: CONCURRENT_EVAL_COUNT }, async (_unused, index) =>
      evalInObsidian({
        async callback({ echoed, sleepInMilliseconds }): Promise<number> {
          await new Promise((resolve) => {
            globalThis.setTimeout(resolve, sleepInMilliseconds);
          });

          return echoed;
        },
        input: { echoed: index, sleepInMilliseconds: CLOSURE_SLEEP_IN_MILLISECONDS },
        vaultPath: vault.path
      }));

    const midFlightReading = new Promise<number[]>((resolve) => {
      globalThis.setTimeout(() => {
        resolve(readMessageListenerCounts());
      }, MID_FLIGHT_READING_DELAY_IN_MILLISECONDS);
    });

    const [results, counts] = await Promise.all([Promise.all(batch), midFlightReading]);
    midFlightListenerCounts = counts;

    expect(results).toEqual(Array.from({ length: CONCURRENT_EVAL_COUNT }, (_unused, index) => index));
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should keep one message listener per socket while those evaluations are in flight', () => {
    /*
     * The maximum says both halves at once: no socket carries more than one
     * listener, and one of them carries exactly that. The second half is not
     * pedantry — the reading also covers the short-lived sockets the boot probes
     * open, which are closed by now and listen to nothing, so an upper bound alone
     * would pass just as well on a reading made up entirely of those. An empty
     * reading gives `-Infinity` and fails here too.
     */
    expect(Math.max(...midFlightListenerCounts)).toBe(EXPECTED_MESSAGE_LISTENER_COUNT);
  });

  it('should not warn that the transport socket is leaking listeners', () => {
    expect(warnings.filter((warning) => warning.includes('MaxListenersExceededWarning'))).toEqual([]);
  });
});
