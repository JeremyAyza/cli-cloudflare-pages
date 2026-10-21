import type { Command } from '@commander-js/extra-typings';
import { InvalidArgumentError } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';
import { runCli } from '../helpers/run.js';

// No Cloudflare prefix: the redactor's token-shape pattern cannot hide it, so only the usage error itself can.
const SECRET = 'legacy-secret-token-0123456789abcdef';

const configure = (program: Command) => {
  program
    .command('probe')
    .option('--flag', 'a flag')
    .option('--limit <n>', 'a number', (value) => {
      if (!/^\d+$/.test(value)) throw new InvalidArgumentError('Expected a whole number.');
      return value;
    })
    .argument('[name]')
    .action(() => {});
  program
    .command('strict')
    .argument('<id>', 'an id', (value) => {
      if (!/^\d+$/.test(value)) throw new InvalidArgumentError('Expected a whole number.');
      return value;
    })
    .action(() => {});
};

async function usage(args: string[], json: boolean) {
  const r = await runCli([...args, ...(json ? ['--json'] : [])], { configure });
  expect(r.exitCode).toBe(2);
  expect(r.stdout + r.stderr).not.toContain(SECRET);
  return json ? r.json<{ error: { message: string } }>().error.message : r.stderr;
}

describe('usage errors never echo values from the command line', () => {
  for (const json of [false, true]) {
    const mode = json ? 'json' : 'human';

    it(`unknown option with =value keeps only the option name (${mode})`, async () => {
      const message = await usage(['probe', `--bogus=${SECRET}`], json);
      expect(message).toContain("unknown option '--bogus'");
    });

    it(`a boolean flag given a value keeps only the option name (${mode})`, async () => {
      const message = await usage(['probe', `--flag=${SECRET}`], json);
      expect(message).toContain("unknown option '--flag'");
    });

    it(`unknown short option with a value (${mode})`, async () => {
      const message = await usage(['probe', `-z=${SECRET}`], json);
      expect(message).toContain("unknown option '-z'");
    });

    it(`stray positional arguments are counted, not quoted (${mode})`, async () => {
      const message = await usage(['probe', 'one', SECRET], json);
      expect(message).toContain('too many arguments');
      expect(message).toContain('Expected 1 argument but got 2');
    });

    it(`an invalid option value is not quoted (${mode})`, async () => {
      const message = await usage(['probe', '--limit', SECRET], json);
      expect(message).toContain("option '--limit <n>' argument is invalid.");
      expect(message).toContain('Expected a whole number.');
    });

    it(`an invalid argument value is not quoted (${mode})`, async () => {
      const message = await usage(['strict', SECRET], json);
      expect(message).toContain("command-argument value is invalid for argument 'id'.");
      expect(message).toContain('Expected a whole number.');
    });

    it(`an unknown command that is not a plain short word is not quoted (${mode})`, async () => {
      const message = await usage([SECRET], json);
      expect(message).toContain("unknown command '[redacted]'");
    });
  }

  it('a mistyped command name is still shown, with the suggestion', async () => {
    const r = await runCli(['whoamj']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown command 'whoamj'");
    expect(r.stderr).toContain('Did you mean whoami?');
  });

  it('a mistyped option name is still shown, with the suggestion', async () => {
    const r = await runCli(['login', '--insecure-storag']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown option '--insecure-storag'");
    expect(r.stderr).toContain('Did you mean --insecure-storage?');
  });
});
