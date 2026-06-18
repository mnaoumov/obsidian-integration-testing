/**
 * @file
 *
 * Resolves the absolute path of the installed Obsidian executable on the host machine.
 *
 * Used by desktop transports (`CLI`, `CDP`) to auto-launch Obsidian when it is
 * not already running. Supports installer-based installs (e.g.
 * `%LOCALAPPDATA%\Programs\Obsidian\Obsidian.exe` on Windows,
 * `/Applications/Obsidian.app` on macOS) and `PATH`-based installs (e.g.
 * `scoop` shims on Windows, package manager installs on Linux).
 *
 * The path is verified to exist on disk before being returned. If Obsidian
 * cannot be located, a descriptive `Error` is thrown so the caller can surface
 * an actionable message instead of spawning a non-existent binary (which on
 * Windows causes `start` to show a `ShellExecute` dialog box rather than
 * failing with an exit code).
 */

/* v8 ignore start -- Integration-time code covered by integration tests, not unit tests. */

import { existsSync } from 'node:fs';
import process from 'node:process';

import { exec } from './exec.ts';

/**
 * Resolves the absolute path to the Obsidian executable on the host machine.
 *
 * @returns The absolute path to the Obsidian executable.
 * @throws Error if Obsidian cannot be located.
 */
export async function resolveObsidianExecutable(): Promise<string> {
  if (process.platform === 'win32') {
    return await resolveOnWindows();
  }

  if (process.platform === 'darwin') {
    return resolveOnMacOs();
  }

  return await resolveOnLinux();
}

async function findInPath(lookupCommand: string, executableName: string): Promise<string | undefined> {
  let output: string;
  try {
    output = await exec(`${lookupCommand} ${executableName}`, { isQuiet: true });
  } catch {
    return undefined;
  }

  const candidates = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && existsSync(line));

  /*
   * Prefer a real executable over a launcher shim. `scoop` installs create a
   * `<name>.exe` shim in `scoop\shims\` that forwards to the `.com` console
   * binary; launching it runs the CLI (which exits immediately) instead of the
   * GUI, so auto-launch would never start Obsidian. `where.exe` lists the shim
   * before the actual `scoop\apps\<app>\current\<name>.exe`, so skip any shim.
   */
  const nonShim = candidates.find((candidate) => !isShim(candidate));
  return nonShim ?? candidates[0];
}

/**
 * Detects whether an executable path is a `scoop` shim rather than the real
 * binary. Scoop shims have a sibling `<name>.shim` file describing the forward
 * target; the real executable has no such companion.
 *
 * @param executablePath - The absolute path to the executable.
 * @returns `true` if the path is a scoop shim.
 */
function isShim(executablePath: string): boolean {
  const shimMarkerPath = executablePath.replace(/\.[^.\\/]+$/, '.shim');
  return shimMarkerPath !== executablePath && existsSync(shimMarkerPath);
}

async function resolveOnLinux(): Promise<string> {
  const fromPath = await findInPath('which', 'obsidian');
  if (fromPath) {
    return fromPath;
  }

  throw new Error(
    'Unable to locate Obsidian executable. Install Obsidian and ensure `obsidian` is on PATH.'
  );
}

function resolveOnMacOs(): string {
  const standardPath = '/Applications/Obsidian.app/Contents/MacOS/Obsidian';
  if (existsSync(standardPath)) {
    return standardPath;
  }

  throw new Error(
    `Unable to locate Obsidian executable at \`${standardPath}\`. Install Obsidian from https://obsidian.md/download.`
  );
}

async function resolveOnWindows(): Promise<string> {
  const fromPath = await findInPath('where.exe', 'Obsidian.exe');
  if (fromPath) {
    return fromPath;
  }

  const localAppData = process.env['LOCALAPPDATA'] ?? '';
  const installerPath = `${localAppData}\\Programs\\Obsidian\\Obsidian.exe`;
  if (existsSync(installerPath)) {
    return installerPath;
  }

  throw new Error(
    `Unable to locate Obsidian executable. Install Obsidian (e.g. from https://obsidian.md/download or via \`scoop install obsidian\`) and ensure it is on PATH or installed to \`${installerPath}\`.`
  );
}

/* v8 ignore stop */
