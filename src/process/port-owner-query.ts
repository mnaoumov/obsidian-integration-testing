/**
 * @file
 *
 * Runs the platform's "who is listening on this port?" query (`netstat -ano` on
 * Windows, `lsof -ti` elsewhere) and parses its answer.
 *
 * Shared by the Appium teardown and the owned desktop instance's kill: both hold
 * a PID that is not always the process actually serving, and the port is the
 * direct evidence of what is. The parsing and the failure verdicts live in the
 * unit-tested `port-owner.ts` and `port-owner-query-verdict.ts`; this module only
 * shells out, so it imports nothing that reads the build-time metadata global
 * and stays loadable from the emulator reaper.
 */

/* v8 ignore start -- Integration-time process management covered by integration tests, not unit tests. */

import {
  execFile,
  execFileSync
} from 'node:child_process';
import process from 'node:process';

import {
  buildPortOwnerQueryMessage,
  normalizeSyncExecError,
  resolvePortOwnerQueryOutcome
} from './port-owner-query-verdict.ts';
import {
  parsePosixLsofPids,
  parseWindowsNetstatPids
} from './port-owner.ts';

/**
 * Parameters shared by {@link listPortOwnerPids} and {@link listPortOwnerPidsSync}.
 */
export interface ListPortOwnerPidsParams {
  /**
  Where a failed query is reported.
   */
  readonly log: (message: string) => void;

  /**
  The port to query.
   */
  readonly port: number;

  /**
  How long the query may run before it is killed.
   */
  readonly timeoutInMilliseconds: number;
}

/**
 * Parameters for {@link parsePortOwnerPids}.
 */
export interface ParsePortOwnerPidsParams {
  /**
  Raw stdout of the platform's port query.
   */
  readonly output: string;

  /**
  The port that was queried.
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

// A busy host's whole `netstat -ano` table runs to a few hundred KB; 8 MiB is the budget the factory already gave it.
const PORT_OWNER_QUERY_MAX_BUFFER_IN_BYTES = 8_388_608;

/**
 * Builds the platform's "who holds this port" query.
 *
 * `netstat` cannot filter by port, so the whole table comes back and the parser
 * does the matching; `lsof` filters server-side and answers with bare PIDs.
 *
 * @param port - The port to query.
 * @returns The command and arguments to run.
 */
export function buildPortOwnerQuery(port: number): PortOwnerQuery {
  return process.platform === 'win32'
    ? { command: 'netstat', commandArguments: ['-ano'] }
    : { command: 'lsof', commandArguments: ['-ti', `tcp:${String(port)}`] };
}

/**
 * Lists port owners without blocking the harness event loop during teardown.
 *
 * @param params - The port, the budget, and where to report a failure.
 * @returns The listening PIDs, or an empty list after a logged failure.
 */
export function listPortOwnerPids(params: ListPortOwnerPidsParams): Promise<number[]> {
  const query = buildPortOwnerQuery(params.port);
  const startedAtInMilliseconds = Date.now();
  return new Promise((resolve) => {
    execFile(query.command, [...query.commandArguments], {
      encoding: 'utf-8',
      maxBuffer: PORT_OWNER_QUERY_MAX_BUFFER_IN_BYTES,
      timeout: params.timeoutInMilliseconds,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const exitCode = typeof error?.code === 'number' ? error.code : null;
      const outcome = resolvePortOwnerQueryOutcome({
        errorCode: error?.code ?? null,
        hasFailed: error !== null,
        isKilled: error?.killed ?? false,
        platform: process.platform,
        standardError: stderr,
        standardOutput: stdout
      });
      const message = buildPortOwnerQueryMessage({
        command: [query.command, ...query.commandArguments].join(' '),
        elapsedInMilliseconds: Date.now() - startedAtInMilliseconds,
        exitCode,
        outcome,
        port: params.port,
        signal: error?.signal ?? null,
        standardError: stderr,
        timeoutInMilliseconds: params.timeoutInMilliseconds
      });
      if (message !== null) {
        params.log(message);
      }
      resolve(outcome === 'answered' ? parsePortOwnerPids({ output: stdout, port: params.port }) : []);
    });
  });
}

/**
 * Synchronously lists the PIDs listening on a port, for a caller that cannot
 * await (a `process.on('exit')` teardown, or a synchronous `kill()`).
 *
 * A failed query yields an empty list, but is never silent: a timeout or a
 * crash is reported through `log`, because an empty list from either reads
 * exactly like "nothing holds the port".
 *
 * @param params - The port, the budget, and where to report a failure.
 * @returns The listening PIDs, or an empty list when nothing holds the port or the query failed.
 */
// eslint-disable-next-line typescript-dev-toolkit/params-options-name-match -- Permanent: both execution modes share the same port-query parameters.
export function listPortOwnerPidsSync(params: ListPortOwnerPidsParams): number[] {
  const query = buildPortOwnerQuery(params.port);
  const startedAtInMilliseconds = Date.now();
  try {
    const output = execFileSync(query.command, query.commandArguments, {
      encoding: 'utf-8',
      maxBuffer: PORT_OWNER_QUERY_MAX_BUFFER_IN_BYTES,
      timeout: params.timeoutInMilliseconds
    });
    return parsePortOwnerPids({ output, port: params.port });
  } catch (error) {
    const failure = normalizeSyncExecError(error);
    const message = buildPortOwnerQueryMessage({
      command: [query.command, ...query.commandArguments].join(' '),
      elapsedInMilliseconds: Date.now() - startedAtInMilliseconds,
      exitCode: failure.exitCode,
      outcome: resolvePortOwnerQueryOutcome({ ...failure, hasFailed: true, platform: process.platform }),
      port: params.port,
      signal: failure.signal,
      standardError: failure.standardError,
      timeoutInMilliseconds: params.timeoutInMilliseconds
    });
    if (message !== null) {
      params.log(message);
    }
    return [];
  }
}

/**
 * Parses a port-owner listing with the platform's parser.
 *
 * @param params - The raw output and the port that was queried.
 * @returns The PIDs holding the port.
 */
export function parsePortOwnerPids(params: ParsePortOwnerPidsParams): number[] {
  return process.platform === 'win32'
    ? parseWindowsNetstatPids({ netstatOutput: params.output, port: params.port })
    : parsePosixLsofPids(params.output);
}

/* v8 ignore stop */
