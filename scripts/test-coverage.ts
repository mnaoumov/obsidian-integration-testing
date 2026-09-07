import { exitIfScriptDisabled } from './helpers/env-toggle.ts';
import { execFromRoot } from './helpers/root.ts';

exitIfScriptDisabled();

const FULL_COVERAGE = 100;

await execFromRoot([
  'vitest',
  'run',
  '--project',
  'unit-tests',
  '--coverage',
  // Enforce the thresholds PER FILE, not only across the total. Pass/fail is unchanged — a 100% total is
  // Reachable only when every file is already at 100% — but the failure then names the offending path
  // Instead of reporting `All files 99.65%`. That distinction is not cosmetic: `src/android-sdk.ts` was
  // Reviewed, landed and pushed measuring 0%, and the only thing that said so was a total two hundredths
  // Of a percent below the threshold, on a gate nothing runs at commit time.
  '--coverage.thresholds.perFile',
  `--coverage.thresholds.lines=${String(FULL_COVERAGE)}`,
  `--coverage.thresholds.functions=${String(FULL_COVERAGE)}`,
  `--coverage.thresholds.branches=${String(FULL_COVERAGE)}`,
  `--coverage.thresholds.statements=${String(FULL_COVERAGE)}`
]);
