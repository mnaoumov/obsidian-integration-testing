import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import { evalInObsidian } from '../eval/eval-in-obsidian.ts';
import { TemporaryVault } from '../vault/temporary-vault.ts';
import {
  assertLayout,
  findLayoutProblems,
  LayoutAssertionError
} from './assert-layout.ts';

const REGISTRATION_TIMEOUT_IN_MILLISECONDS = 60_000;
const WALK_TIMEOUT_IN_MILLISECONDS = 120_000;

const temporaryVault = new TemporaryVault();

// The probe's own rules: every focusable part of it is fixed at rest, so what
// focus changes is exactly what each case names, whatever the theme draws.
const PROBE_CSS = `
#oit-layout-probe { position: fixed; left: 8px; top: 8px; z-index: 99999; background: #fff; }
#oit-layout-probe button { outline: none; box-shadow: none; transition: none; }
#oit-layout-probe button.oit-ring:focus { outline: 2px solid rgb(255, 0, 0); }
#oit-layout-probe button.oit-flat { box-shadow: 0 0 0 1px rgb(128, 128, 128); }
#oit-layout-probe button.oit-flat:focus { outline: none; box-shadow: 0 0 0 1px rgb(128, 128, 128); }
#oit-layout-probe button.oit-after { position: relative; }
#oit-layout-probe button.oit-after::after { content: ''; position: absolute; inset: -3px; }
#oit-layout-probe button.oit-after:focus::after { box-shadow: 0 0 0 2px rgb(0, 0, 255); }
#oit-overflow { width: 200px; }
#oit-overflow .oit-wide { width: 400px; height: 10px; }
#oit-overflow .oit-ellipsis { width: 50px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#oit-overflow .oit-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
#oit-range input { outline: none; box-shadow: none; }
#oit-touch button { padding: 0; border: 0; }
#oit-touch .oit-tiny { width: 20px; height: 20px; }
#oit-touch .oit-big { width: 60px; height: 60px; }
#oit-touch .oit-gone { display: none; }
`;

beforeAll(async () => {
  await temporaryVault.register();
  await evalInObsidian({
    callback({ css }): void {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

      // Prepended, so Tab past the probe's last button lands in Obsidian's own
      // workspace, outside every root, rather than wrapping nowhere.
      const probe = createDiv({ attr: { id: 'oit-layout-probe' } });
      document.body.prepend(probe);

      const overflow = probe.createDiv({ attr: { id: 'oit-overflow' } });
      overflow.createDiv({ cls: 'oit-wide' });
      overflow.createDiv({ cls: 'oit-ellipsis', text: 'a sentence far too long for fifty pixels' });
      overflow.createDiv({ cls: 'oit-sr-only', text: 'a label only a screen reader reads' });
      const scrolls = overflow.createDiv({ cls: 'oit-scrolls' });
      scrolls.createDiv({ cls: 'oit-wide' });

      const touch = probe.createDiv({ attr: { id: 'oit-touch' } });
      touch.createEl('button', { cls: 'oit-tiny', text: 'x' });
      touch.createEl('button', { cls: 'oit-big', text: 'OK' });
      touch.createEl('button', { cls: 'oit-gone', text: 'hidden' });

      const focus = probe.createDiv({ attr: { id: 'oit-focus' } });
      focus.createEl('button', { cls: 'oit-ring', text: 'Ring' });
      focus.createEl('button', { cls: 'oit-flat', text: 'Flat' });
      focus.createEl('button', { cls: 'oit-after', text: 'After' });

      const range = probe.createDiv({ attr: { id: 'oit-range' } });
      range.createEl('input', { attr: { type: 'range' } });
    },
    input: { css: PROBE_CSS },
    vaultPath: temporaryVault.path
  });
}, REGISTRATION_TIMEOUT_IN_MILLISECONDS);

afterAll(async () => {
  await temporaryVault.dispose();
});

describe('assertLayout integration', () => {
  it('reports a box wider than its parent, and skips ellipsis text and a visually hidden box', async () => {
    const problems = await findLayoutProblems({ root: '#oit-overflow', touchTargets: false, vaultPath: temporaryVault.path });
    expect(problems.map((problem) => problem.where)).toEqual(['div#oit-overflow', 'div.oit-scrolls']);
    expect(problems[0]?.detail).toMatch(/^scrollWidth 400 > clientWidth 200$/);
  });

  it('leaves out what the ignore selector matches', async () => {
    const problems = await findLayoutProblems({
      overflow: { ignoreSelector: '.oit-scrolls' },
      root: '#oit-overflow',
      touchTargets: false,
      vaultPath: temporaryVault.path
    });
    expect(problems.map((problem) => problem.where)).toEqual(['div#oit-overflow']);
  });

  it('reports a touch target under the minimum, and skips a hidden one', async () => {
    const problems = await findLayoutProblems({ overflow: false, root: '#oit-touch', touchTargets: true, vaultPath: temporaryVault.path });
    expect(problems).toEqual([{ check: 'touch-target', detail: '20 x 20 px', where: 'button.oit-tiny' }]);
  });

  it('reports the Tab stop whose focus changes nothing, counting a ring on ::after and ignoring a resting box-shadow', async () => {
    const problems = await findLayoutProblems({ focusRing: true, overflow: false, root: '#oit-focus', touchTargets: false, vaultPath: temporaryVault.path });
    expect(problems.map((problem) => `${problem.check} ${problem.where}`)).toEqual(['focus-ring button.oit-flat']);
  }, WALK_TIMEOUT_IN_MILLISECONDS);

  it('reports the Tab that leaves a root which must keep focus', async () => {
    const problems = await findLayoutProblems({
      focusRing: { ignoreSelector: '.oit-flat', shouldStayInside: true },
      overflow: false,
      root: '#oit-focus',
      touchTargets: false,
      vaultPath: temporaryVault.path
    });
    expect(problems.map((problem) => problem.check)).toEqual(['focus-escape']);
    expect(problems[0]?.detail).toBe('Tab 3 moved focus out of "#oit-focus"');
  }, WALK_TIMEOUT_IN_MILLISECONDS);

  it('reads the ring of a range input from its pixels, since its thumb cannot be read as a style', async () => {
    const problems = await findLayoutProblems({ focusRing: true, overflow: false, root: '#oit-range', touchTargets: false, vaultPath: temporaryVault.path });
    expect(problems).toEqual([]);
  }, WALK_TIMEOUT_IN_MILLISECONDS);

  it('throws a LayoutAssertionError carrying the problems', async () => {
    const call = assertLayout({ overflow: false, root: '#oit-touch', touchTargets: true, vaultPath: temporaryVault.path });
    await expect(call).rejects.toBeInstanceOf(LayoutAssertionError);
    const error = await call.catch((error_: unknown) => error_);
    expect((error as LayoutAssertionError).problems).toHaveLength(1);
    expect((error as LayoutAssertionError).message).toContain('touch target too small: button.oit-tiny (20 x 20 px)');
  });

  it('passes a root with nothing wrong', async () => {
    await expect(assertLayout({ root: '#oit-touch .oit-big', touchTargets: true, vaultPath: temporaryVault.path })).resolves.toBeUndefined();
  });

  it('refuses a root that matches nothing, and a call with every check off', async () => {
    await expect(assertLayout({ root: '#oit-missing', vaultPath: temporaryVault.path })).rejects.toThrow('nothing matches the root "#oit-missing"');
    await expect(assertLayout({ overflow: false, root: '#oit-touch', touchTargets: false, vaultPath: temporaryVault.path })).rejects.toThrow(
      'nothing to check'
    );
  });
});
