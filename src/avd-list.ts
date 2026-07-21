/**
 * @file
 *
 * Pure helpers for parsing `emulator -list-avds` output: extracting the
 * available AVD names and checking whether a requested AVD exists.
 *
 * Kept separate from the integration-only `transport-factory` (excluded from
 * unit tests) so the parsing stays unit-testable — the factory itself shells out
 * to the `emulator` binary.
 */

/**
 * Parameters for {@link checkAvdExists}.
 */
export interface CheckAvdExistsParams {
  /** Raw stdout of `emulator -list-avds` — one AVD name per line. */
  readonly avdListOutput: string;

  /** The AVD name to look for. */
  readonly avdName: string;
}

/**
 * Decides whether a given AVD exists, from the raw stdout of
 * `emulator -list-avds`.
 *
 * @param params - The listing output and the AVD name to check.
 * @returns `true` when the AVD name appears in the listing.
 */
export function checkAvdExists(params: CheckAvdExistsParams): boolean {
  return listAvailableAvds(params.avdListOutput).includes(params.avdName);
}

/**
 * Parses the available AVD names from the raw stdout of `emulator -list-avds`.
 *
 * The command prints one AVD name per line; blank lines and surrounding
 * whitespace are ignored. Some emulator builds emit an informational banner
 * (e.g. `INFO    | ...`) to stdout before the list, so those lines are dropped.
 *
 * @param avdListOutput - Raw stdout of `emulator -list-avds`.
 * @returns The available AVD names, in listed order.
 */
export function listAvailableAvds(avdListOutput: string): string[] {
  return avdListOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes('|'));
}
