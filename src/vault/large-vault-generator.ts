/**
 * @file
 *
 * A seeded generator for a large vault fixture: notes spread over folders, with frontmatter, headings, tags, links
 * between notes and a share of unresolved links.
 *
 * Plugins that index a vault (backlinks, metadata caches, search) are slow or wrong only at a size nobody writes by
 * hand, and every repo that tested at that size used to carry its own throwaway script. The output is a
 * {@link PopulateFilesParams} map, so it goes straight into `createSetup({ populate })` or
 * {@link TemporaryVault.populate}, which write it before the vault opens and let Obsidian index it in one pass.
 *
 * The same `seed` and options always give the same map, byte for byte, so a slow or failing run can be repeated
 * exactly. Pure: it writes nothing itself.
 */

import type { PopulateFilesParams } from './temporary-vault.ts';

const DEFAULT_LINKS_PER_NOTE = 3;
const DEFAULT_PARAGRAPHS_PER_NOTE = 3;
const DEFAULT_ROOT_FOLDER = 'generated';
const DEFAULT_SEED = 1;
const DEFAULT_TAG_COUNT = 50;
const DEFAULT_TAGS_PER_NOTE = 2;
const DEFAULT_UNRESOLVED_LINK_RATIO = 0.05;
const MILLISECONDS_PER_DAY = 86_400_000;
const ISO_DATE_LENGTH = 'YYYY-MM-DD'.length;
const FIRST_CREATED_DATE_IN_MILLISECONDS = Date.parse('2024-01-01T00:00:00Z');
const SENTENCES_PER_PARAGRAPH = 3;
const WORDS_PER_SENTENCE = 10;
/**
 * The Park-Miller minimal standard generator: a prime modulus and its multiplier. Plain arithmetic, so every state
 * stays an exact safe integer.
 */
const PARK_MILLER_MODULUS = 2_147_483_647;
const PARK_MILLER_MULTIPLIER = 48_271;

const WORDS = [
  'anchor',
  'bridge',
  'canvas',
  'garden',
  'harbor',
  'island',
  'lantern',
  'meadow',
  'orchard',
  'pebble',
  'quarry',
  'river',
  'signal',
  'timber',
  'valley',
  'window',
  'archive',
  'compass',
  'engine',
  'forest',
  'journal',
  'ledger',
  'mirror',
  'needle',
  'planet',
  'rocket',
  'shadow',
  'thread',
  'voyage',
  'wander'
] as const;

/**
 * Parameters for {@link generateLargeVault}.
 */
export interface GenerateLargeVaultParams {
  /**
   * How many folders the notes are spread over, round-robin.
   *
   * @default the rounded square root of {@link noteCount}, at least 1
   */
  readonly folderCount?: number;

  /**
   * How many links to other generated notes each note carries. Fewer when the vault has fewer other notes.
   *
   * @default 3
   */
  readonly linksPerNote?: number;

  /**
   * How many notes to generate. A positive integer.
   */
  readonly noteCount: number;

  /**
   * How many paragraphs of body text each note carries.
   *
   * @default 3
   */
  readonly paragraphsPerNote?: number;

  /**
   * The vault-relative folder everything is generated under, so the map composes with other populate entries.
   *
   * @default `'generated'`
   */
  readonly rootFolder?: string;

  /**
   * The seed. The same seed and options always give the same map.
   *
   * @default 1
   */
  readonly seed?: number;

  /**
   * How many distinct tags exist across the vault.
   *
   * @default 50
   */
  readonly tagCount?: number;

  /**
   * How many tags each note carries in its frontmatter. Capped at {@link tagCount}.
   *
   * @default 2
   */
  readonly tagsPerNote?: number;

  /**
   * The share of links, from 0 to 1, that point at a note that does not exist.
   *
   * @default 0.05
   */
  readonly unresolvedLinkRatio?: number;
}

/**
 * Generates a large, seeded vault fixture as a populate map.
 *
 * Note `n` is `<rootFolder>/folder-<f>/note-<n>.md`, numbered from 0 and zero-padded so the names sort. Every note
 * name is unique across folders, so a link written as the bare name resolves the way a user's link would. Each note
 * holds YAML frontmatter (`aliases`, `created`, `tags`), a heading, body paragraphs, and a `## Links` section with
 * its links and one inline tag.
 *
 * @param params - The size and shape of the vault.
 * @returns A map of vault-relative paths to note text.
 * @throws Error when a count is not a non-negative integer, {@link GenerateLargeVaultParams.noteCount} or
 *   {@link GenerateLargeVaultParams.folderCount} is below 1, or the unresolved-link ratio is outside 0 to 1.
 */
export function generateLargeVault(params: GenerateLargeVaultParams): PopulateFilesParams {
  const {
    linksPerNote = DEFAULT_LINKS_PER_NOTE,
    noteCount,
    paragraphsPerNote = DEFAULT_PARAGRAPHS_PER_NOTE,
    rootFolder = DEFAULT_ROOT_FOLDER,
    seed = DEFAULT_SEED,
    tagCount = DEFAULT_TAG_COUNT,
    tagsPerNote = DEFAULT_TAGS_PER_NOTE,
    unresolvedLinkRatio = DEFAULT_UNRESOLVED_LINK_RATIO
  } = params;
  const folderCount = params.folderCount ?? Math.max(1, Math.round(Math.sqrt(noteCount)));

  assertCount('noteCount', noteCount, 1);
  assertCount('folderCount', folderCount, 1);
  assertCount('linksPerNote', linksPerNote, 0);
  assertCount('paragraphsPerNote', paragraphsPerNote, 0);
  assertCount('tagCount', tagCount, 0);
  assertCount('tagsPerNote', tagsPerNote, 0);
  assertCount('seed', seed, 0);
  if (!(unresolvedLinkRatio >= 0 && unresolvedLinkRatio <= 1)) {
    throw new Error(`generateLargeVault: unresolvedLinkRatio must be between 0 and 1, got ${String(unresolvedLinkRatio)}.`);
  }

  const random = createRandom(seed);
  const noteWidth = String(noteCount - 1).length;
  const folderWidth = String(folderCount - 1).length;

  const files: PopulateFilesParams = {};
  for (let index = 0; index < noteCount; index++) {
    const folder = `folder-${String(index % folderCount).padStart(folderWidth, '0')}`;
    const name = noteName(index);
    const tags = pickDistinct(random, tagCount, Math.min(tagsPerNote, tagCount)).map((tag) => `topic-${String(tag)}`);
    const linkTargets = pickDistinct(random, noteCount - 1, Math.min(linksPerNote, noteCount - 1))
      .map((target) => target >= index ? target + 1 : target);
    const links = linkTargets.map((target) => random() < unresolvedLinkRatio ? `[[missing-${String(target)}]]` : `[[${noteName(target)}]]`);
    const created = new Date(FIRST_CREATED_DATE_IN_MILLISECONDS + index * MILLISECONDS_PER_DAY).toISOString().slice(0, ISO_DATE_LENGTH);

    const paragraphs: string[] = [];
    for (let paragraph = 0; paragraph < paragraphsPerNote; paragraph++) {
      const sentences: string[] = [];
      for (let sentence = 0; sentence < SENTENCES_PER_PARAGRAPH; sentence++) {
        const words = Array.from({ length: WORDS_PER_SENTENCE }, pickWord).join(' ');
        sentences.push(`${words.charAt(0).toUpperCase()}${words.slice(1)}.`);
      }
      paragraphs.push(sentences.join(' '));
    }

    const lines = [
      '---',
      `aliases: [${pickWord()} ${String(index)}]`,
      `created: ${created}`,
      `tags: [${tags.join(', ')}]`,
      '---',
      '',
      `# ${name}`,
      '',
      ...paragraphs.flatMap((text) => [text, '']),
      '## Links',
      '',
      ...links.map((link) => `- ${link}`),
      ...tags.slice(0, 1).flatMap((tag) => ['', `#${tag}`]),
      ''
    ];

    files[`${rootFolder}/${folder}/${name}.md`] = lines.join('\n');
  }

  return files;

  function noteName(index: number): string {
    return `note-${String(index).padStart(noteWidth, '0')}`;
  }

  function pickWord(): string {
    const index = Math.floor(random() * WORDS.length);
    return WORDS.slice(index, index + 1).join('');
  }
}

function assertCount(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`generateLargeVault: ${name} must be an integer of at least ${String(minimum)}, got ${String(value)}.`);
  }
}

/**
 * A small seeded pseudo-random generator. `Math.random` cannot be seeded, and the point of the generator is a repeatable fixture.
 *
 * @param seed - The seed.
 * @returns A function returning numbers in `[0, 1)`.
 */
function createRandom(seed: number): () => number {
  // The state must never be 0, which the generator would keep forever.
  let state = (seed % (PARK_MILLER_MODULUS - 1)) + 1;
  return (): number => {
    state = (state * PARK_MILLER_MULTIPLIER) % PARK_MILLER_MODULUS;
    return (state - 1) / (PARK_MILLER_MODULUS - 1);
  };
}

/**
 * Picks `count` distinct integers from `[0, range)`, in the order they were picked.
 *
 * @param random - The pseudo-random generator.
 * @param range - The exclusive upper bound.
 * @param count - How many to pick; at most `range`.
 * @returns The picked integers.
 */
function pickDistinct(random: () => number, range: number, count: number): number[] {
  const picked = new Set<number>();
  while (picked.size < count) {
    picked.add(Math.floor(random() * range));
  }
  return [...picked];
}
