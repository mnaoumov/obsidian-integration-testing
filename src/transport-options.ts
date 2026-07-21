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
   * Timeout in milliseconds for waiting, after `sys.boot_completed`, for a
   * harness-started emulator to become idle before the Appium session is
   * established.
   *
   * `sys.boot_completed` fires *before* the guest is actually idle: package
   * optimization and system services keep churning, so establishing the session
   * immediately makes every one of UiAutomator2's serialized `adb` round-trips
   * contend with that work and inflates session establishment ~3x. The factory
   * instead waits until the boot animation has stopped and the package manager
   * is serving, proceeding early once idle or after this budget (best-effort — a
   * timeout logs a warning and proceeds). Set `0` to skip the wait. Only applies
   * to a harness-started emulator, not a reused one.
   *
   * @default `60000`
   */
  readonly deviceIdleTimeoutInMilliseconds?: number;

  /**
   * Whether the auto-started Appium server console window is shown.
   *
   * When `false` (the default), the `npx appium` server process is spawned with
   * its console window hidden (`windowsHide`) and its output discarded, so it
   * neither steals focus nor writes to the invoking terminal. Ignored when
   * attaching to an already-running Appium server ({@link shouldAutoStartAppium}
   * `false`, or the server already reachable). Set `true` to see the server log window
   * and its live output.
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
   * Number of extra attempts to enable the plugin and verify it loaded, on top
   * of the first attempt.
   *
   * On a freshly cold-booted emulator the plugin subsystem can still be settling
   * when the harness enables the plugin, so the enable lands in the enabled set
   * but the load races and fails (`"<id>" is in the enabled set but not loaded`).
   * Device-idle and `layoutReady` are already awaited, so this is the narrow
   * residual race: the harness retries the enable + load-verification this many
   * times with exponential backoff (see
   * {@link pluginEnableRetryDelayInMilliseconds}), forcing a genuine reload each
   * attempt. A captured plugin load error is treated as a deterministic bug and
   * is **not** retried. Set `0` to disable retry (a single attempt).
   *
   * @default `3`
   */
  readonly pluginEnableRetryCount?: number;

  /**
   * Base delay in milliseconds between plugin-enable attempts (see
   * {@link pluginEnableRetryCount}).
   *
   * The delay grows exponentially per retry: the first retry waits this long,
   * the second twice as long, the third four times, and so on — giving a
   * still-settling cold guest progressively more time to become ready.
   *
   * @default `2000`
   */
  readonly pluginEnableRetryDelayInMilliseconds?: number;

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
   * Whether to automatically install missing Appium dependencies (the
   * `uiautomator2` driver, and Appium itself) before auto-starting the server.
   *
   * When `true` (the default) and the harness is about to auto-start the Appium
   * server ({@link shouldAutoStartAppium}), the factory first ensures Appium is
   * installed (globally, via `npm install -g appium`) and that the
   * `uiautomator2` driver is installed (`appium driver install uiautomator2`),
   * installing whichever is missing. Ignored when attaching to an
   * already-running server (nothing is auto-started, so nothing is installed) or
   * when {@link shouldAutoStartAppium} is `false`. Set it to `false` to manage
   * the Appium toolchain yourself and skip the machine-mutating global install.
   *
   * @default `true`
   */
  readonly shouldAutoInstallAppiumDependencies?: boolean;

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
   * Grace window in milliseconds for fast-failing a **dead boot** of the owned
   * instance.
   *
   * When an asar cannot run on the launched Electron shell (the installer
   * version is too old for the app version), the renderer loads but never
   * bootstraps: `document.body` stays empty and `window.app` remains
   * `undefined` — a black screen. Rather than waiting out the full readiness
   * timeout, the owned-vault readiness poll concludes the boot is dead once the
   * renderer has been `document.readyState` `'complete'` for this long with no
   * `window.app` and an empty `<body>`, and throws a
   * `RendererFailedToInitializeError`. Only applies to an owned instance
   * (ignored in attach mode, {@link port} set). Set `0` to disable fast-fail and
   * restore the plain wait-out-the-readiness-timeout behavior.
   *
   * @default `10000`
   */
  readonly deadBootGraceInMilliseconds?: number;

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
   * When `false`, the harness launches the owned instance with
   * keep-alive Chromium flags and moves its window **off-screen** once Electron's
   * remote bridge is available, so the run never steals focus or pops a window in
   * front of you. Off-screen (not minimized) keeps the renderer live, so
   * `setTimeout`, `requestAnimationFrame`, `:hover`, and trusted input behave
   * identically to a visible window. Defaults to `true`; integration setup
   * explicitly passes `false` to avoid stealing focus. Ignored in attach mode
   * ({@link port} set) — the harness never
   * moves the user's own running window.
   *
   * @default `true`
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
   * Whether to launch the owned instance with Chromium's sandbox disabled
   * (`--no-sandbox`).
   *
   * Needed to boot an owned instance on Linux when there is no
   * correctly-configured setuid `chrome-sandbox` helper — e.g. a portable shell
   * extracted from an installer, or a CI runner launching as a non-root user, in
   * which case the renderer otherwise refuses to start. Harmless on
   * Windows/macOS. Ignored in attach mode ({@link port} set) — the harness never
   * relaunches the user's running instance.
   *
   * @default `false`
   */
  readonly shouldDisableSandbox?: boolean;

  /**
   * Whether an **unrunnable** installer↔app version pair fails fast before launch.
   *
   * When `true` (the default), an installer below the app's run floor (the
   * oldest installer the app's asar can boot on) throws
   * `IncompatibleInstallerVersionError` from version resolution, before anything
   * is downloaded or launched. Set `false` to let the pin proceed to launch
   * instead — where the reactive dead-boot fast-fail
   * (`RendererFailedToInitializeError`, see {@link deadBootGraceInMilliseconds})
   * still catches the black-screen boot, and the `'unrunnable'` verdict is
   * surfaced as data rather than thrown. Only applies to an owned instance
   * (ignored in attach mode, {@link port} set).
   *
   * @default `true`
   */
  readonly shouldThrowOnIncompatibleInstaller?: boolean;

  /**
   * Whether a **silent asar fallback** fails fast after boot.
   *
   * When an asar is swapped onto an installer shell too old for it, the instance
   * may not dead-boot — it can silently revert to the installer's own bundled
   * asar and run the **wrong (older)** version behind a healthy UI. When `true`
   * (the default), the transport verifies the running app version against the pin
   * post-boot and throws `SilentAsarFallbackError` on a mismatch. Set `false` to
   * let the boot proceed — the mismatch is then surfaced as data (the fallback
   * verdict) rather than thrown. Only applies to an owned instance running a
   * swapped-in asar (ignored in attach mode, {@link port} set, and when no asar is
   * swapped — there is nothing to verify).
   *
   * @default `true`
   */
  readonly shouldThrowOnSilentAsarFallback?: boolean;

  /**
   * Whether the owned-instance compatibility **nag warnings** are emitted.
   *
   * Covers **both** compatibility nags: the offline installer↔app warning (a
   * runnable installer below the recommended floor) and the post-boot
   * runtime-Electron warning (a live Electron below the app's recommended
   * minimum). When `true` (the default) each fires via the harness log; set
   * `false` to silence both — the verdicts are still computed and surfaced as
   * data (`compatibility` / `electronCompatibility`), only the log is suppressed.
   * Does not affect the `'unrunnable'` throw (see
   * {@link shouldThrowOnIncompatibleInstaller}). Only applies to an owned
   * instance (ignored in attach mode, {@link port} set).
   *
   * @default `true`
   */
  readonly shouldWarnOnCompatibilityIssues?: boolean;

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
