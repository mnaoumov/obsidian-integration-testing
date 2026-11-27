/**
 * @file
 *
 * Prints, one per line, the Obsidian versions that gained a public or catalyst channel between a saved copy of
 * `metadata.json` and the current one (`helpers/new-release-versions.ts`). `refresh-metadata.yml` saves the copy
 * before the refresh and sends obsidian-lib an `obsidian-release` dispatch for each printed version.
 *
 * Usage:
 *   npm run list:new-release-versions -- --before <path to the old metadata.json>
 */

import { exitIfScriptDisabled } from '@mnaoumov/typescript-dev-toolkit/env-toggle';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import type { ChannelEntry } from '../helpers/new-release-versions.ts';

import { METADATA_JSON_PATH } from '../helpers/metadata-global.ts';
import { findNewReleaseVersions } from '../helpers/new-release-versions.ts';

exitIfScriptDisabled();

const { values } = parseArgs({ options: { before: { type: 'string' } } });
if (values.before === undefined) {
  throw new Error('Pass --before <path to the old metadata.json>.');
}

const before = JSON.parse(await readFile(values.before, 'utf-8')) as Record<string, ChannelEntry>;
const after = JSON.parse(await readFile(METADATA_JSON_PATH, 'utf-8')) as Record<string, ChannelEntry>;
for (const { version } of findNewReleaseVersions(before, after)) {
  console.log(version);
}
