---
title: Ad-hoc debugging
description: Drive a real Obsidian from a throwaway script or the REPL with `connectToCdp`, or from the shell with the bundled CLI.
sidebar:
    order: 9
---

Outside a test framework, `connectToCdp()` launches (or attaches to) a `CDP` Obsidian instance, opens a
vault, bootstraps the runtime helpers, and returns a disposable connection — handy for reproducing
behavior in a real Obsidian from a throwaway script or the REPL.

```ts
import { connectToCdp } from 'obsidian-integration-testing';

// Owns an isolated instance + an empty temp vault (both cleaned up on dispose).
await using conn = await connectToCdp();

console.log(conn.port, conn.cdpUrl); // the free CDP port the instance was launched on

// Raw expression → normalized string result:
await conn.invoke('app.vault.getName()');

// Rich, typed path — `callback` runs in the Obsidian renderer with { app, obsidianModule, lib, context }:
await conn.evalInObsidian({ callback: ({ app }) => app.workspace.getActiveFile()?.path ?? null });
```

## Options

`connectToCdp` accepts the same version knobs as the transport (`obsidianVersion`,
`obsidianInstallerVersion`, `host`, `commandTimeoutInMilliseconds`, all defaulting to your installed
Obsidian), plus:

- **`vault`** — path to an existing vault to open. When omitted, an empty temporary vault is created.
- **`isObsidianAppVisible`** — whether the window is shown (default `true`). Set `false` to launch it
  off-screen.
- **`port`** — attach to an already-running Obsidian on this `CDP` port instead of owning an instance, as
  in [Attach to a running Obsidian](/obsidian-integration-testing/guides/transports/#attach-to-a-running-obsidian).
- **`deadBootGraceInMilliseconds`** (default `10000`) — fast-fail with a `RendererFailedToInitializeError`
  when a pinned version pair produces a
  [dead boot](/obsidian-integration-testing/guides/transports/#dead-boot-fast-fail); `0` disables it.
- **`shouldRemoveVaultOnDispose`** — whether `dispose()` removes the vault directory. Defaults to `true`
  for an implicit temp vault and `false` when a `vault` path is given, so a **real vault is never
  auto-deleted**. Set it explicitly to override.

:::caution
Opening a **real** vault in the owned instance may write to that vault's `.obsidian` config — normal
Obsidian behavior. The vault directory itself is never deleted unless `shouldRemoveVaultOnDispose` is
`true`.
:::

## CLI

The package ships an `obsidian-integration-testing` bin that wraps `connectToCdp`, prints the chosen
port/URL, and stays alive until `Ctrl+C` — useful when an external tool (raw `CDP` `ws`, DevTools) needs to
attach to a printed port:

```bash
npx obsidian-integration-testing --vault F:/path/to/vault --obsidian-version 1.8.10
```

Flags mirror the options above: `--vault`, `--obsidian-version`, `--obsidian-installer-version`, `--port`,
`--host`, `--command-timeout`, and `--no-remove-vault` (keep the temp vault on exit).

## Related

- [`connectToCdp` API reference](/obsidian-integration-testing/api/connect-to-cdp/connectToCdp/)
- [`CdpConnection` API reference](/obsidian-integration-testing/api/connect-to-cdp/CdpConnection/)
- [Transport modes](/obsidian-integration-testing/guides/transports/)
