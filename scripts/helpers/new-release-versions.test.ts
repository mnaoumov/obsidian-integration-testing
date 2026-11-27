import {
  describe,
  expect,
  it
} from 'vitest';

import {
  findNewReleaseVersions,
  parseChannels
} from './new-release-versions.ts';

describe('parseChannels', () => {
  it('should read each channel form', () => {
    expect(parseChannels('public')).toEqual(['public']);
    expect(parseChannels('catalyst')).toEqual(['catalyst']);
    expect(parseChannels('public+catalyst')).toEqual(['public', 'catalyst']);
  });

  it('should read no channel from a missing or unknown value', () => {
    expect(parseChannels(undefined)).toEqual([]);
    expect(parseChannels('')).toEqual([]);
    expect(parseChannels('beta')).toEqual([]);
  });
});

describe('findNewReleaseVersions', () => {
  it('should report a new catalyst version', () => {
    expect(findNewReleaseVersions(
      { '1.15.0': { channel: 'public' } },
      { '1.15.0': { channel: 'public' }, '1.15.1': { channel: 'catalyst' } }
    )).toEqual([{ newChannels: ['catalyst'], version: '1.15.1' }]);
  });

  it('should report a catalyst version that went public', () => {
    expect(findNewReleaseVersions(
      { '1.15.1': { channel: 'catalyst' } },
      { '1.15.1': { channel: 'public+catalyst' } }
    )).toEqual([{ newChannels: ['public'], version: '1.15.1' }]);
  });

  it('should report nothing when no channel changed', () => {
    expect(findNewReleaseVersions(
      { '1.15.0': { channel: 'public' } },
      { '1.15.0': { channel: 'public' } }
    )).toEqual([]);
  });

  it('should report nothing for a new key with no channel', () => {
    expect(findNewReleaseVersions({}, { '1.15.2': {} })).toEqual([]);
  });

  it('should not count an inherited key as already present', () => {
    expect(findNewReleaseVersions({}, { toString: { channel: 'public' } })).toEqual([
      { newChannels: ['public'], version: 'toString' }
    ]);
  });
});
