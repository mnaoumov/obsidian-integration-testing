import {
  describe,
  expect,
  it
} from 'vitest';

import type { HoldFieldTextParams } from './field-text-hold.ts';

import { holdFieldText } from './field-text-hold.ts';

interface FakeField {
  readonly params: HoldFieldTextParams;
  readonly sleeps: number[];
  readonly writes: string[];
}

/**
 * Builds a field whose reads come from a script: each entry is what the next read returns, and an entry of
 * `'<written>'` returns whatever was last written.
 */
function createFakeField(reads: (null | string)[], overrides: Partial<HoldFieldTextParams> = {}): FakeField {
  const writes: string[] = [];
  const sleeps: number[] = [];
  let lastWritten = '';
  let readIndex = 0;

  return {
    params: {
      expectedText: 'Delta',
      readText(): Promise<null | string> {
        const next = readIndex < reads.length ? reads[readIndex] ?? null : '<written>';
        readIndex++;
        return Promise.resolve(next === '<written>' ? lastWritten : next);
      },
      sleep(milliseconds: number): Promise<void> {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
      writeText(text: string): Promise<void> {
        writes.push(text);
        lastWritten = text;
        return Promise.resolve();
      },
      ...overrides
    },
    sleeps,
    writes
  };
}

describe('holdFieldText', () => {
  it('should write once and hold when every read agrees', async () => {
    const field = createFakeField([]);

    const result = await holdFieldText(field.params);

    expect(result).toEqual({ isHeld: true, readTexts: ['Delta', 'Delta', 'Delta'], writeCount: 1 });
    expect(field.writes).toEqual(['Delta']);
    expect(field.sleeps).toEqual([300, 300, 300]);
  });

  it('should write again after a read that lost the text, and restart the confirmation', async () => {
    const field = createFakeField(['Delta', '', '<written>', '<written>', '<written>']);

    const result = await holdFieldText(field.params);

    expect(result).toEqual({ isHeld: true, readTexts: ['Delta', '', 'Delta', 'Delta', 'Delta'], writeCount: 2 });
    expect(field.writes).toEqual(['Delta', 'Delta']);
  });

  it('should report the text lost once the writes are spent', async () => {
    const field = createFakeField(['', '', '', '']);

    const result = await holdFieldText(field.params);

    expect(result).toEqual({ isHeld: false, readTexts: ['', '', '', ''], writeCount: 4 });
    expect(field.writes).toEqual(['Delta', 'Delta', 'Delta', 'Delta']);
  });

  it('should stop at once when the field is gone', async () => {
    const field = createFakeField([null]);

    const result = await holdFieldText(field.params);

    expect(result).toEqual({ isHeld: false, readTexts: [null], writeCount: 1 });
    expect(field.writes).toEqual(['Delta']);
  });

  it('should honour the confirmation count, interval and write budget it is given', async () => {
    const field = createFakeField(['', 'x'], { confirmationReadCount: 1, intervalInMilliseconds: 50, maxWriteCount: 2 });

    const result = await holdFieldText(field.params);

    expect(result).toEqual({ isHeld: false, readTexts: ['', 'x'], writeCount: 2 });
    expect(field.sleeps).toEqual([50, 50]);
  });

  it('should hold on a single agreeing read when one confirmation is asked for', async () => {
    const field = createFakeField([], { confirmationReadCount: 1 });

    const result = await holdFieldText(field.params);

    expect(result).toEqual({ isHeld: true, readTexts: ['Delta'], writeCount: 1 });
  });
});
