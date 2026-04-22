import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { ObsidianTransport } from './transport.ts';

import {
  getTransport,
  setTransport
} from './transport-state.ts';

const mockDesktopCliTransport = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({
    evaluate: vi.fn(),
    preflightCheck: vi.fn(),
    registerVault: vi.fn(),
    unregisterVault: vi.fn()
  }))
);

vi.mock('./transport-desktop-cli.ts', () => ({
  DesktopCliTransport: mockDesktopCliTransport
}));

function createMockTransport(): ObsidianTransport {
  return {
    evaluate: vi.fn(),
    preflightCheck: vi.fn(),
    registerVault: vi.fn(),
    unregisterVault: vi.fn()
  };
}

describe('getTransport', () => {
  it('should return the transport set by setTransport', () => {
    const mockTransport = createMockTransport();
    setTransport(mockTransport);
    expect(getTransport()).toBe(mockTransport);
    expect(getTransport()).toBe(mockTransport);
  });
});

describe('setTransport', () => {
  it('should override the active transport', () => {
    const transport1 = createMockTransport();
    const transport2 = createMockTransport();
    setTransport(transport1);
    expect(getTransport()).toBe(transport1);
    setTransport(transport2);
    expect(getTransport()).toBe(transport2);
  });
});
