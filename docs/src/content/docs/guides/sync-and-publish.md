---
title: Sync and Publish
description: Run the owned desktop instance on a persistent, signed-in profile so a suite can drive Obsidian Sync and Obsidian Publish.
sidebar:
    order: 12
---

An owned desktop instance normally runs on a fresh temporary user-data profile. That profile holds no Obsidian account and no Sync connection, so the vault opens signed out, and anything that needs Obsidian Sync or Obsidian Publish never appears. `persistentUserDataDirectory` points the owned instance at a profile you keep instead.

## The option

```ts
import { connectToCdp } from 'obsidian-integration-testing';

await using connection = await connectToCdp({
  persistentUserDataDirectory: 'F:\\ObsidianProfiles\\research',
  vault: 'F:\\dev\\ObsidianVaults\\Research'
});
```

It is also accepted by the `obsidian-cdp` transport options, so `createSetup` and `createTransportFromOptions` take it the same way. With it the harness:

1. Launches against that directory and never deletes it. A missing directory is created; the path must be absolute.
2. Merges the vault into the profile's own `obsidian.json` instead of overwriting it. Every other vault stays registered, and a vault the profile already lists keeps its id. Sync keys its connection to that id, so a new one would leave the vault disconnected.
3. Refuses a second run on the same profile, from this process or another one, with `PersistentProfileInUseError`. Two instances on one profile corrupt its `localStorage`. A lock left by a run that died is taken over.
4. Keeps Obsidian's own updates out of the run, so `obsidianVersion` is honoured (next section).
5. Lets Obsidian quit on `dispose()` before it kills the process, so what the run wrote to `localStorage` or IndexedDB (a sign-in, for example) reaches disk. Chromium writes storage lazily, and a hard kill a few seconds after a write loses it. An instance that does not quit within 30 seconds is killed anyway.

## Updates and `obsidianVersion`

Obsidian's updater downloads each new release into the profile as `obsidian-<version>.asar`, and at startup the installer loads the highest-versioned one it finds there in place of its own app. A temporary profile starts empty, but a kept one collects these files, so without help a run on it would test whatever the updater last downloaded rather than the version it asked for.

For the length of a run the harness therefore:

1. Moves every `obsidian-*.asar` in the profile into an `obsidian-integration-testing-held-asars` folder inside it, before it provisions the asar for the requested `obsidianVersion`. The instance can then load only that asar or the installer's own app.
2. Sets `updateDisabled: true` in the profile's `obsidian.json`, which stops the updater from downloading another release mid-run.

Dispose undoes both: the asar files the run added are removed, the held ones are put back, and `updateDisabled` returns to the value the profile had. A run that is killed before it can restore leaves the folder in place, and the next run on the profile restores it first. So when you launch Obsidian on the profile by hand, it updates itself as usual.

Open the vault **in place**: pass `vault` to `connectToCdp`, or construct `new TemporaryVault(path)`, which never deletes a folder it did not create. A temporary copy is a different folder, and Sync is connected to the real one. The setup's own vault (`getTemporaryVault()`) is always a temporary copy, so a suite that needs Sync opens its vault itself.

The option is ignored in attach mode (`port` set), where the running Obsidian already has its own profile.

## The one-time sign-in

The profile has to be signed in once, by a person:

1. Launch Obsidian on the profile: `Obsidian.exe --user-data-dir=<profile>` (or `connectToCdp` with the option and `isObsidianAppVisible: true`).
2. Open the vault from it, sign in to your Obsidian account under **Settings → General**, and connect the vault to its remote vault under **Settings → Sync**, entering the encryption password if it has one.
3. Connect Publish to its site under **Settings → Publish**, if the suite uses it.
4. Close Obsidian.

From then on every launch on the profile is signed in. Re-run these steps if the account signs the profile out.

Never let a script or an AI agent type, store or log the account password or the Sync encryption password. They belong in the person's own sign-in, not in a test, a fixture or a log, and the harness never asks for them.
