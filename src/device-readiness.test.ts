import {
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianAndroidAppiumTransportOptions } from './transport-options.ts';

import {
  checkDeviceIdle,
  checkNetworkValidated,
  DEFAULT_DEVICE_IDLE_TIMEOUT_IN_MILLISECONDS,
  DEFAULT_NETWORK_READY_TIMEOUT_IN_MILLISECONDS,
  resolveDeviceIdleTimeoutInMilliseconds,
  resolveNetworkReadyTimeoutInMilliseconds
} from './device-readiness.ts';

const BASE_OPTIONS: ObsidianAndroidAppiumTransportOptions = {
  appiumUrl: 'http://localhost:4723',
  avdName: 'obsidian_test',
  type: 'obsidian-android-appium'
};

const PACKAGE_LIST_OUTPUT = 'package:md.obsidian\npackage:com.android.settings\n';

/*
 * Connectivity fixtures shaped on real `dumpsys connectivity` output sampled on
 * `obsidian_test` (T934). Two details are copied from the real dump rather than
 * invented, because both decide the parse:
 *
 * - the agent entry is ONE line, carrying its score policies and its `created` /
 *   `firstValidated` fields together;
 * - the `NetworkOffer` block far below always advertises `IS_VALIDATED`,
 *   whatever the live network is doing. The sampled dump had seven such lines
 *   while its default network was unvalidated.
 */
const AGENT_LINE_PREFIX = 'NetworkAgentInfo{network{100}  handle{432902426637}  ni{MOBILE[NR] CONNECTED}';
const NETWORK_OFFER_LINE = '  NetworkOffer [ Provider Id (6) Score(Policies : EVER_EVALUATED&IS_UNMETERED&EVER_VALIDATED&IS_VALIDATED ; KeepConnected : 0) Caps [ Transports: WIFI ]]';

const VALIDATED_BY_TIMESTAMP_OUTPUT = [
  'Active default network: 100',
  '',
  'Current Networks:',
  `  ${AGENT_LINE_PREFIX} Score(Policies : TRANSPORT_PRIMARY&EVER_EVALUATED ; KeepConnected : 0)  created 70635 firstValidated 72681 lastValidated 72681  factorySerialNumber=5}`,
  '',
  NETWORK_OFFER_LINE,
  ''
].join('\n');

const VALIDATED_BY_SCORE_POLICY_OUTPUT = [
  'Active default network: 100',
  '',
  'Current Networks:',
  `  ${AGENT_LINE_PREFIX} Score(Policies : TRANSPORT_PRIMARY&EVER_EVALUATED&IS_VALIDATED ; KeepConnected : 0)  created 70635  factorySerialNumber=5}`,
  '',
  NETWORK_OFFER_LINE,
  ''
].join('\n');

const NOT_YET_VALIDATED_OUTPUT = [
  'Active default network: 100',
  '',
  'Current Networks:',
  `  ${AGENT_LINE_PREFIX} Score(Policies : TRANSPORT_PRIMARY&EVER_EVALUATED ; KeepConnected : 0)  created 55887  factorySerialNumber=5}`,
  '',
  NETWORK_OFFER_LINE,
  ''
].join('\n');

const OTHER_NETWORK_VALIDATED_OUTPUT = [
  'Active default network: 100',
  '',
  'Current Networks:',
  `  ${AGENT_LINE_PREFIX} Score(Policies : TRANSPORT_PRIMARY&EVER_EVALUATED ; KeepConnected : 0)  created 55887  factorySerialNumber=5}`,
  '  NetworkAgentInfo{network{101}  handle{456}  ni{WIFI CONNECTED} Score(Policies : EVER_EVALUATED&IS_VALIDATED ; KeepConnected : 0)  created 60000 firstValidated 61000 lastValidated 61000}',
  ''
].join('\n');

// `none` is what a cold guest really prints before its default network exists — sampled at +56s, with zero agent entries.
const NO_DEFAULT_NETWORK_OUTPUT = [
  'Active default network: none',
  '',
  'Current Networks:',
  '',
  NETWORK_OFFER_LINE,
  ''
].join('\n');

describe('checkDeviceIdle', () => {
  it('should be idle when the boot animation has stopped and packages are listed', () => {
    expect(
      checkDeviceIdle({ bootAnimationProperty: 'stopped\n', packageListOutput: PACKAGE_LIST_OUTPUT })
    ).toBe(true);
  });

  it('should tolerate surrounding whitespace in the boot animation prop', () => {
    expect(
      checkDeviceIdle({ bootAnimationProperty: '  stopped  ', packageListOutput: PACKAGE_LIST_OUTPUT })
    ).toBe(true);
  });

  it('should not be idle while the boot animation is still running', () => {
    expect(
      checkDeviceIdle({ bootAnimationProperty: 'running\n', packageListOutput: PACKAGE_LIST_OUTPUT })
    ).toBe(false);
  });

  it('should not be idle when the boot animation prop is empty', () => {
    expect(
      checkDeviceIdle({ bootAnimationProperty: '', packageListOutput: PACKAGE_LIST_OUTPUT })
    ).toBe(false);
  });

  it('should not be idle when the package manager lists no packages yet', () => {
    expect(
      checkDeviceIdle({ bootAnimationProperty: 'stopped', packageListOutput: '' })
    ).toBe(false);
  });

  it('should ignore non-package lines in the package list output', () => {
    expect(
      checkDeviceIdle({ bootAnimationProperty: 'stopped', packageListOutput: 'Error: something\n' })
    ).toBe(false);
  });
});

describe('checkNetworkValidated', () => {
  it('should be validated when the active default network reports a firstValidated timestamp', () => {
    expect(checkNetworkValidated({ connectivityOutput: VALIDATED_BY_TIMESTAMP_OUTPUT })).toBe(true);
  });

  it('should be validated when the active default network carries the IS_VALIDATED score policy', () => {
    expect(checkNetworkValidated({ connectivityOutput: VALIDATED_BY_SCORE_POLICY_OUTPUT })).toBe(true);
  });

  it('should not be validated while the default network exists but has not validated yet', () => {
    expect(checkNetworkValidated({ connectivityOutput: NOT_YET_VALIDATED_OUTPUT })).toBe(false);
  });

  it('should not read the NetworkOffer block, which advertises IS_VALIDATED regardless of the live network', () => {
    // Regression: every fixture here carries that block, and the unvalidated ones must still read false.
    expect(NOT_YET_VALIDATED_OUTPUT).toContain('IS_VALIDATED');
    expect(checkNetworkValidated({ connectivityOutput: NOT_YET_VALIDATED_OUTPUT })).toBe(false);
    expect(checkNetworkValidated({ connectivityOutput: NO_DEFAULT_NETWORK_OUTPUT })).toBe(false);
  });

  it('should not be validated when the agent entry wraps onto a following line', () => {
    // Bounded to the entry's own line, so a wrapped entry reads not-ready rather than reaching past it.
    expect(
      checkNetworkValidated({
        connectivityOutput: 'Active default network: 100\n  NetworkAgentInfo{network{100}\n  created 70635 firstValidated 72681}\n'
      })
    ).toBe(false);
  });

  it('should not be validated when only a network other than the active default has validated', () => {
    expect(checkNetworkValidated({ connectivityOutput: OTHER_NETWORK_VALIDATED_OUTPUT })).toBe(false);
  });

  it('should not be validated when there is no active default network', () => {
    expect(checkNetworkValidated({ connectivityOutput: NO_DEFAULT_NETWORK_OUTPUT })).toBe(false);
    expect(
      checkNetworkValidated({ connectivityOutput: NO_DEFAULT_NETWORK_OUTPUT.replace('none', 'null') })
    ).toBe(false);
  });

  it('should not be validated when the active default network has no agent info in the dump', () => {
    expect(
      checkNetworkValidated({ connectivityOutput: 'Active default network: 100\n\nCurrent Networks:\n' })
    ).toBe(false);
  });

  it('should read an agent entry that ends the dump with no trailing newline', () => {
    expect(
      checkNetworkValidated({
        connectivityOutput: 'Active default network: 100\n  NetworkAgentInfo{network{100}} created 70635 firstValidated 72681}'
      })
    ).toBe(true);
  });

  it('should not be validated when firstValidated is zero', () => {
    expect(
      checkNetworkValidated({
        connectivityOutput: 'Active default network: 100\nNetworkAgentInfo{network{100}} created 66870 firstValidated 0\n'
      })
    ).toBe(false);
  });

  it('should not be validated on empty output, which is what an adb timeout resolves to', () => {
    expect(checkNetworkValidated({ connectivityOutput: '' })).toBe(false);
  });
});

describe('resolveDeviceIdleTimeoutInMilliseconds', () => {
  it('should default to 60000ms when the option is omitted', () => {
    expect(resolveDeviceIdleTimeoutInMilliseconds(BASE_OPTIONS)).toBe(60_000);
    expect(DEFAULT_DEVICE_IDLE_TIMEOUT_IN_MILLISECONDS).toBe(60_000);
  });

  it('should use the provided value when the option is set', () => {
    const CUSTOM_TIMEOUT_IN_MILLISECONDS = 90_000;
    expect(
      resolveDeviceIdleTimeoutInMilliseconds({
        ...BASE_OPTIONS,
        deviceIdleTimeoutInMilliseconds: CUSTOM_TIMEOUT_IN_MILLISECONDS
      })
    ).toBe(CUSTOM_TIMEOUT_IN_MILLISECONDS);
  });

  it('should allow 0 to skip the wait', () => {
    expect(
      resolveDeviceIdleTimeoutInMilliseconds({
        ...BASE_OPTIONS,
        deviceIdleTimeoutInMilliseconds: 0
      })
    ).toBe(0);
  });
});

describe('resolveNetworkReadyTimeoutInMilliseconds', () => {
  it('should default to 120000ms when the option is omitted', () => {
    expect(resolveNetworkReadyTimeoutInMilliseconds(BASE_OPTIONS)).toBe(120_000);
    expect(DEFAULT_NETWORK_READY_TIMEOUT_IN_MILLISECONDS).toBe(120_000);
  });

  it('should use the provided value when the option is set', () => {
    const CUSTOM_TIMEOUT_IN_MILLISECONDS = 30_000;
    expect(
      resolveNetworkReadyTimeoutInMilliseconds({
        ...BASE_OPTIONS,
        networkReadyTimeoutInMilliseconds: CUSTOM_TIMEOUT_IN_MILLISECONDS
      })
    ).toBe(CUSTOM_TIMEOUT_IN_MILLISECONDS);
  });

  it('should allow 0 to skip the wait', () => {
    expect(
      resolveNetworkReadyTimeoutInMilliseconds({
        ...BASE_OPTIONS,
        networkReadyTimeoutInMilliseconds: 0
      })
    ).toBe(0);
  });
});
