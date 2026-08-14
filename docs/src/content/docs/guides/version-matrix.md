---
title: Version matrix
description: Run the suites across the supported Obsidian range with `runObsidianVersionMatrix`, without double-running a converged one.
sidebar:
    order: 7
---

Obsidian support is a **range** — `[latest public, latest catalyst]` — and both ends are expected to work.
The two ends periodically **coincide**: when public catches up to catalyst, `public-latest` and
`catalyst-latest` provision the same build, so running the suites twice re-runs the same build and
verifies nothing extra. Worse, a project that runs both still reports "green on public **and** catalyst" —
a two-end claim it never actually verified.

`runObsidianVersionMatrix` makes that decision once, in the harness:

```ts
// scripts/test-integration-desktop.ts
import { runObsidianVersionMatrix } from 'obsidian-integration-testing';

await runObsidianVersionMatrix({
  // Defaults to ['public-latest', 'catalyst-latest'].
  // Accepts an array or a comma-separated string, so an env var passes straight through.
  versions: process.env.OBSIDIAN_VERSION,
  run: ({ version }) => {
    const result = spawnSync('npx', ['vitest', 'run', '--project=integration-tests:desktop'], {
      env: { ...process.env, OBSIDIAN_VERSION: version },
      shell: true,
      stdio: 'inherit'
    });
    if (result.status !== 0) {
      throw new Error(`Exit code ${String(result.status)}`);
    }
  }
});
```

Your test config keeps reading the version the way it always did — the runner just decides how many times
to invoke it:

```ts
environmentOptions: {
  obsidianTransport: {
    type: 'obsidian-cdp',
    obsidianVersion: process.env.OBSIDIAN_VERSION ?? 'public-latest'
  }
}
```

## What the runner guarantees

- **De-duplication is keyed on the *resolved* version, never the specifier string.**
  `['1.13.4', 'catalyst-latest']` collapses to a single run when catalyst *is* `1.13.4`, exactly as
  `['public-latest', 'catalyst-latest']` does when the channels converge.

- **The decision is always stated in the log**, so one run where you expected two is never ambiguous:

  ```text
  [version-matrix] public-latest -> 1.13.4
  [version-matrix] catalyst-latest -> 1.13.4
  [version-matrix] 2 requested specifiers resolve to 1 distinct version: 1.13.4 (public-latest, catalyst-latest). Running the suites once.
  [version-matrix] Run 1 of 1: 1.13.4 (public-latest, catalyst-latest)
  ```

- **Every version runs before anything is reported.** A failing end never hides the other: the summary
  names which concrete versions failed and which passed, and the thrown `AggregateError` carries each
  underlying failure.

  ```text
  AggregateError: Obsidian version matrix failed on 1 of 2 versions: 1.12.7 (public-latest). Passed: 1.13.4 (catalyst-latest).
  ```

- **Only this runner defaults to both ends.** `obsidianVersion` with no explicit pin still means "whatever
  your installed Obsidian runs", so `connectToCdp()`, the CLI, and any suite not using the runner are
  unaffected.

- **The runner never launches Obsidian itself** — your `run` callback does — so it stays
  framework-agnostic and works for Vitest, Jest and manual consumers alike.

## Related

- [`runObsidianVersionMatrix` API reference](/obsidian-integration-testing/api/run-version-matrix/runObsidianVersionMatrix/)
- [`DEFAULT_OBSIDIAN_VERSION_SPECS` API reference](/obsidian-integration-testing/api/version-matrix/DEFAULT-OBSIDIAN-VERSION-SPECS/)
- [Transport modes](/obsidian-integration-testing/guides/transports/#pin-an-obsidian-version) — pinning a
  single version.
