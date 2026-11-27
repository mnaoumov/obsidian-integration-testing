/**
 * @file
 *
 * Runs the platform's "who is listening on this port?" query (`netstat -ano` on
 * Windows, `lsof -ti tcp:<port> -sTCP:LISTEN` elsewhere) and parses its answer.
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
import { readFileSync } from 'node:fs';
import process from 'node:process';

import type { PortOwnerQuery } from './port-owner.ts';

import {
  buildPortOwnerQueryMessage,
  normalizeSyncExecError,
  resolvePortOwnerQueryOutcome
} from './port-owner-query-verdict.ts';
import {
  buildPortOwnerQuery,
  excludeProtectedPids,
  parsePosixLsofPids,
  parseProcStatParentPid,
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

// A busy host's whole `netstat -ano` table runs to a few hundred KB; 8 MiB is the budget the factory already gave it.
const PORT_OWNER_QUERY_MAX_BUFFER_IN_BYTES = 8_388_608;

// Bounds the ancestor walk; a real process tree is a handful of levels deep.
const MAX_ANCESTOR_DEPTH = 64;

/**
 * Builds this host's "who listens on this port" query.
 *
 * @param port - The port to query.
 * @returns The command and arguments to run.
 */
export function buildHostPortOwnerQuery(port: number): PortOwnerQuery {
  return buildPortOwnerQuery({ platform: process.platform, port });
}

/**
 * Lists the PIDs no port-owner kill may ever reach: this process and its
 * ancestors. A test runner holds client sockets on the ports it tears down,
 * so a listing that ever names it must not turn into a kill.
 *
 * On Linux the whole chain is read from `/proc`; elsewhere only the parent is
 * known without spawning a process.
 *
 * @returns This process's PID and its known ancestors.
 */
export function listHarnessProtectedPids(): number[] {
  const pids = [process.pid];
  let currentPid = process.ppid;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && currentPid > 0 && !pids.includes(currentPid); depth++) {
    pids.push(currentPid);
    if (process.platform !== 'linux') {
      break;
    }

    let statText: string;
    try {
      statText = readFileSync(`/proc/${String(currentPid)}/stat`, 'utf-8');
    } catch {
      break;
    }

    currentPid = parseProcStatParentPid(statText) ?? 0;
  }

  return pids;
}

/**
 * Lists port owners without blocking the harness event loop during teardown.
 *
 * @param params - The port, the budget, and where to report a failure.
 * @returns The listening PIDs, or an empty list after a logged failure.
 */
export function listPortOwnerPids(params: ListPortOwnerPidsParams): Promise<number[]> {
  const query = buildHostPortOwnerQuery(params.port);
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
  const query = buildHostPortOwnerQuery(params.port);
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
 * Never returns this process or one of its ancestors (see {@link listHarnessProtectedPids}).
 *
 * @returns The PIDs listening on the port.
 */
export function parsePortOwnerPids(params: ParsePortOwnerPidsParams): number[] {
  const pids = process.platform === 'win32'
    ? parseWindowsNetstatPids({ netstatOutput: params.output, port: params.port })
    : parsePosixLsofPids(params.output);
  return excludeProtectedPids({ pids, protectedPids: listHarnessProtectedPids() });
}

/* v8 ignore stop */
