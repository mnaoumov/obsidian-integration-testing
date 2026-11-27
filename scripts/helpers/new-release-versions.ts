/**
 * @file
 *
 * Finds the Obsidian versions a `metadata.json` refresh newly released on the public or the catalyst channel, by
 * comparing each version's `channel` before and after. A version counts when it gained a channel it did not have:
 * a new key, or a catalyst build that went public. A changelog or download edit changes the file but no channel,
 * so it counts for nothing, which is why the file changing is not the signal.
 */

/**
 * The part of a `metadata.json` entry this comparison reads.
 */
export interface ChannelEntry {
  readonly channel?: string;
}

/**
 * One version that gained a release channel.
 */
export interface NewReleaseVersion {
  /**
   * The channels it gained, `public` and/or `catalyst`, in that order.
   */
  readonly newChannels: readonly ReleaseChannel[];
  readonly version: string;
}

/**
 * A release channel the canaries test.
 */
export type ReleaseChannel = 'catalyst' | 'public';

const RELEASE_CHANNELS: readonly ReleaseChannel[] = ['public', 'catalyst'];

/**
 * Lists the versions that gained a public or catalyst channel between two catalogs, in the order of the new one.
 *
 * @param before - The catalog before the refresh.
 * @param after - The catalog after the refresh.
 * @returns The versions that gained a channel.
 */
export function findNewReleaseVersions(
  before: Readonly<Record<string, ChannelEntry>>,
  after: Readonly<Record<string, ChannelEntry>>
): NewReleaseVersion[] {
  const result: NewReleaseVersion[] = [];
  for (const [version, entry] of Object.entries(after)) {
    const oldChannels = parseChannels(Object.hasOwn(before, version) ? before[version]?.channel : undefined);
    const newChannels = parseChannels(entry.channel).filter((channel) => !oldChannels.includes(channel));
    if (newChannels.length > 0) {
      result.push({ newChannels, version });
    }
  }
  return result;
}

/**
 * Splits a `channel` value (`public`, `catalyst`, `public+catalyst`) into the release channels it names.
 *
 * @param channel - The `channel` value, if any.
 * @returns The release channels it names, `public` first.
 */
export function parseChannels(channel: string | undefined): ReleaseChannel[] {
  const parts = new Set((channel ?? '').split('+').map((part) => part.trim()));
  return RELEASE_CHANNELS.filter((releaseChannel) => parts.has(releaseChannel));
}
