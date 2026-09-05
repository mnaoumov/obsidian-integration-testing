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
const EXECUTABLE_SUFFIX_PATTERN = /\.exe$/;
const RADIX_DECIMAL = 10;
/**
 * Only the image name and the PID are read, so the split stops after them.
 */
const TASK_LIST_FIELDS_READ = 2;

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
