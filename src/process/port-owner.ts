/**
 * @file
 *
 * Pure helpers for answering "which process is still holding this port?".
 *
 * A teardown that cannot answer that question can only re-issue the same kill at
 * the same PID, which is no escalation at all: the PID the harness holds is the
 * shell wrapper it spawned, and what survives is whatever that wrapper's tree
 * walk failed to reach. The port, by contrast, is direct evidence — a socket
 * still answering on 4723 after this run killed the server it started belongs to
 * that server.
 *
 * Kept separate from the integration-only `transport-factory` so the parsing
 * stays unit-testable; the factory shells out to `netstat` / `lsof`.
 */

/**
 * Parameters for {@link parseWindowsNetstatPids}.
 */
export interface ParseWindowsNetstatPidsParams {
  /**
  Raw stdout of `netstat -ano`.
   */
  readonly netstatOutput: string;

  /**
  The local port whose listener is wanted.
   */
  readonly port: number;
}

const LISTENING_STATE = 'LISTENING';
const RADIX_DECIMAL = 10;
const TCP_PROTOCOL = 'TCP';
const WHITESPACE_PATTERN = /\s+/;

/**
 * Parses `lsof -ti tcp:<port>` output, which is already one PID per line.
 *
 * @param lsofOutput - Raw stdout of the `lsof` query.
 * @returns The distinct PIDs, in listed order.
 */
export function parsePosixLsofPids(lsofOutput: string): number[] {
  const pids: number[] = [];

  for (const line of lsofOutput.split('\n')) {
    const pid = Number.parseInt(line.trim(), RADIX_DECIMAL);
    if (Number.isNaN(pid) || pids.includes(pid)) {
      continue;
    }

    pids.push(pid);
  }

  return pids;
}

/**
 * Parses `netstat -ano` output for the PIDs **listening** on a port.
 *
 * Only `TCP` rows in the `LISTENING` state count: an established connection *to*
 * the port belongs to a client, not to the server that must die, and the `UDP`
 * rows have no state column at all. The same server appears twice when it binds
 * both IPv4 and IPv6, so PIDs are de-duplicated.
 *
 * @param params - The listing output and the port to match.
 * @returns The distinct listening PIDs, in listed order.
 */
export function parseWindowsNetstatPids(params: ParseWindowsNetstatPidsParams): number[] {
  const localAddressSuffix = `:${String(params.port)}`;
  const pids: number[] = [];

  for (const rawLine of params.netstatOutput.split('\n')) {
    const [protocol = '', localAddress = '', , state = '', rawPid = ''] = rawLine.trim().split(WHITESPACE_PATTERN);
    if (protocol !== TCP_PROTOCOL || state !== LISTENING_STATE || !localAddress.endsWith(localAddressSuffix)) {
      continue;
    }

    const pid = Number.parseInt(rawPid, RADIX_DECIMAL);
    if (Number.isNaN(pid) || pids.includes(pid)) {
      continue;
    }

    pids.push(pid);
  }

  return pids;
}
