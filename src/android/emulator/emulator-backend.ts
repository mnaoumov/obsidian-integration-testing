/**
 * @file
 *
 * Pure helpers for finding the Android emulator process that **outlives the pid
 * the harness killed**.
 *
 * Under `-no-window` the emulator's backend process is
 * `qemu-system-x86_64-headless` (`qemu-system-x86_64` when windowed), not the
 * `emulator` launcher the harness spawned and holds a `ChildProcess` for. The
 * launcher exits or is killed, and the backend is what actually holds the AVD's
 * `multiinstance.lock` and the console/adb ports — so `taskkill /F /T` against
 * the launcher's pid reports success while the emulator keeps running. Every
 * later run against that AVD then dies with `Running multiple emulators with the
 * same AVD is an experimental feature`, which never reaches the user because the
 * emulator writes it to its own stdout.
 *
 * Note that the obvious filter — `-Name qemu-system-x86_64` / matching that
 * exact image name — does **not** match the `-headless` build, which is how the
 * leftover stays invisible through several rounds of "no emulator is running".
 *
 * Ownership is decided by a **pre-launch snapshot**: a backend already running
 * before this run started its own belongs to somebody else (another AVD, or one
 * the user booted by hand) and is never touched. Kept separate from the
 * integration-only `transport-factory` so the parsing and the selection stay
 * unit-testable.
 */

/**
 * Parameters for {@link checkIsNoMatchReported}.
 */
export interface CheckIsNoMatchReportedParams {
  /**
  The query's stdout.
   */
  readonly output: string;

  /**
  The query that produced it.
   */
  readonly query: EmulatorProcessQuery;
}

/**
 * One command that lists (some of) the host's emulator processes.
 */
export interface EmulatorProcessQuery {
  /**
  The executable.
   */
  readonly command: string;

  /**
  Its arguments.
   */
  readonly commandArguments: readonly string[];

  /**
  Whether the command asks only for emulator image names rather than for every process on the host — which is what makes an empty answer legitimate.
   */
  readonly isFiltered: boolean;
}

/**
 * Parameters for {@link parseEmulatorProcessQueryOutput}.
 */
export interface ParseEmulatorProcessQueryOutputParams {
  /**
  The query's stdout.
   */
  readonly output: string;

  /**
  The query that produced it.
   */
  readonly query: EmulatorProcessQuery;
}

/**
 * One process from a host process listing.
 */
export interface ProcessListEntry {
  /**
  The process/image name, as the platform's listing reports it.
   */
  readonly name: string;

  /**
  The process ID.
   */
  readonly pid: number;
}

/**
 * Parameters for {@link selectEmulatorBackendPids}.
 */
export interface SelectEmulatorBackendPidsParams {
  /**
  Emulator backend PIDs seen **before** this run launched its emulator, which it therefore does not own.
   */
  readonly knownPids: readonly number[];

  /**
  The host's current process listing.
   */
  readonly processes: readonly ProcessListEntry[];
}

/**
 * Matches the emulator launcher and both QEMU backend builds — crucially
 * including the `-headless` suffix `-no-window` runs produce.
 */
const EMULATOR_BACKEND_NAME_PATTERN = /^(?:emulator|emulator64-[\w.-]+|qemu-system-[\w.-]+)$/;
/**
 * The image-name prefixes `tasklist` is asked for — every name
 * `EMULATOR_BACKEND_NAME_PATTERN` accepts starts with one of them.
 *
 * One call per prefix, because `tasklist`'s `/FI` clauses are ANDed: there is
 * no way to OR two image names in a single call.
 */
const EMULATOR_IMAGE_NAME_PREFIXES = ['emulator', 'qemu-system'] as const;

/**
 * The notice `tasklist` prints on stdout, with exit 0, when a filter matched
 * nothing: `INFO: No tasks are running which match the specified criteria.`
 * Only the `INFO:` prefix is matched; a localized Windows that words it
 * differently reads as a silent empty answer, which is reported as a failed
 * query — the safe direction, since a failed query kills nothing.
 */
const TASK_LIST_NO_MATCH_NOTICE_PATTERN = /^INFO: /m;
const EXECUTABLE_SUFFIX_PATTERN = /\.exe$/;
const RADIX_DECIMAL = 10;
/**
 * Only the image name and the PID are read, so the split stops after them.
 */
const TASK_LIST_FIELDS_READ = 2;

/**
 * Builds the commands that list the host's emulator processes.
 *
 * **On Windows the query is filtered to the emulator image names, and that is a
 * measured decision.** A whole-host `tasklist` does per-process work for every
 * row, so it pays the host's contention once per process: during an emulator
 * boot it measured p50 2.9s and max 92.2s over ~530 rows, and with every core
 * saturated one call stalled for 120.9s — until the load exited — where the
 * filtered call never exceeded 505ms (2026-09-23, n=8 each). The per-row cost is
 * work the filter skips, so the filtered query does not inherit it.
 *
 * **On POSIX the whole-host `ps` is kept.** It reads `/proc` and was never
 * measured slow, and a whole-host listing keeps the invariant that zero rows
 * means a failed query — which `pgrep`'s exit 1 on no match would muddy.
 *
 * @param platform - The host platform, e.g. `process.platform`.
 * @returns The queries to run; their parsed rows together are the answer.
 */
export function buildEmulatorProcessQueries(platform: NodeJS.Platform): EmulatorProcessQuery[] {
  return platform === 'win32'
    ? EMULATOR_IMAGE_NAME_PREFIXES.map((prefix) => ({
      command: 'tasklist',
      commandArguments: ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${prefix}*`],
      isFiltered: true
    }))
    : [{ command: 'ps', commandArguments: ['-eo', 'pid=,comm='], isFiltered: false }];
}

/**
 * Checks whether a query affirmatively reported that nothing matched.
 *
 * Only a **filtered** query can say that: a whole-host listing always has rows,
 * so an empty one is never an answer. A filtered query that printed nothing at
 * all is not an answer either — silence and "no emulator is running" must stay
 * distinguishable, or a failed query reads as a host with no emulator on it.
 *
 * @param params - The query and its stdout.
 * @returns Whether the query's output carries its own no-match notice.
 */
export function checkIsNoMatchReported(params: CheckIsNoMatchReportedParams): boolean {
  return params.query.isFiltered && TASK_LIST_NO_MATCH_NOTICE_PATTERN.test(params.output);
}

/**
 * Parses the output of one of {@link buildEmulatorProcessQueries}' commands.
 *
 * @param params - The query and its stdout.
 * @returns One entry per parsable row, in listed order.
 */
export function parseEmulatorProcessQueryOutput(params: ParseEmulatorProcessQueryOutputParams): ProcessListEntry[] {
  return params.query.command === 'tasklist' ? parseWindowsTaskList(params.output) : parsePosixProcessList(params.output);
}

/**
 * Parses `ps -eo pid=,comm=` output.
 *
 * @param processListOutput - Raw stdout of the `ps` listing.
 * @returns One entry per parsable row, in listed order.
 */
export function parsePosixProcessList(processListOutput: string): ProcessListEntry[] {
  const entries: ProcessListEntry[] = [];

  for (const rawLine of processListOutput.split('\n')) {
    const line = rawLine.trim();
    const separatorIndex = line.indexOf(' ');
    if (separatorIndex === -1) {
      continue;
    }

    const pid = Number.parseInt(line.slice(0, separatorIndex), RADIX_DECIMAL);
    if (Number.isNaN(pid)) {
      continue;
    }

    entries.push({ name: line.slice(separatorIndex + 1).trim(), pid });
  }

  return entries;
}

/**
 * Parses `tasklist /FO CSV /NH` output.
 *
 * Only the first two fields are read — the image name and the PID — so the
 * memory column's own commas cannot confuse the split.
 *
 * @param taskListOutput - Raw stdout of the `tasklist` listing.
 * @returns One entry per parsable row, in listed order.
 */
export function parseWindowsTaskList(taskListOutput: string): ProcessListEntry[] {
  const entries: ProcessListEntry[] = [];

  for (const rawLine of taskListOutput.split('\n')) {
    const [rawName = '', rawPid = ''] = rawLine.trim().replaceAll('"', '').split(',', TASK_LIST_FIELDS_READ);
    const pid = Number.parseInt(rawPid, RADIX_DECIMAL);
    if (rawName.length === 0 || Number.isNaN(pid)) {
      continue;
    }

    entries.push({ name: rawName, pid });
  }

  return entries;
}

/**
 * Selects the emulator processes this run is responsible for killing.
 *
 * @param params - The current listing plus the PIDs that predate this run's emulator.
 * @returns The PIDs of emulator processes this run owns, in listed order.
 */
export function selectEmulatorBackendPids(params: SelectEmulatorBackendPidsParams): number[] {
  return params.processes
    .filter((entry) => checkIsEmulatorBackendName(entry.name) && !params.knownPids.includes(entry.pid))
    .map((entry) => entry.pid);
}

function checkIsEmulatorBackendName(name: string): boolean {
  const baseName = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  return EMULATOR_BACKEND_NAME_PATTERN.test(baseName.toLowerCase().replace(EXECUTABLE_SUFFIX_PATTERN, ''));
}
