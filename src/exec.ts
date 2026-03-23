/**
 * @packageDocumentation
 *
 * Contains utility functions for executing commands.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { spawn } from 'node:child_process';
import process from 'node:process';

/**
 * A command part: either a plain string or an {@link ExecArg} with batched arguments.
 */
export type CommandPart = ExecArg | string;

/**
 * A command argument that contains a list of args to be batched.
 * If the expanded command exceeds the platform's max command length,
 * the batched args are split into sequential executions.
 */
export interface ExecArg {
  /**
   * The arguments to batch.
   */
  batchedArgs: string[];
}

/**
 * Options for {@link exec} that return detailed results.
 */
export interface ExecDetailedOptions extends ExecOption {
  /**
   * Must be `true` to receive detailed results.
   */
  withDetails: true;
}

/**
 * Options for executing a command.
 */
export interface ExecOption {
  /**
   * A current working folder for the command execution.
   */
  readonly cwd?: string;

  /**
   * If `true`, suppresses the output of the command.
   */
  readonly isQuiet?: boolean;

  /**
   * If `true`, ignores the exit code of the command.
   */
  readonly shouldIgnoreExitCode?: boolean;

  /**
   * If `true`, returns detailed results.
   */
  readonly shouldIncludeDetails?: boolean;

  /**
   * An input to be passed to the command.
   */
  readonly stdin?: string;
}

/**
 * A result of {@link exec}.
 */
export interface ExecResult {
  /**
   * An exit code of the command. A value of `null` indicates that the process did not exit normally.
   */
  exitCode: null | number;

  /**
   * A signal that caused the process to be terminated. A value of `null` indicates that no signal was received.
   */
  exitSignal: NodeJS.Signals | null;

  /**
   * A standard error output from the command.
   */
  stderr: string;

  /**
   * A standard output from the command.
   */
  stdout: string;
}

/**
 * Options for {@link exec} that return only stdout.
 */
export interface ExecSimpleOptions extends ExecOption {
  /**
   * Must be `false` or omitted to receive only stdout.
   */
  withDetails?: false;
}

/**
 * Executes a command.
 *
 * @param command - The command to execute. It can be a string or an array of strings.
 * @param options - The options for the execution.
 * @returns A {@link Promise} that resolves with the output of the command.
 */
export async function exec(command: CommandPart[] | string, options?: ExecSimpleOptions): Promise<string>;
/**
 * Executes a command.
 *
 * @param command - The command to execute. It can be a string or an array of strings.
 * @param options - The options for the execution.
 * @returns A {@link Promise} that resolves with ExecResult object.
 */
export function exec(command: CommandPart[] | string, options: ExecDetailedOptions): Promise<ExecResult>;
/**
 * Executes a command.
 *
 * @param command - The command to execute. It can be a string or an array of strings.
 * @param options - The options for the execution.
 * @returns A {@link Promise} that resolves with the output of the command or an ExecResult object.
 */
export function exec(command: CommandPart[] | string, options: ExecOption = {}): Promise<ExecResult | string> {
  if (Array.isArray(command)) {
    const batchResult = handleBatchedCommand(command, options);
    if (batchResult) {
      return batchResult;
    }
    const args = command.filter((part): part is string => typeof part === 'string');
    const commandLine = toCommandLine(args);

    const maxCommandLength = getMaxCommandLength();
    if (commandLine.length > maxCommandLength) {
      return Promise.reject(
        new Error(
          `Command line is too long (${String(commandLine.length)} chars, max ${
            String(maxCommandLength)
          } on ${process.platform}). Consider using ExecArg with batchedArgs.`
        )
      );
    }

    return execString(commandLine, options, args);
  }

  const maxCommandLength = getMaxCommandLength();
  if (command.length > maxCommandLength) {
    return Promise.reject(
      new Error(
        `Command line is too long (${String(command.length)} chars, max ${
          String(maxCommandLength)
        } on ${process.platform}). Consider using ExecArg with batchedArgs.`
      )
    );
  }

  return execString(command, options);
}

/**
 * Executes a single string command.
 *
 * @param command - The command string.
 * @param options - The exec options.
 * @param rawArgs - The original argument array (if available), used by the
 *   direct-spawn fallback on Windows when the command contains newlines.
 * @returns A Promise resolving to the result.
 */
function execString(command: string, options: ExecOption = {}, rawArgs?: string[]): Promise<ExecResult | string> {
  const {
    cwd = process.cwd(),
    isQuiet: quiet = false,
    shouldIgnoreExitCode: ignoreExitCode = false,
    shouldIncludeDetails: withDetails = false,
    stdin = ''
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawnViaShell(command, cwd, rawArgs);

    let stdout = '';
    let stderr = '';

    child.stdin.write(stdin);
    child.stdin.end();

    child.stdout.on('data', (data: Buffer) => {
      if (!quiet) {
        process.stdout.write(data);
      }
      stdout += data.toString('utf-8');
    });

    child.stdout.on('end', () => {
      stdout = trimEnd(stdout, '\n');
    });

    child.stderr.on('data', (data: Buffer) => {
      if (!quiet) {
        process.stderr.write(data);
      }
      stderr += data.toString('utf-8');
    });

    child.stderr.on('end', () => {
      stderr = trimEnd(stderr, '\n');
    });

    child.on('close', (exitCode, exitSignal) => {
      if (exitCode !== 0 && !ignoreExitCode) {
        reject(new Error(`Command failed with exit code ${exitCode ? String(exitCode) : '(null)'}\n${stderr}`));
        return;
      }

      if (!withDetails) {
        resolve(stdout);
        return;
      }
      resolve({
        exitCode,
        exitSignal,
        stderr,
        stdout
      });
    });

    child.on('error', (err) => {
      if (!ignoreExitCode) {
        reject(err);
        return;
      }

      if (!withDetails) {
        resolve(stdout);
        return;
      }

      resolve({
        exitCode: null,
        exitSignal: null,
        stderr,
        stdout
      });
    });
  });
}

/**
 * Default environment variables passed to child processes.
 */
const CHILD_ENV = {
  DEBUG_COLORS: '1',
  ...process.env
};

/**
 * Matches `cmd.exe` metacharacters that must be `^`-escaped.
 */
const CMD_META_RE = /[()%!^"<>&|]/g;

/**
 * Converts an array of command-line arguments into a single command-line string
 * using the `CommandLineToArgvW` convention.
 *
 * @param args - The array of command-line arguments to convert.
 * @returns A string representing the command-line invocation.
 */
export function toCommandLine(args: string[]): string {
  return args.map((arg) => argvQuote(arg)).join(' ');
}

/**
 * Quotes a single argument so that `CommandLineToArgvW` will decode it
 * unchanged.
 *
 * @param arg - The raw argument string.
 * @returns The quoted argument string.
 */
function argvQuote(arg: string): string {
  if (arg.length > 0 && !/[\s\t\n\v"]/.test(arg)) {
    return arg;
  }

  const BACKSLASH_ESCAPE_FACTOR = 2;
  let result = '"';
  for (let i = 0; i < arg.length; i++) {
    let numBackslashes = 0;
    while (i < arg.length && arg[i] === '\\') {
      i++;
      numBackslashes++;
    }

    if (i === arg.length) {
      result += '\\'.repeat(numBackslashes * BACKSLASH_ESCAPE_FACTOR);
      break;
    }

    const ch = arg.charAt(i);
    if (ch === '"') {
      result += `${'\\'.repeat(numBackslashes * BACKSLASH_ESCAPE_FACTOR + 1)}"`;
    } else {
      result += '\\'.repeat(numBackslashes) + ch;
    }
  }

  result += '"';
  return result;
}

/**
 * Escapes `cmd.exe` metacharacters with `^` so that `cmd.exe` passes them
 * through literally.
 *
 * @param commandLine - The already-quoted command line string.
 * @returns The string with all cmd metacharacters `^`-escaped.
 */
function cmdEscapeCommandLine(commandLine: string): string {
  return commandLine.replace(CMD_META_RE, '^$&');
}

/**
 * Executes batched commands sequentially and concatenates stdout.
 *
 * @param baseCommand - The base command without batched args.
 * @param batches - The batches of args.
 * @param options - The exec options.
 * @returns A Promise resolving to the concatenated result.
 */
async function executeBatches(baseCommand: string, batches: string[][], options: ExecOption): Promise<ExecResult | string> {
  const results: string[] = [];

  for (const batch of batches) {
    const batchCommand = `${baseCommand} ${batch.join(' ')}`;
    const result = await execString(batchCommand, options);
    if (typeof result === 'string') {
      results.push(result);
    }
  }

  if (options.shouldIncludeDetails) {
    return { exitCode: 0, exitSignal: null, stderr: '', stdout: results.join('\n') };
  }

  return results.join('\n');
}

/**
 * Returns the platform-specific max command line length.
 *
 * @returns The max command length in characters.
 */
function getMaxCommandLength(): number {
  const WINDOWS_MAX_COMMAND_LENGTH = 8191;
  const UNIX_MAX_COMMAND_LENGTH = 131072;
  return process.platform === 'win32' ? WINDOWS_MAX_COMMAND_LENGTH : UNIX_MAX_COMMAND_LENGTH;
}

/**
 * Handles a command array that may contain an {@link ExecArg}.
 * Returns a Promise if batching is needed, or `undefined` if the command
 * has no ExecArg and should be processed normally.
 *
 * @param parts - The command parts.
 * @param options - The exec options.
 * @returns A Promise if batching is handled, or `undefined`.
 */
function handleBatchedCommand(parts: CommandPart[], options: ExecOption): Promise<ExecResult | string> | undefined {
  const execArgs = parts.filter(isExecArg);
  if (execArgs.length === 0) {
    return undefined;
  }
  if (execArgs.length > 1) {
    return Promise.reject(new Error('Only one ExecArg with batchedArgs is allowed per command'));
  }

  const execArg = execArgs[0];
  /* v8 ignore start -- Always truthy after the length check above. */
  if (!execArg) {
    return undefined;
  }
  /* v8 ignore stop */

  const staticParts = parts.filter((part): part is string => typeof part === 'string');
  const baseCommand = toCommandLine(staticParts);
  const maxCommandLength = getMaxCommandLength();

  const fullCommand = `${baseCommand} ${execArg.batchedArgs.join(' ')}`;
  if (fullCommand.length <= maxCommandLength) {
    return execString(fullCommand, options);
  }

  const batches: string[][] = [];
  let currentBatch: string[] = [];

  for (const arg of execArg.batchedArgs) {
    const tentative = `${baseCommand} ${[...currentBatch, arg].join(' ')}`;
    if (tentative.length > maxCommandLength) {
      if (currentBatch.length === 0) {
        return Promise.reject(
          new Error(
            `Cannot split command into batches: a single argument (${String(arg.length)} chars) plus the base command (${
              String(baseCommand.length)
            } chars) exceeds the max command length (${String(maxCommandLength)}).`
          )
        );
      }
      batches.push(currentBatch);
      currentBatch = [arg];
    } else {
      currentBatch.push(arg);
    }
  }
  /* v8 ignore start -- Always true after the loop; batchedArgs is non-empty at this point. */
  if (currentBatch.length > 0) {
    /* v8 ignore stop */
    batches.push(currentBatch);
  }

  return executeBatches(baseCommand, batches, options);
}

/**
 * Checks if a command part is an {@link ExecArg}.
 *
 * @param part - The command part to check.
 * @returns Whether the part is an ExecArg.
 */
function isExecArg(part: CommandPart): part is ExecArg {
  return typeof part === 'object' && 'batchedArgs' in part;
}

/**
 * Spawns a child process via the appropriate shell.
 *
 * On Windows, if the command contains newlines (which `cmd.exe` cannot handle)
 * and the raw args array is available, spawns the process directly without
 * any shell — passing args via `CreateProcess`, which avoids all quoting issues.
 *
 * On Windows (cmd.exe path), applies `^`-escaping for cmd metacharacters.
 *
 * @param command - The command string to execute.
 * @param cwd - The working directory.
 * @param rawArgs - The original argument array (if available).
 * @returns The spawned child process.
 */
function spawnViaShell(command: string, cwd: string, rawArgs?: string[]): ChildProcessWithoutNullStreams {
  if (process.platform === 'win32' && command.includes('\n')) {
    if (!rawArgs) {
      throw new Error('Commands containing newlines cannot be executed through cmd.exe on Windows. Pass an argument array instead of a string.');
    }
    const [program, ...args] = rawArgs;
    /* v8 ignore start -- Always truthy; rawArgs comes from the array path which has at least one element. */
    if (!program) {
      throw new Error('Command array must not be empty');
    }
    /* v8 ignore stop */
    return spawn(program, args, {
      cwd,
      env: CHILD_ENV,
      stdio: 'pipe'
    });
  }

  const shellCommand = process.platform === 'win32' ? cmdEscapeCommandLine(command) : command;
  return spawn(shellCommand, [], {
    cwd,
    env: CHILD_ENV,
    shell: true,
    stdio: 'pipe'
  });
}

/**
 * Removes a suffix from the end of a string if present.
 *
 * @param str - The string to trim.
 * @param suffix - The suffix to remove.
 * @returns The trimmed string.
 */
function trimEnd(str: string, suffix: string): string {
  if (str.endsWith(suffix)) {
    return str.slice(0, -suffix.length);
  }
  return str;
}
