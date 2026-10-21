import { describe, expect, it } from 'vitest';
import { canPrompt, confirmMutation, type Settings } from '../../src/core/confirm.js';
import { CliError } from '../../src/core/errors.js';
import type { GlobalFlags } from '../../src/core/flags.js';
import { type FakeIOOptions, fakeIO } from '../helpers/run.js';

const preview = { level: 'preview', project: 'my-site', action: 'Redeploy main' } as const;
const production = { level: 'production', project: 'my-site', action: 'Redeploy main' } as const;
const defaults: Settings = { productionRequiresTty: false };

function flagsWith(over: Partial<GlobalFlags> = {}): GlobalFlags {
  return { json: false, yes: false, dryRun: false, input: true, color: false, debug: false, ...over };
}

/** Awaits a promise that must reject with a `CliError`, and returns that error. */
async function failure(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    return err as CliError;
  }
  throw new Error('Expected the promise to reject');
}

function run(
  req: typeof preview | typeof production,
  opts: { io?: FakeIOOptions; flags?: Partial<GlobalFlags>; settings?: Partial<Settings> } = {},
) {
  const io = fakeIO(opts.io);
  const result = confirmMutation(io, flagsWith(opts.flags), { ...defaults, ...opts.settings }, req);
  return { io, result };
}

describe('canPrompt', () => {
  it.each([
    [true, true, true, true],
    [false, true, true, false],
    [true, false, true, false],
    [true, true, false, false],
  ])('stdin tty=%s, stderr tty=%s, input=%s → %s', (stdinIsTTY, stderrIsTTY, input, expected) => {
    const io = { ...fakeIO(), stdinIsTTY, stderrIsTTY };
    expect(canPrompt(io, flagsWith({ input }))).toBe(expected);
  });
});

describe('confirmMutation: preview', () => {
  it('tty + yes answer → resolves; the prompt mentions the action', async () => {
    const { io, result } = run(preview, { io: { tty: true, answers: [true] } });
    await expect(result).resolves.toBeUndefined();
    expect(io.prompts).toHaveLength(1);
    expect(io.prompts[0]).toBe('Redeploy main. Continue?');
  });

  it('tty + no → cancelled (exit 5)', async () => {
    const { result } = run(preview, { io: { tty: true, answers: [false] } });
    const err = await failure(result);
    expect(err.code).toBe('cancelled');
    expect(err.exitCode).toBe(5);
    expect(err.hint).toBeTruthy();
  });

  it('defaults the prompt to "no"', async () => {
    // The fake IO resolves an empty answer to the prompt default, so this is what pressing Enter does.
    const { result } = run(preview, { io: { tty: true, answers: [''] } });
    expect((await failure(result)).code).toBe('cancelled');
  });

  it('no tty, no flags → confirmation_required mentioning --yes, without prompting', async () => {
    const { io, result } = run(preview);
    const err = await failure(result);
    expect(err.code).toBe('confirmation_required');
    expect(err.exitCode).toBe(5);
    expect(`${err.message} ${err.hint}`).toContain('--yes');
    expect(io.prompts).toHaveLength(0);
  });

  it('no tty + --yes → resolves', async () => {
    const { io, result } = run(preview, { flags: { yes: true } });
    await expect(result).resolves.toBeUndefined();
    expect(io.prompts).toHaveLength(0);
  });

  it('tty + --yes → resolves without prompting', async () => {
    const { io, result } = run(preview, { io: { tty: true }, flags: { yes: true } });
    await expect(result).resolves.toBeUndefined();
    expect(io.prompts).toHaveLength(0);
  });

  it('no tty + --confirm my-site → resolves', async () => {
    const { io, result } = run(preview, { flags: { confirm: 'my-site' } });
    await expect(result).resolves.toBeUndefined();
    expect(io.prompts).toHaveLength(0);
  });

  it('tty + --confirm my-site → resolves without prompting', async () => {
    const { io, result } = run(preview, { io: { tty: true }, flags: { confirm: 'my-site' } });
    await expect(result).resolves.toBeUndefined();
    expect(io.prompts).toHaveLength(0);
  });

  it('--confirm other → usage, without prompting (no tty and tty)', async () => {
    for (const tty of [false, true]) {
      const { io, result } = run(preview, { io: { tty }, flags: { confirm: 'other' } });
      const err = await failure(result);
      expect(err.code).toBe('usage');
      expect(err.exitCode).toBe(2);
      expect(err.hint).toContain('--confirm my-site');
      expect(io.prompts).toHaveLength(0);
    }
  });

  it('--yes does not excuse a --confirm that names another project', async () => {
    const { result } = run(preview, { flags: { yes: true, confirm: 'other' } });
    expect((await failure(result)).code).toBe('usage');
  });

  it('the no-flag error offers both --yes and --confirm my-site', async () => {
    const err = await failure(run(preview).result);
    expect(err.hint).toContain('--yes');
    expect(err.hint).toContain('--confirm my-site');
  });
});

describe('confirmMutation: production', () => {
  it('no tty + --yes only → confirmation_required: needs --confirm, --yes is not enough', async () => {
    const { io, result } = run(production, { flags: { yes: true } });
    const err = await failure(result);
    expect(err.code).toBe('confirmation_required');
    expect(err.message).toBe('This changes production. Re-run with --confirm my-site (--yes is not enough).');
    expect(err.message).toContain('--confirm my-site');
    expect(err.message).toContain('--yes is not enough');
    expect(err.hint).toBeTruthy();
    expect(io.prompts).toHaveLength(0);
  });

  it('no tty, no flags → confirmation_required naming --confirm', async () => {
    const { result } = run(production);
    const err = await failure(result);
    expect(err.code).toBe('confirmation_required');
    expect(err.message).toContain('--confirm my-site');
  });

  it('no tty + --confirm my-site → resolves', async () => {
    const { io, result } = run(production, { flags: { confirm: 'my-site' } });
    await expect(result).resolves.toBeUndefined();
    expect(io.prompts).toHaveLength(0);
  });

  it('no tty + --confirm other → usage', async () => {
    const { result } = run(production, { flags: { confirm: 'other' } });
    const err = await failure(result);
    expect(err.code).toBe('usage');
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain('other');
    expect(err.message).toContain('my-site');
    expect(err.hint).toContain('--confirm my-site');
  });

  it('matches --confirm exactly, including case', async () => {
    const { result } = run(production, { flags: { confirm: 'My-Site' } });
    expect((await failure(result)).code).toBe('usage');
  });

  it('tty: typing the project name resolves', async () => {
    const { io, result } = run(production, { io: { tty: true, answers: ['my-site'] } });
    await expect(result).resolves.toBeUndefined();
    expect([...io.prompts]).toEqual(['Type the project name (my-site) to confirm:']);
  });

  it('tty: typing a different name cancels', async () => {
    const { result } = run(production, { io: { tty: true, answers: ['my-sit'] } });
    const err = await failure(result);
    expect(err.code).toBe('cancelled');
    expect(err.exitCode).toBe(5);
    expect(err.hint).toContain('my-site');
  });

  it('tty + --yes only still asks for the project name', async () => {
    const { io, result } = run(production, { io: { tty: true, answers: ['my-site'] }, flags: { yes: true } });
    await expect(result).resolves.toBeUndefined();
    expect(io.prompts).toHaveLength(1);
  });

  it('tty + --confirm my-site → resolves without prompting', async () => {
    const { io, result } = run(production, { io: { tty: true }, flags: { confirm: 'my-site' } });
    await expect(result).resolves.toBeUndefined();
    expect(io.prompts).toHaveLength(0);
  });

  it('tty + --confirm other → usage, without prompting', async () => {
    const { io, result } = run(production, { io: { tty: true }, flags: { confirm: 'other' } });
    expect((await failure(result)).code).toBe('usage');
    expect(io.prompts).toHaveLength(0);
  });

  it('productionRequiresTty + no tty + --confirm my-site → confirmation_required mentioning productionRequiresTty', async () => {
    const { io, result } = run(production, {
      flags: { confirm: 'my-site' },
      settings: { productionRequiresTty: true },
    });
    const err = await failure(result);
    expect(err.code).toBe('confirmation_required');
    expect(err.exitCode).toBe(5);
    expect(err.message).toContain('productionRequiresTty');
    expect(err.hint).toBeTruthy();
    expect(io.prompts).toHaveLength(0);
  });

  it('productionRequiresTty + tty → still prompts for the project name', async () => {
    const { result } = run(production, {
      io: { tty: true, answers: ['my-site'] },
      settings: { productionRequiresTty: true },
    });
    await expect(result).resolves.toBeUndefined();
  });

  it('productionRequiresTty + tty + --confirm my-site → resolves', async () => {
    const { io, result } = run(production, {
      io: { tty: true },
      flags: { confirm: 'my-site' },
      settings: { productionRequiresTty: true },
    });
    await expect(result).resolves.toBeUndefined();
    expect(io.prompts).toHaveLength(0);
  });

  it('productionRequiresTty + --no-input on a tty → confirmation_required', async () => {
    const { result } = run(production, {
      io: { tty: true },
      flags: { confirm: 'my-site', input: false },
      settings: { productionRequiresTty: true },
    });
    expect((await failure(result)).message).toContain('productionRequiresTty');
  });
});

describe('confirmMutation: --no-input', () => {
  it('tty but --no-input behaves as non-interactive for preview', async () => {
    const { io, result } = run(preview, { io: { tty: true }, flags: { input: false } });
    expect((await failure(result)).code).toBe('confirmation_required');
    expect(io.prompts).toHaveLength(0);
  });

  it('tty but --no-input behaves as non-interactive for production', async () => {
    const { io, result } = run(production, { io: { tty: true }, flags: { input: false } });
    const err = await failure(result);
    expect(err.code).toBe('confirmation_required');
    expect(err.message).toContain('--confirm my-site');
    expect(io.prompts).toHaveLength(0);
  });

  it('tty but --no-input still accepts --yes (preview) and --confirm (production)', async () => {
    await expect(
      run(preview, { io: { tty: true }, flags: { input: false, yes: true } }).result,
    ).resolves.toBeUndefined();
    await expect(
      run(production, { io: { tty: true }, flags: { input: false, confirm: 'my-site' } }).result,
    ).resolves.toBeUndefined();
  });
});
