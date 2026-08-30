import {
  describe,
  expect,
  it
} from 'vitest';

import {
  parseForwardedPort,
  parseWebViewDevtoolsSocketName,
  selectWebViewPageTarget
} from './webview-cdp.ts';

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
    expect(parseForwardedPort(FORWARD_LIST, 'emulator-5555', 'webview_devtools_remote_18056')).toBeUndefined();
  });

  it('should not match a different socket on the same device', () => {
    expect(parseForwardedPort(FORWARD_LIST, 'emulator-5554', 'webview_devtools_remote_999')).toBeUndefined();
  });

  it('should ignore non-localabstract forwards, such as Appium own tcp pairs', () => {
    expect(parseForwardedPort(FORWARD_LIST, 'emulator-5554', 'tcp:6790')).toBeUndefined();
  });

  it('should return undefined when nothing is forwarded yet', () => {
    expect(parseForwardedPort('', 'emulator-5554', 'webview_devtools_remote_18056')).toBeUndefined();
  });

  it('should tolerate the padded and CRLF-terminated output adb actually prints', () => {
    const padded = '  emulator-5554   tcp:49630   localabstract:webview_devtools_remote_18056  \r\n';

    expect(parseForwardedPort(padded, 'emulator-5554', 'webview_devtools_remote_18056')).toBe(49_630);
  });
});

/**
 * A realistic `/proc/net/unix` excerpt: the columns are irrelevant, only the `@`-prefixed abstract socket
 * names matter, and every name appears on several rows (one per connection state).
 */
function procNetUnix(...socketNames: string[]): string {
  const header = 'Num       RefCount Protocol Flags    Type St Inode Path\n';
  const noise = '0000000000000000: 00000002 00000000 00010000 0001 01 12345 /dev/socket/logdw\n';
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
