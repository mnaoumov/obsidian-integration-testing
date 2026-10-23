/**
 * @file
 *
 * Pure decisions over Obsidian's Atom changelog feed (`obsidian.md/changelog.xml`)
 * that `scripts/refresh-metadata.ts` needs: which catalog version an entry belongs
 * to, and which feed versions may mint a catalog entry of their own.
 */

/**
The parameters of {@link resolveFeedEntryVersion}.
*/
export interface ResolveFeedEntryVersionParams {
  /**
  The version the entry's link slug carries (`…-desktop-v<slugVersion>/`).
  */
  readonly slugVersion: string;

  /**
  The version the entry's title names (`Obsidian <titleVersion> Desktop (…)`),
  when the title names one.
  */
  readonly titleVersion: string | undefined;
}

const FULL_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const SLUG_SUFFIX_PATTERN = /-diff$/;

/**
 * Checks whether a feed version may mint a catalog entry the table lacks.
 *
 * Only a full `x.y.z` does: the catalog is keyed by desktop app version, and the
 * few older keys like `1.2` or `1.4` are hand-entered summaries rather than builds.
 *
 * @param version - The feed version.
 * @returns Whether it names a build.
 */
export function checkIsFullFeedVersion(version: string): boolean {
  return FULL_VERSION_PATTERN.test(version);
}

/**
 * Resolves the catalog version a feed entry documents.
 *
 * The slug is authoritative, because two titles carry a typo'd version (`Obsidian
 * 1.0.4 Mobile` links `…-mobile-v0.1.4/`, `Obsidian 0.6.0 Desktop` links
 * `…-desktop-v0.6.1/`). Three slugs are not a full version, though, and their
 * titles are right: `-v1.3/` is `1.3.0`, `-v1.1/` is `1.1.15` and `-v1.5.3-diff/`
 * is `1.5.3`. So a slug that is not a full `x.y.z` gives way to a title that is
 * one and extends it.
 *
 * @param params - The entry's slug and title versions.
 * @returns The version to key the entry under.
 */
export function resolveFeedEntryVersion(params: ResolveFeedEntryVersionParams): string {
  const { slugVersion, titleVersion } = params;
  if (FULL_VERSION_PATTERN.test(slugVersion) || titleVersion === undefined || !FULL_VERSION_PATTERN.test(titleVersion)) {
    return slugVersion;
  }

  const slugPrefix = slugVersion.replace(SLUG_SUFFIX_PATTERN, '');
  return titleVersion === slugPrefix || titleVersion.startsWith(`${slugPrefix}.`) ? titleVersion : slugVersion;
}
