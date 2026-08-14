---
title: Leftover cleanup
description: What a run that dies mid-flight leaves behind, why it makes the next failure likelier, and how the sweeps deal with it.
sidebar:
    order: 8
---

A run that dies mid-flight cannot clean up after itself. On Android that is the normal case, not the
exception: teardown removes the vault through the WebView, and a dead WebView is exactly what most
failures are (`Vault cleanup error (non-fatal): no such window`). So every failure leaves a
`temp-vault-*` directory behind — and, worse, leaves it **registered**, which is work Obsidian has to redo
at every startup, inside the same WebView-readiness budget the run is already straining. Failures
therefore make the next failure likelier. One real emulator had accumulated **103 leftover vaults**.

Every run sweeps at **both ends**, and the start sweep is the one that matters, because it runs before
anything that can die:

- **On the device (Android)** — before the Appium session launches Obsidian, every `temp-vault-*`
  directory under `vaultBasePath` is removed over `adb`, and their stale entries are pruned from Obsidian
  Mobile's `localStorage` vault registry when the run registers its own vault. Unregistering a vault
  removes its device directory over `adb` **whether or not the WebView answered**.
- **On the host** — leftover `temp-vault-*` staging directories and owned `userdata-*` instance profiles
  in the system temp directory are removed.

The two halves gate differently, on purpose:

| Sweep      | Gate                                           | Why                                                                                                                                                     |
| ---------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Device** | Unconditional                                  | Android runs hold an exclusive lock, so no concurrent run can own a device vault — and an age gate would let a vault leaked minutes ago poison a rerun.  |
| **Host**   | Only older than `leftoverMaxAgeInMilliseconds` | Desktop runs are deliberately not serialized, and every project on the machine shares one temp directory, so a young directory may belong to a live run. |

Both knobs are available on either transport:

- **`shouldSweepLeftovers`** (default `true`) — set `false` to disable both sweeps entirely.
- **`leftoverMaxAgeInMilliseconds`** (default `7200000`, i.e. two hours) — the host age gate. Raise it if
  a run of yours can outlive the default; `0` removes every host match regardless of age.

Sweeping is best-effort throughout: a directory another process still holds is skipped, never thrown.

## One directory at a time, and the result is measured

The device sweep removes each vault with its own `rm -rf` and then re-lists what is left, so the count it
reports is what actually went away rather than what it asked for. Both halves of that matter, and both
come from the same measured failure:

- An Android emulator can end up holding a directory whose name the FUSE layer cannot express — `rm -rf`,
  `find -delete` and force-stopping Obsidian first all answer `Operation not permitted`, and it is
  permanent. Removing the whole set in one command let that single entry decide the fate of every other:
  one device was found carrying **26** leftover vaults that the sweep had been "removing" every run.
  Per-directory, it costs one warning per run instead of the whole sweep.
- A removal that leaves the directory behind is otherwise invisible, because `rm -rf` runs with its exit
  code ignored. A run that passed end to end was still leaking a vault apiece, silently. Anything that
  survives is now named in the log, at both ends — the start-of-run sweep and the teardown — and is
  retried by the next run's sweep.

## Related

- [Android testing](/obsidian-integration-testing/guides/android/#avd-provisioning) — why leftovers show
  up as WebView timeouts on a full `/data`.
- [Vaults and fixtures](/obsidian-integration-testing/guides/vaults/) — the vaults being swept.
