import type { ChildProcess } from 'node:child_process';

import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { ProcessOutputChunk } from './process-capture.ts';

import { attachProcessCapture } from './process-capture.ts';
import { strictProxy } from './strict-proxy.ts';

const MAX_OUTPUT_LENGTH_IN_CHARACTERS = 10;

type Listener = (...arguments_: unknown[]) => void;

/**
 * The smallest thing the capture can be attached to: an event source with the
 * two stdio streams beside it.
 *
 * Hand-rolled rather than an `EventEmitter` or a real spawn, so the tests drive
 * `data` / `exit` / `error` at will and never touch a process.
 */
class FakeChildProcess {
  public readonly stderr: FakeStream | null;
  public readonly stdout: FakeStream | null;
  private readonly listeners = new Map<string, Listener[]>();

  public constructor(hasPipes: boolean) {
    this.stdout = hasPipes ? new FakeStream() : null;
    this.stderr = hasPipes ? new FakeStream() : null;
  }

  public emit(event: string, ...arguments_: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...arguments_);
    }
  }

  public once(event: string, listener: Listener): this {
    this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]);
    return this;
  }
}

class FakeStream {
  public unref: (() => void) | undefined;
  private readonly listeners: Listener[] = [];

  public emitData(text: string): void {
    for (const listener of this.listeners) {
      listener(Buffer.from(text));
    }
  }

  public on(event: string, listener: Listener): this {
    if (event === 'data') {
      this.listeners.push(listener);
    }
    return this;
  }
}

function attach(child: FakeChildProcess, onChunk?: (chunk: ProcessOutputChunk) => void): ReturnType<typeof attachProcessCapture> {
  return attachProcessCapture(strictProxy<ChildProcess>(child), {
    maxOutputLengthInCharacters: MAX_OUTPUT_LENGTH_IN_CHARACTERS,
    ...(onChunk !== undefined && { onChunk })
  });
}

function makeChild(hasPipes = true): FakeChildProcess {
  return new FakeChildProcess(hasPipes);
}

describe('attachProcessCapture', () => {
  it('should capture both streams into one tail', () => {
    const child = makeChild();
    const capture = attach(child);

    child.stdout?.emitData('out-');
    child.stderr?.emitData('err');

    expect(capture.readOutput()).toBe('out-err');
  });

  it('should keep only the most recent output', () => {
    const child = makeChild();
    const capture = attach(child);

    child.stdout?.emitData('0123456789');
    child.stdout?.emitData('abc');

    expect(capture.readOutput()).toBe('3456789abc');
  });

  it('should report the chunks live, with the stream they came from', () => {
    const child = makeChild();
    const chunks: ProcessOutputChunk[] = [];
    attach(child, (chunk) => {
      chunks.push(chunk);
    });

    child.stdout?.emitData('out-');
    child.stderr?.emitData('err');

    expect(chunks).toEqual([{ stream: 'stdout', text: 'out-' }, { stream: 'stderr', text: 'err' }]);
  });

  it('should freeze the tail after stopCapture while still draining the pipes', () => {
    const child = makeChild();
    const chunks: ProcessOutputChunk[] = [];
    const capture = attach(child, (chunk) => {
      chunks.push(chunk);
    });

    child.stdout?.emitData('kept');
    capture.stopCapture();
    child.stdout?.emitData('dropped');

    expect(capture.readOutput()).toBe('kept');
    expect(chunks).toHaveLength(2);
  });

  it('should report no exit info while the process is running', () => {
    const capture = attach(makeChild());

    expect(capture.readExitInfo()).toBeUndefined();
  });

  it('should record the exit code and signal', () => {
    const child = makeChild();
    const capture = attach(child);

    child.emit('exit', 0, null);

    expect(capture.readExitInfo()).toEqual({ code: 0, signal: null });
  });

  it('should record a spawn failure as a synthetic exit', () => {
    const child = makeChild();
    const capture = attach(child);

    child.emit('error', new Error('spawn ENOENT'));

    expect(capture.readExitInfo()).toEqual({ code: null, signal: null, spawnError: 'spawn ENOENT' });
  });

  it('should unref a stream that carries an unref, so piped stdio cannot hold the process open', () => {
    const child = makeChild();
    const unref = vi.fn();
    if (child.stdout) {
      child.stdout.unref = unref;
    }

    attach(child);

    expect(unref).toHaveBeenCalledOnce();
  });

  it('should tolerate a process spawned without pipes', () => {
    const child = makeChild(false);
    const capture = attach(child);

    child.emit('exit', 1, null);

    expect(capture.readOutput()).toBe('');
    expect(capture.readExitInfo()).toEqual({ code: 1, signal: null });
  });
});
