/**
 * @file
 *
 * A second, independent Chrome DevTools Protocol connection to Obsidian Mobile's WebView, used to inject
 * **trusted** input on Android (see **L39**).
 *
 * It is deliberately separate from the Appium session rather than layered on it. `AppiumTransport.evaluate`
 * runs the whole `evalInObsidian` closure inside one W3C *Execute Script*, which awaits the returned
 * promise — so while a closure sits waiting on `lib.clickElement(...)`, the WebDriver session is busy and
 * cannot be asked to do anything else. CDP is id-multiplexed and Chromium accepts multiple debugger
 * clients, so this socket stays free exactly when the Appium one does not. That is what lets the renderer
 * call back out to the host mid-closure.
 *
 * Reaching the WebView's debugger is a two-step: the app publishes an abstract unix socket named
 * `webview_devtools_remote_<pid>`, `adb forward` maps it to a local TCP port, and the usual `/json`
 * endpoint then lists the page targets.
 */

import { execFileSync } from 'node:child_process';

import type { CdpInputCommand } from './mobile-input.ts';

import { exec } from './exec.ts';
import { log } from './log.ts';
import { pickFreePort } from './obsidian-instance.ts';

const ADB_TIMEOUT_IN_MILLISECONDS = 15_000;
// `adb forward --list` prints three columns: `<deviceId> tcp:<port> localabstract:<socketName>`.
const FORWARD_LIST_COLUMN_COUNT = 3;
const DECIMAL_RADIX = 10;
const CDP_COMMAND_TIMEOUT_IN_MILLISECONDS = 30_000;
const CDP_HOST = '127.0.0.1';

/**
 * One entry of the debugger's `/json` target list.
 */
export interface CdpTarget {
  readonly title?: string;
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

/**
 * Parameters for {@link connectToWebViewCdp}.
 */
export interface ConnectToWebViewCdpParams {
  /**
   * The Android application id whose WebView to attach to, e.g. `md.obsidian`.
   */
  readonly appId: string;

  /**
   * The adb device id (`emulator-5554`, a serial) to run adb against.
   */
  readonly deviceId: string;
}

/**
 * The error half of a failed CDP command response.
 */
interface CdpError {
  readonly message?: string;
}

/**
 * Handles a CDP event.
 */
type CdpEventHandler = (params: Record<string, unknown>) => void;

/**
 * A CDP message: either a response to a command (`id`) or an event (`method`).
 */
interface CdpMessage {
  readonly error?: CdpError;
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
}

/**
 * An open CDP connection to a WebView.
 *
 * Commands are id-multiplexed, so a command issued from inside an event handler completes while an earlier
 * `Runtime.evaluate` is still awaiting its promise — which is the whole reason this class exists.
 */
export class WebViewCdpConnection {
  /**
   * Whether the socket is still usable.
   *
   * Restarting the app tears its WebView down and takes the debugger target with it, so a cached
   * connection has to be re-checked rather than assumed live.
   *
   * @returns `true` while the socket is open.
   */
  public get isOpen(): boolean {
    return this.webSocket.readyState === WebSocket.OPEN;
  }

  private readonly eventHandlers = new Map<string, CdpEventHandler>();

  private messageId = 0;

  /**
   * Wraps an already-open debugger socket, plus what is needed to tear its port forward down.
   *
   * @param webSocket - The open debugger socket.
   * @param deviceId - The adb device id, needed to drop the port forward on dispose.
   * @param port - The forwarded local port.
   */
  public constructor(private readonly webSocket: WebSocket, private readonly deviceId: string, private readonly port: number) {
    this.webSocket.addEventListener('message', (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.method === undefined) {
        return;
      }

      this.eventHandlers.get(message.method)?.(message.params ?? {});
    });
  }

  /**
   * Closes the socket and drops the adb port forward.
   */
  public async dispose(): Promise<void> {
    this.closeSocket();
    await removeForward(this.deviceId, this.port);
  }

  /**
   * Synchronous disposal, for `process.on('exit')` handlers where async work cannot run.
   *
   * Without this an abrupt worker exit leaves the port forward behind — the async {@link dispose} above
   * never gets a turn.
   */
  public disposeSync(): void {
    this.closeSocket();
    try {
      execFileSync('adb', ['-s', this.deviceId, 'forward', '--remove', `tcp:${String(this.port)}`], {
        stdio: 'ignore',
        timeout: ADB_TIMEOUT_IN_MILLISECONDS
      });
    } catch {
      // Best effort: adb drops every forward when the device disconnects anyway.
    }
  }

  /**
   * Subscribes to a CDP event. One handler per method; subscribing again replaces it.
   *
   * @param method - The CDP event name, e.g. `Runtime.bindingCalled`.
   * @param handler - Called with the event parameters.
   */
  public on(method: string, handler: CdpEventHandler): void {
    this.eventHandlers.set(method, handler);
  }

  /**
   * Sends a CDP command and waits for its response.
   *
   * @param method - The CDP method name.
   * @param params - The CDP method parameters.
   * @returns The command result.
   */
  public send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.messageId;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.webSocket.removeEventListener('message', handler);
        reject(new Error(`WebView CDP command timed out after ${String(CDP_COMMAND_TIMEOUT_IN_MILLISECONDS)}ms: ${method}`));
      }, CDP_COMMAND_TIMEOUT_IN_MILLISECONDS);

      const handler = (event: MessageEvent): void => {
        const message = JSON.parse(String(event.data)) as CdpMessage;
        if (message.id !== id) {
          return;
        }

        clearTimeout(timeout);
        this.webSocket.removeEventListener('message', handler);
        if (message.error) {
          reject(new Error(`WebView CDP command ${method} failed: ${message.error.message ?? 'unknown error'}`));
          return;
        }

        resolve(message.result ?? {});
      };

      this.webSocket.addEventListener('message', handler);
      this.webSocket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Sends an ordered command sequence, honoring each command's delay.
   *
   * @param commands - The commands to send, in order.
   */
  public async sendAll(commands: readonly CdpInputCommand[]): Promise<void> {
    for (const command of commands) {
      if (command.delayBeforeInMilliseconds !== undefined) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, command.delayBeforeInMilliseconds);
        });
      }

      await this.send(command.method, command.params);
    }
  }

  /**
   * Closes the debugger socket and stops routing its events.
   */
  private closeSocket(): void {
    this.eventHandlers.clear();
    if (this.webSocket.readyState === WebSocket.OPEN) {
      this.webSocket.close();
    }
  }
}

/**
 * Opens a CDP connection to the app's WebView.
 *
 * @param params - Which app on which device.
 * @returns The open connection. Dispose it to close the socket and drop the adb port forward.
 */
export async function connectToWebViewCdp(params: ConnectToWebViewCdpParams): Promise<WebViewCdpConnection> {
  const { appId, deviceId } = params;

  // `pidof` lists every matching process; the app's main one is first.
  const pidofOutput = await adb(deviceId, ['shell', 'pidof', appId]);
  const pid = pidofOutput.split(/\s+/, 1)[0] ?? '';
  if (!pid) {
    throw new Error(`${appId} is not running on ${deviceId}, so its WebView has no debugger to attach to.`);
  }

  const procNetUnix = await adb(deviceId, ['shell', 'cat', '/proc/net/unix']);
  const socketName = parseWebViewDevtoolsSocketName(procNetUnix, pid);

  const forwardList = await adb(deviceId, ['forward', '--list']);
  const existingPort = parseForwardedPort(forwardList, deviceId, socketName);
  const port = existingPort ?? await pickFreePort();
  if (existingPort === undefined) {
    await adb(deviceId, ['forward', `tcp:${String(port)}`, `localabstract:${socketName}`]);
    log(`[webview-cdp] Forwarded tcp:${String(port)} -> localabstract:${socketName} (${appId} pid ${pid})`);
  } else {
    log(`[webview-cdp] Reusing forward tcp:${String(port)} -> localabstract:${socketName} (${appId} pid ${pid})`);
  }

  try {
    const response = await fetch(`http://${CDP_HOST}:${String(port)}/json`);
    const target = selectWebViewPageTarget(await response.json() as CdpTarget[]);
    const webSocket = new WebSocket(target.webSocketDebuggerUrl ?? '');
    await new Promise<void>((resolve, reject) => {
      webSocket.addEventListener('open', () => {
        resolve();
      }, { once: true });
      webSocket.addEventListener('error', () => {
        reject(new Error(`Could not open the WebView CDP socket at ${target.webSocketDebuggerUrl ?? ''}.`));
      }, { once: true });
    });
    log(`[webview-cdp] Attached to WebView target "${target.title ?? ''}"`);

    return new WebViewCdpConnection(webSocket, deviceId, port);
  } catch (error: unknown) {
    await removeForward(deviceId, port);
    throw error;
  }
}

/* v8 ignore start -- Integration-time code (adb, sockets, a live WebView). The pure helpers above are unit-tested; this half is covered by the Android integration tests. */

/**
 * Finds a port already forwarded to this device socket, so repeated runs reuse one forward.
 *
 * Without this every run allocates a fresh port, and any run that exits without the async
 * {@link WebViewCdpConnection.dispose} — an abrupt worker exit, where only the synchronous teardown
 * path runs — leaves its forward behind forever. Reuse bounds that to a single forward per socket
 * rather than one per run.
 *
 * @param forwardList - The output of `adb forward --list`.
 * @param deviceId - The adb device id to match.
 * @param socketName - The abstract socket name to match.
 * @returns The already-forwarded local port, or `undefined` when there is none.
 */
export function parseForwardedPort(forwardList: string, deviceId: string, socketName: string): number | undefined {
  for (const line of forwardList.split('\n')) {
    // `adb forward --list` prints `<deviceId> tcp:<port> localabstract:<socketName>`.
    const [lineDeviceId, local, remote] = line.trim().split(/\s+/, FORWARD_LIST_COLUMN_COUNT);
    if (lineDeviceId !== deviceId || remote !== `localabstract:${socketName}` || !local?.startsWith('tcp:')) {
      continue;
    }

    const port = Number.parseInt(local.slice('tcp:'.length), DECIMAL_RADIX);
    if (Number.isSafeInteger(port)) {
      return port;
    }
  }

  return undefined;
}

/**
 * Picks the WebView's devtools socket name out of `/proc/net/unix`.
 *
 * A device can host several debuggable WebViews (other apps, a leftover process), so the app's own pid is
 * what disambiguates them. When no socket matches that pid the sole remaining candidate is used — a
 * WebView whose socket is named after a child process rather than the one `pidof` reported still has to be
 * reachable — but two unattributable candidates is ambiguous enough to refuse.
 *
 * @param procNetUnix - The contents of `/proc/net/unix`.
 * @param pid - The application's process id.
 * @returns The socket name, e.g. `webview_devtools_remote_18056`.
 */
export function parseWebViewDevtoolsSocketName(procNetUnix: string, pid: string): string {
  const names = [
    ...new Set([...procNetUnix.matchAll(/@(?<name>webview_devtools_remote_\w+)/g)]
      .map((match) => match.groups?.['name'] ?? ''))
  ].filter(Boolean);

  if (names.length === 0) {
    throw new Error(
      'No `webview_devtools_remote_*` socket on the device. Obsidian Mobile is not running, or its WebView '
        + 'debugger is disabled.'
    );
  }

  const exactName = `webview_devtools_remote_${pid}`;
  if (names.includes(exactName)) {
    return exactName;
  }

  if (names.length === 1) {
    return names[0] ?? '';
  }

  throw new Error(
    `No \`${exactName}\` socket, and ${String(names.length)} other debuggable WebViews are present `
      + `(${names.join(', ')}), so the right one cannot be chosen.`
  );
}

/**
 * Picks the Obsidian page target out of the debugger's `/json` list.
 *
 * @param targets - The `/json` response.
 * @returns The page target to attach to.
 */
export function selectWebViewPageTarget(targets: readonly CdpTarget[]): CdpTarget {
  const target = targets.find((candidate) => candidate.type === 'page' && Boolean(candidate.webSocketDebuggerUrl))
    ?? targets.find((candidate) => Boolean(candidate.webSocketDebuggerUrl));

  if (!target) {
    throw new Error('The WebView debugger listed no target with a WebSocket endpoint.');
  }

  return target;
}

/**
 * Runs an adb command against one device.
 *
 * @param deviceId - The adb device id.
 * @param commandArguments - The adb arguments after `-s <deviceId>`.
 * @returns Trimmed stdout.
 */
async function adb(deviceId: string, commandArguments: string[]): Promise<string> {
  const stdout = await exec(['adb', '-s', deviceId, ...commandArguments], {
    isQuiet: true,
    timeoutInMilliseconds: ADB_TIMEOUT_IN_MILLISECONDS
  });

  return stdout.trim();
}

/**
 * Drops an adb port forward, ignoring the "not found" case.
 *
 * @param deviceId - The adb device id.
 * @param port - The forwarded local port.
 */
async function removeForward(deviceId: string, port: number): Promise<void> {
  try {
    await exec(['adb', '-s', deviceId, 'forward', '--remove', `tcp:${String(port)}`], {
      isQuiet: true,
      shouldIgnoreExitCode: true,
      timeoutInMilliseconds: ADB_TIMEOUT_IN_MILLISECONDS
    });
  } catch {
    // Best effort: the forward is per-run and adb drops it when the device disconnects anyway.
  }
}

/* v8 ignore stop */
