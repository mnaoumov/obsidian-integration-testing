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
 * Parameters for {@link buildPortOwnerQuery}.
 */
export interface BuildPortOwnerQueryParams {
  /**
  The host platform (`process.platform`).
   */
  readonly platform: NodeJS.Platform;

  /**
  The port to query.
   */
  readonly port: number;
}

/**
 * Parameters for {@link excludeProtectedPids}.
 */
export interface ExcludeProtectedPidsParams {
  /**
  The PIDs a port query listed.
   */
  readonly pids: readonly number[];

  /**
  The PIDs that must never be killed: the harness process and its ancestors.
   */
  readonly protectedPids: readonly number[];
}

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

/**
 * A host command and its arguments.
 */
export interface PortOwnerQuery {
  /**
  The executable to run.
   */
  readonly command: string;

  /**
  Its arguments.
   */
  readonly commandArguments: readonly string[];
}

const LISTENING_STATE = 'LISTENING';
const RADIX_DECIMAL = 10;
const TCP_PROTOCOL = 'TCP';
const WHITESPACE_PATTERN = /\s+/;
// In `/proc/<pid>/stat`, after the `)` that ends the command name: state, then the parent PID.
const PROC_STAT_PARENT_PID_FIELD_INDEX = 1;

/**
 * Builds the platform's "who listens on this port" query.
 *
 * `netstat` cannot filter by port, so the whole table comes back and the parser
 * keeps the `LISTENING` rows. `lsof` filters on its side: `-sTCP:LISTEN` keeps
 * only listeners. Without it `lsof -ti tcp:<port>` also lists every CLIENT of
 * the port, which for a CDP port is the test runner itself, and a teardown that
 * kills every listed PID then kills its own runner.
 *
 * @param params - The platform and the port.
 * @returns The command and arguments to run.
 */
export function buildPortOwnerQuery(params: BuildPortOwnerQueryParams): PortOwnerQuery {
  return params.platform === 'win32'
    ? { command: 'netstat', commandArguments: ['-ano'] }
    : { command: 'lsof', commandArguments: ['-ti', `tcp:${String(params.port)}`, '-sTCP:LISTEN'] };
}

/**
 * Drops the PIDs a teardown must never kill from a port-owner listing.
 *
 * @param params - The listed PIDs and the protected ones.
 * @returns The listed PIDs that are not protected, in listed order.
 */
export function excludeProtectedPids(params: ExcludeProtectedPidsParams): number[] {
  return params.pids.filter((pid) => !params.protectedPids.includes(pid));
}

/**
 * Parses `lsof -ti tcp:<port> -sTCP:LISTEN` output, which is already one PID per line.
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
 * Reads the parent PID out of a Linux `/proc/<pid>/stat` line.
 *
 * The command name is in parentheses and may itself hold spaces or `)`, so the
 * fields are read after the LAST `)`.
 *
 * @param statText - The content of `/proc/<pid>/stat`.
 * @returns The parent PID, or `null` when the line cannot be read.
 */
export function parseProcStatParentPid(statText: string): null | number {
  const commandEnd = statText.lastIndexOf(')');
  if (commandEnd === -1) {
    return null;
  }

  const fields = statText.slice(commandEnd + 1).trim().split(WHITESPACE_PATTERN);
  const parentPid = Number.parseInt(fields[PROC_STAT_PARENT_PID_FIELD_INDEX] ?? '', RADIX_DECIMAL);
  return Number.isNaN(parentPid) ? null : parentPid;
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
