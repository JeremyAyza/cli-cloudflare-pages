import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE, type ConfigFile, readConfig, writeConfig } from '../../src/core/config/store.js';
import { runCli } from '../helpers/run.js';

let configDir: string;
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cf-pages-settings-'));
});
afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

const strict: ConfigFile = {
  version: 1,
  profiles: {
    default: {
      label: 'Acme',
      accountId: '0123456789abcdef0123456789abcdef',
      storage: 'file',
      tokenType: 'account',
      createdAt: '2026-10-21T12:00:00.000Z',
    },
  },
  settings: { productionRequiresTty: true },
};

async function configText(): Promise<string | undefined> {
  return readFile(join(configDir, CONFIG_FILE), 'utf8').catch(() => undefined);
}

describe('settings get', () => {
  it('--json → {ok:true,data:{productionRequiresTty:false}}', async () => {
    const r = await runCli(['settings', 'get', '--json'], { configDir });
    expect(r.exitCode).toBe(0);
    expect(r.json()).toEqual({ ok: true, data: { productionRequiresTty: false } });
    expect(r.stderr).toBe('');
  });

  it('reads the stored value, with or without the key', async () => {
    await writeConfig(configDir, strict);
    for (const args of [
      ['settings', 'get'],
      ['settings', 'get', 'productionRequiresTty'],
    ]) {
      const r = await runCli([...args, '--json'], { configDir });
      expect(r.exitCode).toBe(0);
      expect(r.json()).toEqual({ ok: true, data: { productionRequiresTty: true } });
    }
  });

  it('human output lists key and value on stdout', async () => {
    const r = await runCli(['settings', 'get'], { configDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('productionRequiresTty: false\n');
  });

  it('works without a TTY and does not create the config file', async () => {
    const r = await runCli(['settings', 'get', 'productionRequiresTty', '--no-input'], { configDir });
    expect(r.exitCode).toBe(0);
    expect(await configText()).toBeUndefined();
  });

  it('unknown key → exit 2 naming the available settings', async () => {
    const r = await runCli(['settings', 'get', 'nope', '--json'], { configDir });
    expect(r.exitCode).toBe(2);
    expect(r.json()).toEqual({
      ok: false,
      error: {
        code: 'usage',
        message: expect.stringContaining('nope'),
        hint: expect.stringContaining('productionRequiresTty'),
      },
    });
  });

  it('a corrupt config file → exit 1 with the path in the hint', async () => {
    await writeFile(join(configDir, CONFIG_FILE), '{ nope');
    const r = await runCli(['settings', 'get'], { configDir });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(join(configDir, CONFIG_FILE));
  });
});

describe('settings set', () => {
  it('without TTY → exit 5 and config unchanged', async () => {
    await writeConfig(configDir, strict);
    const before = await configText();
    const r = await runCli(['settings', 'set', 'productionRequiresTty', 'false'], { configDir });
    expect(r.exitCode).toBe(5);
    expect(r.stderr).toContain('only be changed from an interactive terminal');
    expect(r.stderr).toContain('Settings can only be changed from an interactive terminal.');
    expect(r.prompts).toEqual([]);
    expect(await configText()).toBe(before);
  });

  it('without TTY on a fresh install → exit 5 and no config file is created', async () => {
    const r = await runCli(['settings', 'set', 'productionRequiresTty', 'true'], { configDir });
    expect(r.exitCode).toBe(5);
    expect(await configText()).toBeUndefined();
  });

  it('--yes and --confirm do not unlock it, and the hint names the command for the person to run', async () => {
    await writeConfig(configDir, strict);
    for (const extra of [['--yes'], ['--confirm', 'my-site'], ['--yes', '--confirm', 'my-site']]) {
      const r = await runCli(['settings', 'set', 'productionRequiresTty', 'false', '--json', ...extra], {
        configDir,
        answers: [true],
      });
      expect(r.exitCode).toBe(5);
      const body = r.json<{ error: { code: string; hint: string } }>();
      expect(body.error.code).toBe('confirmation_required');
      expect(body.error.hint).toContain('cf-pages settings set productionRequiresTty false');
    }
    expect((await readConfig(configDir)).settings.productionRequiresTty).toBe(true);
  });

  it('--no-input on a TTY behaves like no TTY', async () => {
    await writeConfig(configDir, strict);
    const r = await runCli(['settings', 'set', 'productionRequiresTty', 'false', '--no-input'], {
      configDir,
      tty: true,
      answers: [true],
    });
    expect(r.exitCode).toBe(5);
    expect(r.prompts).toEqual([]);
    expect((await readConfig(configDir)).settings.productionRequiresTty).toBe(true);
  });

  it('in TTY with confirmation updates config', async () => {
    const r = await runCli(['settings', 'set', 'productionRequiresTty', 'true'], {
      configDir,
      tty: true,
      answers: [true],
    });
    expect(r.exitCode).toBe(0);
    expect(r.prompts).toEqual(['Set productionRequiresTty to true?']);
    expect(r.stdout).toBe('productionRequiresTty set to true.\n');
    expect((await readConfig(configDir)).settings).toEqual({ productionRequiresTty: true });
  });

  it('keeps the rest of the config (profiles) when it updates a setting', async () => {
    await writeConfig(configDir, strict);
    const r = await runCli(['settings', 'set', 'productionRequiresTty', 'false'], {
      configDir,
      tty: true,
      answers: [true],
    });
    expect(r.exitCode).toBe(0);
    expect(await readConfig(configDir)).toEqual({ ...strict, settings: { productionRequiresTty: false } });
  });

  it('--json prints the new value as a single document', async () => {
    const r = await runCli(['settings', 'set', 'productionRequiresTty', 'true', '--json'], {
      configDir,
      tty: true,
      answers: [true],
    });
    expect(r.exitCode).toBe(0);
    expect(r.json()).toEqual({ ok: true, data: { productionRequiresTty: true } });
  });

  it('declining the confirmation → cancelled (exit 5), config unchanged', async () => {
    await writeConfig(configDir, strict);
    const before = await configText();
    const r = await runCli(['settings', 'set', 'productionRequiresTty', 'false'], {
      configDir,
      tty: true,
      answers: [false],
    });
    expect(r.exitCode).toBe(5);
    expect(r.prompts).toEqual(['Set productionRequiresTty to false?']);
    expect(r.stderr).toContain('Cancelled');
    expect(await configText()).toBe(before);
  });

  it('pressing Enter at the prompt means no', async () => {
    const r = await runCli(['settings', 'set', 'productionRequiresTty', 'true'], {
      configDir,
      tty: true,
      answers: [''],
    });
    expect(r.exitCode).toBe(5);
    expect(await configText()).toBeUndefined();
  });

  it('--dry-run in TTY reports what would change without prompting or writing', async () => {
    const r = await runCli(['settings', 'set', 'productionRequiresTty', 'true', '--dry-run', '--json'], {
      configDir,
      tty: true,
    });
    expect(r.exitCode).toBe(0);
    expect(r.prompts).toEqual([]);
    expect(r.json()).toEqual({
      ok: true,
      data: { dryRun: true, key: 'productionRequiresTty', from: false, to: true },
    });
    expect(await configText()).toBeUndefined();
  });

  it('--dry-run without TTY is still refused', async () => {
    const r = await runCli(['settings', 'set', 'productionRequiresTty', 'true', '--dry-run'], { configDir });
    expect(r.exitCode).toBe(5);
    expect(await configText()).toBeUndefined();
  });

  it.each([
    ['unknown key', ['nope', 'true']],
    ['unknown value', ['productionRequiresTty', 'maybe']],
    ['capitalised value', ['productionRequiresTty', 'True']],
    ['inherited property name', ['toString', 'true']],
  ])('%s → exit 2 without prompting, with or without TTY', async (_name, args) => {
    for (const tty of [false, true]) {
      const r = await runCli(['settings', 'set', ...args, '--json'], { configDir, tty, answers: [true] });
      expect(r.exitCode).toBe(2);
      expect(r.json()).toEqual({
        ok: false,
        error: expect.objectContaining({ code: 'usage', hint: expect.any(String) }),
      });
      expect(r.prompts).toEqual([]);
    }
    expect(await configText()).toBeUndefined();
  });

  it('missing arguments → exit 2', async () => {
    expect((await runCli(['settings', 'set'], { configDir })).exitCode).toBe(2);
    expect((await runCli(['settings', 'set', 'productionRequiresTty'], { configDir })).exitCode).toBe(2);
  });
});

describe('settings group', () => {
  it('is listed in the root help', async () => {
    const r = await runCli(['--help']);
    expect(r.stdout).toContain('settings');
  });

  it('without a subcommand is a usage error', async () => {
    const r = await runCli(['settings', '--json'], { configDir });
    expect(r.exitCode).toBe(2);
    expect(r.json()).toEqual({ ok: false, error: expect.objectContaining({ code: 'usage' }) });
  });
});
