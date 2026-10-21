import type { Command } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';
import { CliError } from '../../src/core/errors.js';
import type { GlobalFlags } from '../../src/core/flags.js';
import { createOutput, paint, renderError, renderTable } from '../../src/core/output.js';
import { ACCT } from '../helpers/cf.js';
import { fakeIO, runCli } from '../helpers/run.js';

const flags = (overrides: Partial<GlobalFlags> = {}): GlobalFlags => ({
  json: false,
  yes: false,
  dryRun: false,
  input: true,
  color: true,
  debug: false,
  ...overrides,
});

describe('createOutput', () => {
  it('json mode emits one envelope with account', () => {
    const io = fakeIO();
    const out = createOutput(io, flags({ json: true }));
    out.header({ label: 'Acme', accountId: ACCT });
    out.data({ a: 1 }, () => 'never shown');
    expect(io.out.endsWith('\n')).toBe(true);
    expect(JSON.parse(io.out)).toEqual({ ok: true, account: { label: 'Acme', accountId: ACCT }, data: { a: 1 } });
    expect(io.err).toBe('');
  });

  it('json mode omits account when no header was set', () => {
    const io = fakeIO();
    createOutput(io, flags({ json: true })).data([1, 2], () => 'never shown');
    expect(JSON.parse(io.out)).toEqual({ ok: true, data: [1, 2] });
  });

  it('human mode writes header to stderr as "Acme · account …9abcdef"', () => {
    const io = fakeIO();
    const out = createOutput(io, flags());
    out.header({ label: 'Acme', accountId: ACCT });
    expect(io.err).toBe('Acme · account …9abcdef\n');
    expect(io.out).toBe('');
  });

  it('human mode renders the view with the human formatter on stdout', () => {
    const io = fakeIO();
    createOutput(io, flags()).data({ name: 'my-site' }, (v) => `Project ${v.name}`);
    expect(io.out).toBe('Project my-site\n');
  });

  it('data() twice throws', () => {
    for (const json of [true, false]) {
      const out = createOutput(fakeIO(), flags({ json }));
      out.data({ a: 1 }, () => 'x');
      expect(() => out.data({ a: 2 }, () => 'y')).toThrow(/more than once/);
    }
  });

  it('note and warn go to stderr and never pollute stdout', () => {
    for (const json of [true, false]) {
      const io = fakeIO();
      const out = createOutput(io, flags({ json }));
      out.note('Fetching projects…');
      out.warn('Token expires soon');
      expect(io.out).toBe('');
      expect(io.err).toContain('Fetching projects…\n');
      expect(io.err).toContain('Warning: Token expires soon\n');
    }
  });
});

describe('renderError', () => {
  it('in json writes {ok:false,error:{code,message,hint}} to stdout', () => {
    const io = fakeIO();
    renderError(
      io,
      flags({ json: true }),
      new CliError('not_found', 'No such project.', { hint: 'Try projects list.' }),
    );
    expect(JSON.parse(io.out)).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'No such project.', hint: 'Try projects list.' },
    });
    expect(io.err).toBe('');
  });

  it('in json includes details only when present', () => {
    const io = fakeIO();
    renderError(io, flags({ json: true }), new CliError('api_error', 'Boom.', { details: { status: 500 } }));
    expect(JSON.parse(io.out)).toEqual({
      ok: false,
      error: { code: 'api_error', message: 'Boom.', details: { status: 500 } },
    });
  });

  it('in human mode writes message and hint to stderr', () => {
    const io = fakeIO();
    renderError(io, flags({ color: false }), new CliError('usage', 'Bad flag.', { hint: 'Run --help.' }));
    expect(io.out).toBe('');
    expect(io.err).toBe('Error: Bad flag.\nHint: Run --help.\n');
  });
});

describe('unexpected errors', () => {
  const boom = (p: Command) => {
    p.command('boom').action(() => {
      throw new Error('boom cfat_secretsecret');
    });
  };

  it('unexpected error messages are redacted', async () => {
    const r = await runCli(['boom'], { configure: boom });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).not.toContain('cfat_secretsecret');
    expect(r.stderr).toContain('boom [redacted]');
    expect(r.stdout).toBe('');
  });

  it('are redacted in the json document too', async () => {
    const r = await runCli(['boom', '--json'], { configure: boom });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toContain('cfat_secretsecret');
    expect(r.json()).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'unexpected', message: 'boom [redacted]' }),
    });
  });

  it('--debug adds a redacted stack to stderr', async () => {
    const r = await runCli(['boom', '--debug'], { configure: boom });
    expect(r.stderr).not.toContain('cfat_secretsecret');
    expect(r.stderr).toContain('at ');
  });

  it('registered secrets are scrubbed as well', async () => {
    const r = await runCli(['leak'], {
      configure: (p, ctx) => {
        ctx.redactor.add('hunter2-plain-value');
        p.command('leak').action(() => {
          throw new Error('failed with hunter2-plain-value');
        });
      },
    });
    expect(r.stderr).not.toContain('hunter2-plain-value');
  });
});

describe('paint', () => {
  const RED = '\u001b[31m';

  it('colors a TTY stream', () => {
    const painted = paint(fakeIO({ tty: true }), flags(), 'stderr', 'red', 'oops');
    expect(painted).toContain(RED);
    expect(painted).toContain('oops');
  });

  it('no color when flags.color is off or the stream is not a TTY', () => {
    expect(paint(fakeIO({ tty: true }), flags({ color: false }), 'stdout', 'red', 'oops')).toBe('oops');
    expect(paint(fakeIO({ tty: false }), flags(), 'stderr', 'red', 'oops')).toBe('oops');
  });

  it('checks the requested stream, not the other one', () => {
    const io = { ...fakeIO(), stdoutIsTTY: true, stderrIsTTY: false };
    expect(paint(io, flags(), 'stdout', 'red', 'x')).toContain(RED);
    expect(paint(io, flags(), 'stderr', 'red', 'x')).toBe('x');
  });
});

describe('color decision through the CLI (injected env, never process.env)', () => {
  const ESC = '\u001b[';
  const lost = (p: Command) => {
    p.command('lost').action(() => {
      throw new CliError('not_found', 'Project "my-site" was not found.', { hint: 'Try projects list.' });
    });
  };

  it('colors error output on a TTY', async () => {
    const r = await runCli(['lost'], { tty: true, configure: lost });
    expect(r.stderr).toContain(ESC);
  });

  it('no color when NO_COLOR is set in the injected env', async () => {
    const r = await runCli(['lost'], { tty: true, env: { NO_COLOR: '1' }, configure: lost });
    expect(r.exitCode).toBe(4);
    expect(r.stderr).not.toContain(ESC);
    expect(r.stderr).toContain('Error: Project "my-site" was not found.');
  });

  it('an empty NO_COLOR does not disable color', async () => {
    const r = await runCli(['lost'], { tty: true, env: { NO_COLOR: '' }, configure: lost });
    expect(r.stderr).toContain(ESC);
  });

  it('no color when TERM=dumb', async () => {
    const r = await runCli(['lost'], { tty: true, env: { TERM: 'dumb' }, configure: lost });
    expect(r.stderr).not.toContain(ESC);
  });

  it('no color with --no-color or when stderr is not a TTY', async () => {
    expect((await runCli(['lost', '--no-color'], { tty: true, configure: lost })).stderr).not.toContain(ESC);
    expect((await runCli(['lost'], { tty: false, configure: lost })).stderr).not.toContain(ESC);
  });

  it('usage errors (parse failures) honor the injected env too', async () => {
    expect((await runCli(['--bogus'], { tty: true })).stderr).toContain(ESC);
    expect((await runCli(['--bogus'], { tty: true, env: { NO_COLOR: '1' } })).stderr).not.toContain(ESC);
    expect((await runCli(['--bogus'], { tty: true, env: { TERM: 'dumb' } })).stderr).not.toContain(ESC);
  });
});

describe('renderTable', () => {
  it('aligns columns and trims trailing spaces', () => {
    const table = renderTable(
      ['NAME', 'BRANCH'],
      [
        ['my-site', 'main'],
        ['a', 'refactor/web-docs'],
      ],
    );
    expect(table).toBe(['NAME     BRANCH', 'my-site  main', 'a        refactor/web-docs'].join('\n'));
  });

  it('ignores ANSI escapes when measuring width', () => {
    const table = renderTable(['A', 'B'], [['\u001b[31mred\u001b[39m', 'x']]);
    expect(table.split('\n')[1]).toBe('\u001b[31mred\u001b[39m  x');
  });

  it('pads short rows and renders only headers when there are no rows', () => {
    expect(renderTable(['A', 'B'], [['1']])).toBe('A  B\n1');
    expect(renderTable(['A', 'B'], [])).toBe('A  B');
  });
});
