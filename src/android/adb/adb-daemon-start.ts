/**
 * @file
 *
 * Recognizes the adb client starting the adb server (the daemon) itself.
 *
 * The first `adb` command of a session starts the server when none is running,
 * and announces it on stderr: `* daemon not running; starting now at tcp:5037`.
 * That start takes several seconds, longer than the 5s budget a quick listing
 * gets, so a listing that happens to be the first call of the session is killed
 * by its own timeout. The failure then names the daemon start and nothing else.
 *
 * Kept apart from the integration-only `adb-server.ts` so the predicate stays
 * unit-tested.
 */

const DAEMON_STARTING_PATTERN = /daemon not running/i;

/**
 * Checks whether adb output says the client found no server and was starting one.
 *
 * @param output - The text adb printed, stdout and stderr together, or an error message carrying it.
 * @returns `true` when the output reports the daemon start.
 */
export function checkIsAdbDaemonStarting(output: string): boolean {
  return DAEMON_STARTING_PATTERN.test(output);
}
