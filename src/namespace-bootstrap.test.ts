import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { ObsidianTransport } from './transport.ts';

import { ensureNamespaceBootstrapped } from './namespace-bootstrap.ts';
import { ensureNonNullable } from './type-guards.ts';

const mockEvaluate = vi.fn<ObsidianTransport['evaluate']>();

const mockTransport: ObsidianTransport = {
  evaluate: mockEvaluate,
  isMobile: false,
  preflightCheck: vi.fn<ObsidianTransport['preflightCheck']>().mockResolvedValue(undefined),
  registerVault: vi.fn<ObsidianTransport['registerVault']>().mockResolvedValue(undefined),
  unregisterVault: vi.fn<ObsidianTransport['unregisterVault']>().mockResolvedValue(undefined)
};

beforeEach(() => {
  mockEvaluate.mockReset();
});

describe('ensureNamespaceBootstrapped', () => {
  it('should skip bootstrap when version matches', async () => {
    mockEvaluate.mockResolvedValueOnce('true');
    await ensureNamespaceBootstrapped(mockTransport, '/vault');
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(mockEvaluate).toHaveBeenCalledWith(
      expect.stringContaining('window.__obsidianIntegrationTesting?.version'),
      { cwd: '/vault' }
    );
  });

  it('should send bootstrap expression when version does not match', async () => {
    mockEvaluate.mockResolvedValueOnce('false');
    mockEvaluate.mockResolvedValueOnce('');
    await ensureNamespaceBootstrapped(mockTransport, '/vault');
    expect(mockEvaluate).toHaveBeenCalledTimes(2);
    const bootstrapExpr = mockEvaluate.mock.calls[1]?.[0];
    expect(bootstrapExpr).toContain('function bootstrapNamespace');
  });

  it('should send bootstrap expression when namespace does not exist', async () => {
    mockEvaluate.mockResolvedValueOnce('');
    mockEvaluate.mockResolvedValueOnce('');
    await ensureNamespaceBootstrapped(mockTransport, '/vault');
    expect(mockEvaluate).toHaveBeenCalledTimes(2);
  });

  it('should produce syntactically valid JavaScript in the bootstrap expression', async () => {
    mockEvaluate.mockResolvedValueOnce('false');
    mockEvaluate.mockResolvedValueOnce('');
    await ensureNamespaceBootstrapped(mockTransport, '/vault');
    const bootstrapExpr = ensureNonNullable(mockEvaluate.mock.calls[1])[0];
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- We don't eval, we just check the syntax.
    expect(() => new Function(bootstrapExpr)).not.toThrow();
  });
});
