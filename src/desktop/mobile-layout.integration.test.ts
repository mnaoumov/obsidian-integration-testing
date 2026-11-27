import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { ObsidianTransport } from '../transport/transport.ts';

import { captureObsidianScreenshot } from '../capture/capture-obsidian-screenshot.ts';
import { readPngDimensions } from '../capture/capture-screenshot.ts';
import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { noopAsync } from '../noop.ts';
import { strictProxy } from '../strict-proxy.ts';
import { TemporaryVault } from '../vault/temporary-vault.ts';
import {
  disableMobileLayout,
  enableMobileLayout,
  withMobileLayout
} from './mobile-layout.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;
const TEST_TIMEOUT_IN_MILLISECONDS = 120_000;

const temporaryVault = new TemporaryVault();

interface LayoutReading {
  readonly bodyClasses: readonly string[];
  readonly devicePixelRatio: number;
  readonly hasNodeBuiltins: boolean;
  readonly hasStoredEmulation: boolean;
  readonly heightInPixels: number;
  readonly isAppMobile: boolean;
  readonly isDesktopApp: boolean;
  readonly isMobile: boolean;
  readonly isMobileApp: boolean;
  readonly widthInPixels: number;
}

interface NodeFsProbe {
  readonly existsSync?: unknown;
}

interface ReloadSentinelHolder {
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- The test sets it to tell one page load from the next.
  __oitMobileLayoutSentinel?: boolean;
}

async function hasReloadSentinel(): Promise<boolean> {
  return evalInObsidian({
    callback(): boolean {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: a test-local window property.
      return (globalThis as unknown as ReloadSentinelHolder).__oitMobileLayoutSentinel === true;
    },
    vaultPath: temporaryVault.path
  });
}

async function readLayout(): Promise<LayoutReading> {
  return evalInObsidian({
    callback({ app, obsidianModule }): LayoutReading {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- The point is that Node built-ins stay reachable under the emulation.
      const fs = require('node:fs') as NodeFsProbe;
      const hasNodeBuiltins = typeof fs.existsSync === 'function';
      const platform = obsidianModule.Platform;
      return {
        bodyClasses: ['emulate-mobile', 'is-mobile', 'is-phone', 'is-tablet'].filter((name) => document.body.classList.contains(name)),
        devicePixelRatio: window.devicePixelRatio,
        hasNodeBuiltins,
        hasStoredEmulation: localStorage.getItem('EmulateMobile') !== null,
        heightInPixels: window.innerHeight,
        isAppMobile: app.isMobile,
        isDesktopApp: platform.isDesktopApp,
        isMobile: platform.isMobile,
        isMobileApp: platform.isMobileApp,
        widthInPixels: window.innerWidth
      };
    },
    vaultPath: temporaryVault.path
  });
}

async function setReloadSentinel(): Promise<void> {
  await evalInObsidian({
    callback(): void {
      // eslint-disable-next-line no-restricted-syntax -- Approved double cast: a test-local window property.
      (globalThis as unknown as ReloadSentinelHolder).__oitMobileLayoutSentinel = true;
    },
    vaultPath: temporaryVault.path
  });
}

beforeAll(async () => {
  await temporaryVault.register();
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await disableMobileLayout({ vaultPath: temporaryVault.path });
  await temporaryVault.dispose();
}, TEST_TIMEOUT_IN_MILLISECONDS);

describe('enableMobileLayout', () => {
  it('should reload the window into the phone layout at 390x844 and twice the pixel density', async () => {
    const before = await readLayout();
    expect(before.isMobile).toBe(false);

    await enableMobileLayout({ vaultPath: temporaryVault.path });
    const reading = await readLayout();
    expect(reading).toStrictEqual({
      bodyClasses: ['emulate-mobile', 'is-mobile', 'is-phone'],
      devicePixelRatio: 2,
      hasNodeBuiltins: true,
      hasStoredEmulation: true,
      heightInPixels: 844,
      isAppMobile: true,
      isDesktopApp: true,
      isMobile: true,
      isMobileApp: false,
      widthInPixels: 390
    });
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should not reload a window already in the mobile layout at the same viewport', async () => {
    await enableMobileLayout({ vaultPath: temporaryVault.path });
    await setReloadSentinel();
    await enableMobileLayout({ vaultPath: temporaryVault.path });
    expect(await hasReloadSentinel()).toBe(true);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should keep trusted input on the Electron route under the emulation', async () => {
    await enableMobileLayout({ vaultPath: temporaryVault.path });
    const value = await evalInObsidian({
      async callback({ lib: { pressKey, waitUntil } }): Promise<string> {
        const input = document.body.createEl('input', { attr: { id: 'oit-mobile-layout-input' } });
        try {
          input.focus();
          await pressKey({ key: 'a' });
          await waitUntil({ message: 'the trusted key to reach the input', predicate: () => input.value === 'a' });
          return input.value;
        } finally {
          input.remove();
        }
      },
      vaultPath: temporaryVault.path
    });
    expect(value).toBe('a');
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should capture a phone frame, and keep the viewport after a sized capture', async () => {
    await enableMobileLayout({ vaultPath: temporaryVault.path });
    expect(readPngDimensions(await captureObsidianScreenshot({ vaultPath: temporaryVault.path }))).toStrictEqual({
      heightInPixels: 1688,
      widthInPixels: 780
    });
    expect(readPngDimensions(await captureObsidianScreenshot({ heightInPixels: 800, vaultPath: temporaryVault.path, widthInPixels: 1200 })))
      .toStrictEqual({ heightInPixels: 800, widthInPixels: 1200 });
    const reading = await readLayout();
    expect(reading.widthInPixels).toBe(390);
    expect(reading.devicePixelRatio).toBe(2);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should reload into the tablet layout when the viewport grows past 600 pixels', async () => {
    await enableMobileLayout({ vaultPath: temporaryVault.path });
    await setReloadSentinel();
    await enableMobileLayout({ deviceScaleFactor: 1, heightInPixels: 1180, vaultPath: temporaryVault.path, widthInPixels: 820 });
    expect(await hasReloadSentinel()).toBe(false);
    const reading = await readLayout();
    expect(reading.bodyClasses).toStrictEqual(['emulate-mobile', 'is-mobile', 'is-tablet']);
    expect(reading.widthInPixels).toBe(820);
    expect(reading.devicePixelRatio).toBe(1);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should refuse a transport that cannot pin the viewport', async () => {
    const transport = strictProxy<ObsidianTransport>({ isMobile: true, setViewportOverride: undefined });
    await expect(enableMobileLayout({ transport, vaultPath: temporaryVault.path })).rejects.toThrow('On Android, Obsidian already runs its mobile layout.');
  });
});

describe('disableMobileLayout', () => {
  it('should reload the window back into the desktop layout at its own size', async () => {
    await enableMobileLayout({ vaultPath: temporaryVault.path });
    await disableMobileLayout({ vaultPath: temporaryVault.path });
    const reading = await readLayout();
    expect(reading.isMobile).toBe(false);
    expect(reading.isAppMobile).toBe(false);
    expect(reading.hasStoredEmulation).toBe(false);
    expect(reading.bodyClasses).toStrictEqual([]);
    expect(reading.widthInPixels).not.toBe(390);
  }, TEST_TIMEOUT_IN_MILLISECONDS);

  it('should only un-pin a window that is not in the mobile layout', async () => {
    await setReloadSentinel();
    await disableMobileLayout({ vaultPath: temporaryVault.path });
    expect(await hasReloadSentinel()).toBe(true);
  }, TEST_TIMEOUT_IN_MILLISECONDS);
});

describe('withMobileLayout', () => {
  it('should run the callback in the mobile layout and turn it off afterwards, also when the callback throws', async () => {
    const isMobileInside = await withMobileLayout({
      async callback(): Promise<boolean> {
        const reading = await readLayout();
        return reading.isMobile;
      },
      vaultPath: temporaryVault.path
    });
    expect(isMobileInside).toBe(true);
    const afterReturn = await readLayout();
    expect(afterReturn.isMobile).toBe(false);

    await expect(withMobileLayout({
      async callback(): Promise<never> {
        await noopAsync();
        throw new Error('callback failed');
      },
      vaultPath: temporaryVault.path
    })).rejects.toThrow('callback failed');
    const afterThrow = await readLayout();
    expect(afterThrow.isMobile).toBe(false);
  }, TEST_TIMEOUT_IN_MILLISECONDS * 2);
});
