/**
 * @file
 *
 * Monitors for native OS dialogs (Electron `dialog.showErrorBox`, `dialog.showMessageBoxSync`)
 * from the Obsidian process. These dialogs block the main process and cannot be intercepted
 * from the renderer via `@electron/remote`.
 *
 * Uses platform-specific process window title inspection to detect dialogs, and
 * auto-dismisses them so they don't block test execution.
 */

/* v8 ignore start -- Integration-time utility. Not unit-testable: relies on OS process inspection. */

import process from 'node:process';

import { exec } from './exec.ts';

/**
 * A captured native dialog event.
 */
export interface NativeDialogEvent {
  /**
   * When the dialog was detected.
   */
  timestamp: number;

  /**
   * The window title of the dialog.
   */
  title: string;
}

/**
 * Known Obsidian dialog window titles that indicate an error or blocking prompt.
 */
const DIALOG_TITLES = [
  'Error',
  'Vault not found.'
];

const POLL_INTERVAL_IN_MILLISECONDS = 500;

/**
 * Monitors the Obsidian process for native OS dialogs by polling process window titles.
 *
 * Detected dialogs are auto-dismissed (via WM_CLOSE / AppleScript / xdotool) so they
 * don't block the main process, and recorded for later assertion.
 *
 * Cross-platform: works on Windows, macOS, and Linux.
 */
export class NativeDialogMonitor {
  private events: NativeDialogEvent[] = [];
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private isPolling = false;

  /**
   * Asserts that no native dialogs were detected during monitoring.
   *
   * @throws If any dialogs were recorded.
   */
  public assertNoDialogs(): void {
    if (this.events.length > 0) {
      const descriptions = this.events
        .map((e) => `  - "${e.title}" at ${new Date(e.timestamp).toISOString()}`)
        .join('\n');
      throw new Error(`Native dialog(s) detected during test:\n${descriptions}`);
    }
  }

  /**
   * Returns all dialog events recorded since the monitor started.
   *
   * @returns The recorded dialog events.
   */
  public getEvents(): readonly NativeDialogEvent[] {
    return this.events;
  }

  /**
   * Resets the recorded events without stopping the monitor.
   */
  public reset(): void {
    this.events = [];
  }

  /**
   * Starts polling for native dialogs in the background.
   */
  public start(): void {
    if (this.intervalId) {
      return;
    }
    this.events = [];
    this.intervalId = setInterval(() => {
      this.poll().catch(() => {
        // Ignore poll errors.
      });
    }, POLL_INTERVAL_IN_MILLISECONDS);
  }

  /**
   * Stops polling and returns all recorded events.
   *
   * @returns The recorded dialog events.
   */
  public stop(): readonly NativeDialogEvent[] {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    return this.events;
  }

  /**
   * Single poll iteration: detects and dismisses any Obsidian dialog windows.
   */
  private async poll(): Promise<void> {
    if (this.isPolling) {
      return;
    }
    this.isPolling = true;
    try {
      const titles = await getObsidianWindowTitles();
      for (const title of titles) {
        if (DIALOG_TITLES.includes(title)) {
          this.events.push({ timestamp: Date.now(), title });
          await dismissDialogByTitle(title);
        }
      }
    } catch {
      // Process may not be running — ignore.
    } finally {
      this.isPolling = false;
    }
  }
}

/**
 * Dismisses a native dialog window by its title.
 *
 * @param title - The window title to dismiss.
 */
async function dismissDialogByTitle(title: string): Promise<void> {
  if (process.platform === 'win32') {
    await dismissDialogWindows(title);
  } else if (process.platform === 'darwin') {
    await dismissDialogMac(title);
  } else {
    await dismissDialogLinux(title);
  }
}

/**
 * Dismisses a dialog on Linux via xdotool.
 *
 * @param title - The window title to dismiss.
 */
async function dismissDialogLinux(title: string): Promise<void> {
  const escapedTitle = title.replace(/"/g, '\\"');
  await exec(
    `xdotool search --name "${escapedTitle}" windowactivate --sync key Return 2>/dev/null || true`,
    { isQuiet: true }
  );
}

/**
 * Dismisses a dialog on macOS via AppleScript.
 *
 * @param title - The window title to dismiss.
 */
async function dismissDialogMac(title: string): Promise<void> {
  const escapedTitle = title.replace(/"/g, '\\"');
  await exec(
    `osascript -e 'tell application "System Events" to tell process "Obsidian" to click button 1 of window "${escapedTitle}"'`,
    { isQuiet: true }
  );
}

/**
 * Dismisses a dialog on Windows by sending WM_CLOSE via Win32 API.
 *
 * @param title - The window title to dismiss.
 */
async function dismissDialogWindows(title: string): Promise<void> {
  const escapedTitle = title.replace(/'/g, '\'\'');
  const script = [
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices;',
    'public class DlgClose {',
    '  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);',
    '  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);',
    '}',
    '"@',
    `$h = [DlgClose]::FindWindow($null, '${escapedTitle}')`,
    'if ($h -ne [IntPtr]::Zero) { [DlgClose]::SendMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }'
  ].join('; ');
  await exec(`powershell -Command "${script}"`, { isQuiet: true });
}

/**
 * Returns window titles of all Obsidian process windows.
 *
 * @returns An array of window title strings.
 */
async function getObsidianWindowTitles(): Promise<string[]> {
  if (process.platform === 'win32') {
    return getWindowTitlesWindows();
  }

  if (process.platform === 'darwin') {
    return getWindowTitlesMac();
  }

  return getWindowTitlesLinux();
}

/**
 * Returns Obsidian window titles on Linux via xdotool.
 *
 * @returns An array of window title strings.
 */
async function getWindowTitlesLinux(): Promise<string[]> {
  const output = await exec(
    'xdotool search --name "Obsidian" getwindowname 2>/dev/null || true',
    { isQuiet: true }
  );
  return output.trim().split('\n').filter(Boolean);
}

/**
 * Returns Obsidian window titles on macOS via AppleScript.
 *
 * @returns An array of window title strings.
 */
async function getWindowTitlesMac(): Promise<string[]> {
  const output = await exec(
    'osascript -e \'tell application "System Events" to get name of every window of (processes whose name is "Obsidian")\'',
    { isQuiet: true }
  );
  return output.trim().split(', ').filter(Boolean);
}

/**
 * Returns Obsidian window titles on Windows via Get-Process.
 *
 * @returns An array of window title strings.
 */
async function getWindowTitlesWindows(): Promise<string[]> {
  const output = await exec(
    'powershell -Command "Get-Process Obsidian -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne \'\' } | Select-Object -ExpandProperty MainWindowTitle"',
    { isQuiet: true }
  );
  return output.trim().split('\n').map((line) => line.trim()).filter(Boolean);
}

/* v8 ignore stop */
