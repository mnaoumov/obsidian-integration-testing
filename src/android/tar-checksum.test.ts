// The fixtures are the Cyrillic path that broke the push, which no English dictionary knows.
// cspell:ignoreRegExp /[Ѐ-ӿ]+/gu

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { gunzipSync } from 'node:zlib';
import {
  describe,
  expect,
  it
} from 'vitest';

import {
  computeTarHeaderChecksum,
  createTarChecksumNormalizer,
  gzipTarForToybox,
  normalizeTarHeader,
  readTarEntrySize,
  TAR_BLOCK_SIZE_IN_BYTES
} from './tar-checksum.ts';

const CHECKSUM_OFFSET = 148;

/**
 * A path from the archive that toybox refused: its header bytes sum past `0o100000`.
 */
const LONG_CYRILLIC_DIRECTORY = 'Projects/Батько має право/База знань ГО Батько МАЄ ПРАВО/Для активістів ГО/Історії (для активістів)';

interface ArchiveEntry {
  readonly data?: Buffer;
  readonly header: Buffer;
}

interface HeaderSpec {
  readonly name: string;
  readonly prefix?: string;
  readonly size?: number;
  readonly sizeField?: Uint8Array;
  readonly type?: string;
}

function buildArchive(entries: readonly ArchiveEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const { data, header } of entries) {
    parts.push(header);
    if (data) {
      parts.push(data, Buffer.alloc(padding(data.length)));
    }
  }
  parts.push(Buffer.alloc(TAR_BLOCK_SIZE_IN_BYTES * 2));
  return Buffer.concat(parts);
}

/**
 * Builds a ustar header the way bsdtar does: checksum as six octal digits, NUL, space.
 *
 * @param spec - The header's fields.
 * @returns The header.
 */
function buildBsdtarHeader(spec: HeaderSpec): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE_IN_BYTES);
  header.write(spec.name, 0, 100, 'utf-8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0001750\0', 108, 'ascii');
  header.write('0001750\0', 116, 'ascii');
  if (spec.sizeField) {
    header.set(spec.sizeField, 124);
  } else {
    header.write(`${(spec.size ?? 0).toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  }
  header.write('15000000000\0', 136, 'ascii');
  header.write(spec.type ?? '0', 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  header.write(spec.prefix ?? '', 345, 155, 'utf-8');
  header.write(`${computeTarHeaderChecksum(header).toString(8).padStart(6, '0')}\0 `, CHECKSUM_OFFSET, 'ascii');
  return header;
}

function checksumField(header: Buffer): string {
  return header.toString('latin1', CHECKSUM_OFFSET, CHECKSUM_OFFSET + 8);
}

async function normalize(archive: Buffer, chunkSize = archive.length): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < archive.length; offset += chunkSize) {
    chunks.push(archive.subarray(offset, offset + chunkSize));
  }
  return buffer(Readable.from(chunks).pipe(createTarChecksumNormalizer()));
}

function padding(length: number): number {
  return (TAR_BLOCK_SIZE_IN_BYTES - (length % TAR_BLOCK_SIZE_IN_BYTES)) % TAR_BLOCK_SIZE_IN_BYTES;
}

describe('normalizeTarHeader', () => {
  it('should rewrite a checksum of 0o100000 or more, which toybox refuses, as seven digits starting with 0', () => {
    const header = buildBsdtarHeader({ name: 'Історії (для активістів)/нотатка.md', prefix: LONG_CYRILLIC_DIRECTORY });
    const checksum = computeTarHeaderChecksum(header);
    expect(checksum).toBeGreaterThanOrEqual(0o10_0000);
    expect(checksumField(header)[0]).toBe('1');

    normalizeTarHeader(header);

    expect(checksumField(header)).toBe(`0${checksum.toString(8)}\0`);
    expect(computeTarHeaderChecksum(header)).toBe(checksum);
  });

  it('should rewrite a small checksum as seven zero-padded digits', () => {
    const header = buildBsdtarHeader({ name: 'a.md' });
    const checksum = computeTarHeaderChecksum(header);

    normalizeTarHeader(header);

    expect(checksumField(header)).toBe(`${checksum.toString(8).padStart(7, '0')}\0`);
  });

  it('should return the data size rounded up to whole blocks', () => {
    expect(normalizeTarHeader(buildBsdtarHeader({ name: 'a.md', size: 0 }))).toBe(0);
    expect(normalizeTarHeader(buildBsdtarHeader({ name: 'a.md', size: 1 }))).toBe(512);
    expect(normalizeTarHeader(buildBsdtarHeader({ name: 'a.md', size: 512 }))).toBe(512);
    expect(normalizeTarHeader(buildBsdtarHeader({ name: 'a.md', size: 513 }))).toBe(1024);
  });

  it('should leave an all-zero block untouched', () => {
    const block = Buffer.alloc(TAR_BLOCK_SIZE_IN_BYTES);

    expect(normalizeTarHeader(block)).toBe(0);
    expect(block.every((byte) => byte === 0)).toBe(true);
  });

  it('should refuse a header whose stored checksum does not match its bytes', () => {
    const header = buildBsdtarHeader({ name: 'a.md' });
    header.write('b', 0, 'ascii');

    expect(() => normalizeTarHeader(header, 3)).toThrow(/tar header 3 stores checksum \d+ but its bytes sum to \d+/);
  });

  it('should refuse a header with no checksum digits', () => {
    const header = buildBsdtarHeader({ name: 'a.md' });
    header.write(' '.repeat(8), CHECKSUM_OFFSET, 'ascii');

    expect(() => normalizeTarHeader(header)).toThrow(/stores checksum undefined/);
  });
});

describe('readTarEntrySize', () => {
  it('should read an octal size padded with leading spaces', () => {
    const header = Buffer.alloc(TAR_BLOCK_SIZE_IN_BYTES);
    header.write('      1750 \0', 124, 'ascii');

    expect(readTarEntrySize(header)).toBe(0o1750);
  });

  it('should read a base-256 size', () => {
    const field = Buffer.alloc(12);
    field[0] = 0x80;
    field.writeUIntBE(9 * 1024 ** 3, 6, 6);
    const header = buildBsdtarHeader({ name: 'big.bin', sizeField: field });

    expect(readTarEntrySize(header)).toBe(9 * 1024 ** 3);
  });

  it('should read an empty size field as zero', () => {
    expect(readTarEntrySize(Buffer.alloc(TAR_BLOCK_SIZE_IN_BYTES))).toBe(0);
  });
});

describe('createTarChecksumNormalizer', () => {
  const longPathHeader = buildBsdtarHeader({ name: 'Історії (для активістів)/нотатка.md', prefix: LONG_CYRILLIC_DIRECTORY, size: 700 });
  // Data that looks exactly like a header with a checksum toybox refuses: a block scan would rewrite it.
  const headerLookingData = Buffer.concat([buildBsdtarHeader({ name: 'decoy', prefix: LONG_CYRILLIC_DIRECTORY }), Buffer.alloc(188, 0x41)]);
  const paxData = Buffer.from(`52 path=${LONG_CYRILLIC_DIRECTORY}/x.md\n`, 'utf-8');
  const archive = buildArchive([
    { data: paxData, header: buildBsdtarHeader({ name: 'PaxHeader/x.md', prefix: LONG_CYRILLIC_DIRECTORY, size: paxData.length, type: 'x' }) },
    { data: headerLookingData, header: longPathHeader },
    { header: buildBsdtarHeader({ name: 'folder/', type: '5' }) },
    { data: Buffer.from('hello'), header: buildBsdtarHeader({ name: 'small.md', size: 5 }) }
  ]);

  it.each([1, 7, 511, 512, 513, 4096, archive.length])('should rewrite only the headers when read in %i-byte chunks', async (chunkSize) => {
    const result = await normalize(archive, chunkSize);

    expect(result.length).toBe(archive.length);
    const headerOffsets = [0, 1024, 2560, 3072];
    const differing: number[] = [];
    for (const [offset, byte] of result.entries()) {
      if (byte !== archive[offset]) {
        differing.push(offset);
      }
    }
    expect(differing.every((offset) => headerOffsets.some((header) => offset >= header + CHECKSUM_OFFSET && offset < header + CHECKSUM_OFFSET + 8)))
      .toBe(true);
    for (const offset of headerOffsets) {
      const header = result.subarray(offset, offset + TAR_BLOCK_SIZE_IN_BYTES);
      expect(checksumField(header)).toMatch(/^0[0-7]{6}\0$/);
      expect(Number.parseInt(checksumField(header).slice(0, 7), 8)).toBe(computeTarHeaderChecksum(header));
    }
    expect(result.subarray(1536, 1536 + 512)).toStrictEqual(archive.subarray(1536, 1536 + 512));
  });

  it('should fail on an archive that ends inside a header', async () => {
    await expect(normalize(archive.subarray(0, 100))).rejects.toThrow(/ends inside a header \(100 of 512 bytes\) after 0 header\(s\)/);
  });

  it('should fail on an archive that ends inside an entry\'s data', async () => {
    await expect(normalize(archive.subarray(0, 1024 + 512 + 10))).rejects.toThrow(/1014 byte\(s\) short of an entry's data after 2 header\(s\)/);
  });

  it('should fail on a corrupt header', async () => {
    const corrupt = Buffer.from(archive);
    corrupt.write('Z', 3072, 'ascii');

    await expect(normalize(corrupt)).rejects.toThrow(/tar header 3 stores checksum/);
  });
});

describe('gzipTarForToybox', () => {
  it('should gzip an archive the host tar wrote for a long non-ASCII path, with every checksum in the form toybox reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tar-checksum-test-'));
    try {
      const vault = join(root, 'vault');
      const directory = join(vault, ...LONG_CYRILLIC_DIRECTORY.split('/'));
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'Нотатка про активістів.md'), 'вміст');
      execFileSync('tar', ['cf', 'vault.tar', '-C', vault, '.'], { cwd: root });

      await gzipTarForToybox({ sourcePath: join(root, 'vault.tar'), targetPath: join(root, 'vault.tar.gz') });

      const result = gunzipSync(readFileSync(join(root, 'vault.tar.gz')));
      const original = readFileSync(join(root, 'vault.tar'));
      expect(result.length).toBe(original.length);
      let offset = 0;
      let headerCount = 0;
      while (offset < result.length) {
        const header = result.subarray(offset, offset + TAR_BLOCK_SIZE_IN_BYTES);
        offset += TAR_BLOCK_SIZE_IN_BYTES;
        if (header.every((byte) => byte === 0)) {
          continue;
        }
        headerCount++;
        expect(checksumField(header)).toMatch(/^0[0-7]{6}\0$/);
        offset += Math.ceil(readTarEntrySize(header) / TAR_BLOCK_SIZE_IN_BYTES) * TAR_BLOCK_SIZE_IN_BYTES;
      }
      expect(headerCount).toBeGreaterThan(0);

      writeFileSync(join(root, 'normalized.tar'), result);
      const listed = execFileSync('tar', ['tf', 'normalized.tar'], { cwd: root, encoding: 'utf-8' });
      expect(listed).toContain('Нотатка про активістів.md');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('should fail on a source that is not a whole archive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tar-checksum-test-'));
    try {
      writeFileSync(join(root, 'broken.tar'), Buffer.alloc(100));

      await expect(gzipTarForToybox({ sourcePath: join(root, 'broken.tar'), targetPath: join(root, 'broken.tar.gz') })).rejects.toThrow(/truncated/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
