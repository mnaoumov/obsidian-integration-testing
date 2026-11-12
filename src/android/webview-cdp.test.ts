import {
  describe,
  expect,
  it
} from 'vitest';

import { strictProxy } from '../strict-proxy.ts';
import {
  parseForwardedPort,
  parseWebViewDevtoolsSocketName,
  selectWebViewPageTarget,
  WebViewCdpConnection
} from './webview-cdp.ts';

const ABNORMAL_CLOSE_CODE = 1006;

/**
 * A stand-in for the debugger socket: a settable `readyState`, a record of what was sent, and listeners it
 * can fire by hand.
 */
class FakeWebSocket {
  public readyState: number = WebSocket.OPEN;
  public readonly sent: string[] = [];
  private readonly listeners = new Map<string, (($event: Event) => void)[]>();

  public addEventListener(type: string, listener: ($event: Event) => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }

  public dispatchEvent($event: Event): void {
    for (const listener of this.listeners.get($event.type) ?? []) {
      listener($event);
    }
  }

  public send(data: string): void {
    this.sent.push(data);
  }
}

function createConnection(fakeWebSocket: FakeWebSocket): WebViewCdpConnection {
  return new WebViewCdpConnection(strictProxy<WebSocket>(fakeWebSocket), 'emulator-5554', 0);
}

describe('WebViewCdpConnection', () => {
  it('should resolve a command with its reply', async () => {
    const fakeWebSocket = new FakeWebSocket();
    const connection = createConnection(fakeWebSocket);
    const result = connection.send('Runtime.evaluate');
    fakeWebSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 1, result: { value: 2 } }) }));
    await expect(result).resolves.toEqual({ value: 2 });
  });

  it('should reject every command in flight when the socket closes', async () => {
    const fakeWebSocket = new FakeWebSocket();
    const connection = createConnection(fakeWebSocket);
    const first = connection.send('Input.dispatchTouchEvent');
    const second = connection.send('Runtime.evaluate');
    fakeWebSocket.readyState = WebSocket.CLOSED;
    fakeWebSocket.dispatchEvent(new CloseEvent('close', { code: ABNORMAL_CLOSE_CODE }));
    await expect(first).rejects.toThrow('WebView CDP socket closed (code 1006) before the command was answered');
    await expect(second).rejects.toThrow('WebView CDP socket closed (code 1006) before the command was answered');
  });

  it('should refuse a send on a socket that is not open', async () => {
    const fakeWebSocket = new FakeWebSocket();
    fakeWebSocket.readyState = WebSocket.CLOSING;
    const connection = createConnection(fakeWebSocket);
    await expect(connection.send('Runtime.evaluate')).rejects.toThrow(
      'WebView CDP socket is not open (readyState 2); Runtime.evaluate was not sent'
    );
    expect(fakeWebSocket.sent).toEqual([]);
  });
});

describe('parseForwardedPort', () => {
  const FORWARD_LIST = [
    'emulator-5554 tcp:49630 localabstract:webview_devtools_remote_18056',
    'emulator-5554 tcp:8200 tcp:6790',
    'emulator-5556 tcp:49999 localabstract:webview_devtools_remote_18056'
  ].join('\n');

  it('should reuse the port already forwarded to this socket on this device', () => {
    expect(parseForwardedPort(FORWARD_LIST, 'emulator-5554', 'webview_devtools_remote_18056')).toBe(49_630);
  });

  it('should not match the same socket on a different device', () => {
    expect(parseForwardedPort(FORWARD_LIST, 'emulator-5555', 'webview_devtools_remote_18056')).toBeNull();
  });

  it('should not match a different socket on the same device', () => {
    expect(parseForwardedPort(FORWARD_LIST, 'emulator-5554', 'webview_devtools_remote_999')).toBeNull();
  });

  it('should ignore non-localabstract forwards, such as Appium own tcp pairs', () => {
    expect(parseForwardedPort(FORWARD_LIST, 'emulator-5554', 'tcp:6790')).toBeNull();
  });

  it('should return null when nothing is forwarded yet', () => {
    expect(parseForwardedPort('', 'emulator-5554', 'webview_devtools_remote_18056')).toBeNull();
  });

  it('should tolerate the padded and CRLF-terminated output adb actually prints', () => {
    const padded = '  emulator-5554   tcp:49630   localabstract:webview_devtools_remote_18056  \r\n';

    expect(parseForwardedPort(padded, 'emulator-5554', 'webview_devtools_remote_18056')).toBe(49_630);
  });

  it('should skip a matching row whose port is not a number, rather than forward to NaN', () => {
    const malformed = [
      'emulator-5554 tcp:not-a-port localabstract:webview_devtools_remote_18056',
      'emulator-5554 tcp:49630 localabstract:webview_devtools_remote_18056'
    ].join('\n');

    expect(parseForwardedPort(malformed, 'emulator-5554', 'webview_devtools_remote_18056')).toBe(49_630);
  });
});

/**
 * A realistic `/proc/net/unix` excerpt: the columns are irrelevant, only the `@`-prefixed abstract socket
 * names matter, and every name appears on several rows (one per connection state).
 */
function procNetUnix(...socketNames: string[]): string {
  const header = 'Num       RefCount Protocol Flags    Type St Inode Path\n';
  const noise = '0000000000000000: 00000002 00000000 00010000 0001 01 12345 /dev/socket/property_service\n';
  const rows = socketNames.flatMap((name) => [
    `0000000000000000: 00000002 00000000 00010000 0001 01 22222 @${name}\n`,
    `0000000000000000: 00000003 00000000 00000000 0001 03 33333 @${name}\n`
  ]);

  return header + noise + rows.join('');
}

describe('parseWebViewDevtoolsSocketName', () => {
  it('should pick the socket named after the application pid', () => {
    const contents = procNetUnix('webview_devtools_remote_4321', 'webview_devtools_remote_18056');

    expect(parseWebViewDevtoolsSocketName(contents, '18056')).toBe('webview_devtools_remote_18056');
  });

  it('should deduplicate the repeated rows one socket produces', () => {
    const contents = procNetUnix('webview_devtools_remote_18056');

    expect(parseWebViewDevtoolsSocketName(contents, '18056')).toBe('webview_devtools_remote_18056');
  });

  it('should fall back to the only candidate when it is not named after the reported pid', () => {
    const contents = procNetUnix('webview_devtools_remote_18099');

    expect(parseWebViewDevtoolsSocketName(contents, '18056')).toBe('webview_devtools_remote_18099');
  });

  it('should refuse to guess between several unattributable candidates', () => {
    const contents = procNetUnix('webview_devtools_remote_111', 'webview_devtools_remote_222');

    expect(() => parseWebViewDevtoolsSocketName(contents, '18056'))
      .toThrow('2 other debuggable WebViews are present');
  });

  it('should say the app is not running when there is no devtools socket at all', () => {
    expect(() => parseWebViewDevtoolsSocketName(procNetUnix(), '18056'))
      .toThrow('No `webview_devtools_remote_*` socket on the device');
  });

  it('should ignore other abstract sockets', () => {
    const contents = `${procNetUnix('webview_devtools_remote_18056')}0000000000000000: 00000002 00000000 00010000 0001 01 44444 @chrome_devtools_remote\n`;

    expect(parseWebViewDevtoolsSocketName(contents, '18056')).toBe('webview_devtools_remote_18056');
  });
});

describe('selectWebViewPageTarget', () => {
  it('should prefer a page target', () => {
    const target = selectWebViewPageTarget([
      { type: 'service_worker', webSocketDebuggerUrl: 'ws://worker' },
      { title: 'Obsidian', type: 'page', webSocketDebuggerUrl: 'ws://page' }
    ]);

    expect(target.webSocketDebuggerUrl).toBe('ws://page');
  });

  it('should skip a page target that exposes no WebSocket endpoint', () => {
    const target = selectWebViewPageTarget([
      { title: 'already attached', type: 'page' },
      { type: 'other', webSocketDebuggerUrl: 'ws://other' }
    ]);

    expect(target.webSocketDebuggerUrl).toBe('ws://other');
  });

  it('should throw when nothing is attachable', () => {
    expect(() => selectWebViewPageTarget([{ title: 'already attached', type: 'page' }]))
      .toThrow('listed no target with a WebSocket endpoint');
  });

  it('should throw on an empty target list', () => {
    expect(() => selectWebViewPageTarget([])).toThrow('listed no target with a WebSocket endpoint');
  });
});
