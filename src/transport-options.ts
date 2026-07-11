/**
 * @file
 *
 * Discriminated union types for configuring the Obsidian transport
 * via vitest `environmentOptions`.
 */

/**
 * Transport options for Android testing via Appium WebView injection.
 */
export interface ObsidianAndroidAppiumTransportOptions {
  /**
   * App package (Android) or bundle ID (iOS).
   * Defaults to `'md.obsidian'`
   */
  readonly appId?: string;

  /**
   * Timeout in milliseconds for the auto-started Appium server to become ready
   * (its `/status` endpoint to respond).
   *
   * Only applies when the harness auto-starts the Appium server
   * ({@link shouldAutoStartAppium}); ignored when attaching to an
   * already-running server. On a cold machine the `npx appium` server can take
   * a while to finish booting, so raise this if startup times out.
   *
   * @default `180000`
   */
  readonly appiumStartTimeoutInMilliseconds?: number;

  /**
   * The Appium server URL (e.g. `'http://localhost:4723'`).
   */
  readonly appiumUrl: string;

  /**
   * The Android AVD (Android Virtual Device) name.
   *
   * The transport factory launches `emulator -avd <avdName>` as a background
   * process and polls until the device appears. The emulator is killed
   * on transport disposal.
   *
   * Run `emulator -list-avds` to see available AVD names.
   */
  readonly avdName: string;

  /**
   * The device UDID to reuse (e.g. `'emulator-5554'`).
   *
   * Populated automatically by the global setup after the Appium session is
   * established. When present alongside {@link sessionId}, the transport
   * factory skips emulator startup and attaches to the existing session.
   */
  readonly deviceId?: string;

  /**
   * Whether the auto-started Appium server console window is shown.
   *
   * When `false` (the default), the `npx appium` server process is spawned with
   * its console window hidden (`windowsHide`), so it never steals focus. Ignored
   * when attaching to an already-running Appium server ({@link shouldAutoStartAppium}
   * `false`, or the server already reachable). Set `true` to see the server log window.
   *
   * @default `false`
   */
  readonly isAppiumConsoleVisible?: boolean;

  /**
   * Whether the auto-started Android emulator window is shown on screen.
   *
   * When `false` (the default), the emulator is started with `-no-window`
   * (headless), so it never steals focus. Ignored when reusing an already-running
   * device (nothing is launched to hide). Set `true` to watch the emulator UI.
   *
   * @default `false`
   */
  readonly isEmulatorVisible?: boolean;

  /**
   * Timeout in milliseconds for waiting for `app.workspace.layoutReady` after
   * the vault is (re)opened.
   *
   * Registering a vault triggers a full Obsidian re-init (`location.reload()`
   * reopens the vault and reloads every plugin — the heaviest startup step). On
   * a cold-booted or under-provisioned emulator that init can take a while, so
   * this budget is the largest of the transport timeouts. Raise it further if
   * releases still flake on slow CI emulators.
   *
   * @default `90000`
   */
  readonly layoutReadyTimeoutInMilliseconds?: number;

  /**
   * Timeout in milliseconds for establishing the Appium session (WebDriverIO
   * `remote()` — UiAutomator2 server install + app launch).
   *
   * This is the largest and most load-sensitive step of the Android setup:
   * on a cold or contended emulator it dominates startup and can take a few
   * minutes. Raise it if session establishment times out under load.
   *
   * @default `180000`
   */
  readonly sessionConnectionRetryTimeoutInMilliseconds?: number;

  /**
   * An existing Appium session ID to reattach to.
   *
   * Populated automatically by the global setup and provided to test workers
   * via the framework's context mechanism (e.g. Vitest `provide`/`inject`).
   * When present, the transport factory uses WebDriverIO's `attach()` instead
   * of creating a new session, avoiding duplicate Appium/ADB connections.
   */
  readonly sessionId?: string;

  /**
   * Whether to automatically start the Appium server if it is not reachable.
   *
   * When `true` (the default), the transport factory spawns `npx appium`
   * as a background process when the preflight check fails, and kills it
   * on transport disposal.
   *
   * @default `true`
   */
  readonly shouldAutoStartAppium?: boolean;

  /**
   * Discriminant for the transport type.
   */
  readonly type: 'obsidian-android-appium';

  /**
   * Base path on the device where Obsidian stores vaults.
   *
   * Defaults:
   * - Android: `/sdcard/Documents/`
   * - iOS: `@md.obsidian:documents/`
   */
  readonly vaultBasePath?: string;

  /**
   * Timeout in milliseconds for waiting for the WebView context to become available.
   *
   * On slow emulators, the ChromeDriver proxy that handles WebView commands
   * may not be ready immediately after the Appium session starts. This timeout
   * controls how long to poll before giving up.
   *
   * @default `60000`
   */
  readonly webviewTimeoutInMilliseconds?: number;
}

/**
 * Transport options for desktop testing via Chrome DevTools Protocol.
 *
 * This is the default desktop transport. By default the harness **launches and
 * owns an isolated Obsidian instance** in a temporary user-data dir (never
 * touching the user's Obsidian), connected over a free CDP port. Provide
 * {@link ObsidianCdpTransportOptions.port} to instead attach to an
 * already-running Obsidian.
 */
export interface ObsidianCdpTransportOptions {
  /**
   * Timeout in milliseconds for individual CDP commands.
   * Defaults to 30000
   */
  readonly commandTimeoutInMilliseconds?: number;

  /**
   * CDP host.
   * Defaults to `'localhost'`
   */
  readonly host?: string;

  /**
   * Marks {@link port} as the CDP port of a **harness-owned, isolated instance**
   * that the global setup already launched and prepared (vault registered,
   * plugin enabled).
   *
   * Populated automatically by the global setup and provided to test workers via
   * the framework's context mechanism (e.g. Vitest `provide`/`inject`). When set,
   * the worker **attaches** to the owned instance on {@link port} instead of
   * launching its own, and skips the user-scope vault-registration preflight —
   * the owned instance's vault lives in an isolated user-data config, not the
   * user-scope registry. Do not set this manually; for plain attach mode use
   * {@link port} alone.
   *
   * @default `undefined`
   */
  readonly isHarnessOwnedInstance?: boolean | undefined;

  /**
   * Whether the owned desktop Obsidian window is shown on screen.
   *
   * When `false` (the default), the harness launches the owned instance with
   * keep-alive Chromium flags and moves its window **off-screen** once Electron's
   * remote bridge is available, so the run never steals focus or pops a window in
   * front of you. Off-screen (not minimized) keeps the renderer live, so
   * `setTimeout`, `requestAnimationFrame`, `:hover`, and trusted input behave
   * identically to a visible window. Set `true` to watch the window (e.g. when
   * debugging). Ignored in attach mode ({@link port} set) — the harness never
   * moves the user's own running window.
   *
   * @default `false`
   */
  readonly isObsidianAppVisible?: boolean;

  /**
   * Pins the **Electron shell** (installer build) the owned instance runs.
   *
   * Accepts an explicit `'x.y.z'`, `'public-latest'`, or `'catalyst-latest'`.
   * The matching GitHub release installer is downloaded and extracted to a
   * portable shell (cached for reuse). Public releases only — catalyst builds
   * have no public installer. Ignored when {@link port} (attach mode) is set.
   *
   * @default `undefined`
   */
  readonly obsidianInstallerVersion?: string | undefined;

  /**
   * Pins the **Obsidian app version** (asar) the owned instance runs.
   *
   * Accepts an explicit `'x.y.z'`, `'public-latest'`, or `'catalyst-latest'`.
   * Versions at or above the shell version are applied as a cheap asar swap;
   * older versions transparently use the matching installer shell. When omitted,
   * the user's currently-installed version is used. Ignored when {@link port}
   * (attach mode) is set.
   *
   * @default `undefined`
   */
  readonly obsidianVersion?: string | undefined;

  /**
   * CDP port of an already-running Obsidian to **attach** to (the
   * `--remote-debugging-port` it was launched with). When set, the harness
   * attaches instead of owning an instance, and the version knobs are ignored.
   * When omitted, an owned isolated instance is launched on an automatically
   * chosen free port (no port is hardcoded).
   *
   * @default `undefined`
   */
  readonly port?: number;

  /**
   * Discriminant for the transport type.
   */
  readonly type: 'obsidian-cdp';
}

/**
 * Discriminated union of all supported transport configurations.
 *
 * Used in vitest `environmentOptions.obsidianTransport` to select and
 * configure the transport for integration tests.
 */
export type ObsidianTransportOptions =
  | ObsidianAndroidAppiumTransportOptions
  | ObsidianCdpTransportOptions;
