import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../../src/core/errors.js';

const inquirer = vi.hoisted(() => ({
  input: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
}));
vi.mock('@inquirer/prompts', () => inquirer);

const { createNodeIO } = await import('../../src/core/io.js');

class ExitPromptError extends Error {
  override name = 'ExitPromptError';
}

describe('createNodeIO prompts', () => {
  beforeEach(() => {
    for (const fn of Object.values(inquirer)) fn.mockReset();
  });

  it('draw on stderr', async () => {
    inquirer.confirm.mockResolvedValue(true);
    inquirer.input.mockResolvedValue('Acme');
    const { prompts } = createNodeIO();
    await prompts.confirm('Proceed?', { default: false });
    await prompts.text('Label', { default: 'Acme' });
    expect(inquirer.confirm).toHaveBeenCalledWith({ message: 'Proceed?', default: false }, { output: process.stderr });
    expect(inquirer.input).toHaveBeenCalledWith({ message: 'Label', default: 'Acme' }, { output: process.stderr });
  });

  it('password input is masked', async () => {
    inquirer.password.mockResolvedValue('s3cret');
    expect(await createNodeIO().prompts.password('Token')).toBe('s3cret');
    expect(inquirer.password).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Token', mask: expect.anything() }),
      { output: process.stderr },
    );
  });

  it.each(['text', 'password', 'confirm', 'select'] as const)(
    'Ctrl+C during %s becomes CliError(cancelled)',
    async (kind) => {
      const target = {
        text: inquirer.input,
        password: inquirer.password,
        confirm: inquirer.confirm,
        select: inquirer.select,
      }[kind];
      target.mockRejectedValue(new ExitPromptError('User force closed the prompt'));
      const { prompts } = createNodeIO();
      const run = () => {
        switch (kind) {
          case 'text':
            return prompts.text('x');
          case 'password':
            return prompts.password('x');
          case 'confirm':
            return prompts.confirm('x');
          case 'select':
            return prompts.select('x', [{ value: 'a', name: 'a' }]);
        }
      };
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('cancelled');
      expect((err as CliError).exitCode).toBe(5);
    },
  );

  it('other prompt failures are not swallowed', async () => {
    inquirer.confirm.mockRejectedValue(new Error('tty exploded'));
    await expect(createNodeIO().prompts.confirm('x')).rejects.toThrow('tty exploded');
  });
});
