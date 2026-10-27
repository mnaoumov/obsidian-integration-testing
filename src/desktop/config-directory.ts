/**
 * @file
 *
 * Validates a vault's **config folder** name — the per-vault override Obsidian
 * exposes as *Settings → About → Override config folder* and stores as the
 * `<vaultId>-config` `localStorage` entry (see `transport-desktop-cdp`'s
 * `openVaultFromStarterScreen`).
 *
 * Obsidian validates the same value before applying it, and **silently falls
 * back** to {@link DEFAULT_CONFIG_DIRECTORY} when the value is rejected
 * (Obsidian 1.13.7, `app.js`):
 *
 * ```js
 * t.validateConfigDir = function (e) { return "." !== e && e.startsWith(".") && !HD.test(e) };
 * t.prototype.setConfigDir = function (e) { t.validateConfigDir(e) || (e = UD), this.configDir = e };
 * ```
 *
 * The two structural clauses are reproduced here so a bad value fails loudly at
 * the call site, naming the option, instead of booting a vault against the wrong
 * folder. The third — `HD`, a character blacklist minified past recovery — is
 * deliberately **not** guessed at: a stricter local copy would reject folder
 * names Obsidian accepts. Anything this validator lets through that Obsidian
 * then rejects is caught post-boot by the `app.vault.configDir` readback, which
 * throws `ConfigDirectoryFallbackError`. That readback is the real guarantee;
 * this is the early, better-worded half of it.
 */

/**
 * The config folder Obsidian uses when a vault has no override — and the one it
 * silently falls back to when an override fails its own validation.
 */
export const DEFAULT_CONFIG_DIRECTORY = '.obsidian';

/**
 * Throws unless `configDirectory` is a structurally valid Obsidian config folder
 * name.
 *
 * Mirrors the two recoverable clauses of Obsidian's own `validateConfigDir`: the
 * name must start with a dot and must not be the bare dot. A path separator is
 * rejected on top of those, because the override names a single folder directly
 * inside the vault, never a nested path.
 *
 * @param configDirectory - The candidate config folder name, e.g. `'.obsidian-desktop'`.
 * @throws {Error} When the name would be rejected by Obsidian and silently
 *   replaced with {@link DEFAULT_CONFIG_DIRECTORY}.
 */
export function assertValidConfigDirectory(configDirectory: string): void {
  if (!configDirectory.startsWith('.')) {
    throw new Error(
      `Invalid configDirectory ${JSON.stringify(configDirectory)}: an Obsidian config folder name must start with a dot, e.g. '${DEFAULT_CONFIG_DIRECTORY}'.`
    );
  }

  if (configDirectory === '.') {
    throw new Error(`Invalid configDirectory ${JSON.stringify(configDirectory)}: a bare dot is not a config folder name.`);
  }

  if (configDirectory.includes('/') || configDirectory.includes('\\')) {
    throw new Error(
      `Invalid configDirectory ${JSON.stringify(configDirectory)}: the config folder sits directly inside the vault, so its name cannot contain a path separator.`
    );
  }
}
