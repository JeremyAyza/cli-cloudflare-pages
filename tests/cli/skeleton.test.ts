import type { Command } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import type { Context } from '../../src/core/context.js';
import { CliError } from '../../src/core/errors.js';
import { type GlobalFlags, readGlobalFlags } from '../../src/core/flags.js';
import { runCli } from '../helpers/run.js';

describe('root program', () => {
  it('--version prints package version', async () => {
    const r = await runCli(['--version']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it('help shows disclaimer and exit codes', async () => {
    const r = await runCli(['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Unofficial. Not affiliated with or endorsed by Cloudflare.');
    expect(r.stdout).toContain('Exit codes:');
    expect(r.stdout).toContain('7  deployment finished in failure (--wait)');
  });

  it('help lists every global option', async () => {
    const r = await runCli(['--help']);
    for (const flag of [
      '--json',
      '-y, --yes',
      '--confirm <project>',
      '--dry-run',
      '--no-input',
      '--no-color',
      '--debug',
    ]) {
      expect(r.stdout).toContain(flag);
    }
  });

  it('bare invocation prints help to stdout and exits 0', async () => {
    const r = await runCli([]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Usage: cf-pages');
    expect(r.stderr).toBe('');
  });

  it('unknown option → exit 2 and a single JSON error document', async () => {
    const r = await runCli(['--json', '--bogus']);
    expect(r.exitCode).toBe(2);
    expect(r.json()).toEqual({ ok: false, error: expect.objectContaining({ code: 'usage' }) });
    expect(r.stderr).toBe('');
  });

  it('unknown command → exit 2', async () => {
    expect((await runCli(['nope'])).exitCode).toBe(2);
  });

  it('human usage error is reported once, on stderr', async () => {
    const r = await runCli(['--bogus']);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr.match(/unknown option '--bogus'/g)).toHaveLength(1);
    expect(r.stderr).toContain('Hint:');
  });

  it('a missing command with only global flags is a usage error', async () => {
    const configure = (p: Command) => {
      p.command('probe').action(() => {});
    };
    const r = await runCli(['--json', '--no-color'], { configure });
    expect(r.exitCode).toBe(2);
    expect(r.json()).toEqual({ ok: false, error: expect.objectContaining({ code: 'usage' }) });
  });
});

describe('commands registered after the root program', () => {
  it('inherit exit-code handling: unknown option and missing argument → exit 2', async () => {
    const configure = (p: Command) => {
      p.command('probe <name>').action(() => {});
    };
    expect((await runCli(['probe', 'x', '--bogus'], { configure })).exitCode).toBe(2);
    const missing = await runCli(['--json', 'probe'], { configure });
    expect(missing.exitCode).toBe(2);
    expect(missing.json()).toEqual({ ok: false, error: expect.objectContaining({ code: 'usage' }) });
  });

  it('unknown command is reported by name, and a group without subcommand is a usage error', async () => {
    const configure = (p: Command) => {
      p.command('group')
        .command('leaf')
        .action(() => {});
    };
    const unknown = await runCli(['nope'], { configure });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("unknown command 'nope'");
    const bare = await runCli(['--json', 'group'], { configure });
    expect(bare.exitCode).toBe(2);
    expect(bare.json()).toEqual({ ok: false, error: expect.objectContaining({ code: 'usage' }) });
  });

  it('read global flags wherever they appear on the command line', async () => {
    let seen: GlobalFlags | undefined;
    const configure = (p: Command, ctx: Context) => {
      p.command('probe').action((_opts, cmd) => {
        seen = readGlobalFlags(cmd, ctx.env);
      });
    };
    const r = await runCli(
      ['probe', '--json', '-y', '--confirm', 'my-site', '--dry-run', '--no-input', '--no-color', '--debug'],
      {
        configure,
      },
    );
    expect(r.exitCode).toBe(0);
    expect(seen).toEqual({
      json: true,
      yes: true,
      confirm: 'my-site',
      dryRun: true,
      input: false,
      color: false,
      debug: true,
    });
  });

  it('global flags default to interactive, colored and non-destructive', async () => {
    let seen: GlobalFlags | undefined;
    const configure = (p: Command, ctx: Context) => {
      p.command('probe').action((_opts, cmd) => {
        seen = readGlobalFlags(cmd, ctx.env);
      });
    };
    await runCli(['probe'], { configure });
    expect(seen).toEqual({
      json: false,
      yes: false,
      confirm: undefined,
      dryRun: false,
      input: true,
      color: true,
      debug: false,
    });
  });

  it('color is also disabled by NO_COLOR and TERM=dumb in the injected env, not by an empty NO_COLOR', async () => {
    const seenColor: Record<string, boolean | undefined> = {};
    const configure = (p: Command, ctx: Context) => {
      p.command('probe').action((_opts, cmd) => {
        seenColor[JSON.stringify(ctx.env)] = readGlobalFlags(cmd, ctx.env).color;
      });
    };
    for (const env of [{}, { NO_COLOR: '' }, { NO_COLOR: '1' }, { TERM: 'dumb' }, { TERM: 'xterm-256color' }]) {
      await runCli(['probe'], { env, configure });
    }
    expect(seenColor).toEqual({
      '{}': true,
      '{"NO_COLOR":""}': true,
      '{"NO_COLOR":"1"}': false,
      '{"TERM":"dumb"}': false,
      '{"TERM":"xterm-256color"}': true,
    });
  });

  it('a CliError maps to its exit code and renders as one JSON document with --json', async () => {
    const configure = (p: Command) => {
      p.command('lost').action(() => {
        throw new CliError('not_found', 'Project "my-site" was not found.', { hint: 'Run "cf-pages projects list".' });
      });
    };
    const json = await runCli(['lost', '--json'], { configure });
    expect(json.exitCode).toBe(4);
    expect(json.json()).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'Project "my-site" was not found.', hint: 'Run "cf-pages projects list".' },
    });
    const human = await runCli(['lost'], { configure });
    expect(human.exitCode).toBe(4);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('Project "my-site" was not found.');
    expect(human.stderr).toContain('Run "cf-pages projects list".');
  });
});

describe('error redaction', () => {
  const SECRET = 'cfat_secretsecret';
  const probe = (p: Command) => {
    p.command('probe').action(() => {});
  };

  it('a token echoed by commander in an unknown option never reaches stdout or stderr', async () => {
    for (const args of [
      [`--token=${SECRET}`],
      [`--token=${SECRET}`, 'probe'],
      ['--json', `--token=${SECRET}`, 'probe'],
    ]) {
      const r = await runCli(args);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).not.toContain(SECRET);
      expect(r.stderr).not.toContain(SECRET);
    }
  });

  it('a token typed as a command or argument is redacted in human and --json output', async () => {
    for (const args of [[SECRET], ['--json', SECRET]]) {
      const r = await runCli(args);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).not.toContain(SECRET);
      expect(r.stderr).not.toContain(SECRET);
      expect(r.stdout + r.stderr).toContain('[redacted]');
    }
    const unknownCommand = await runCli(['--json', SECRET], { configure: probe });
    expect(unknownCommand.exitCode).toBe(2);
    expect(unknownCommand.stdout).not.toContain(SECRET);
    expect(unknownCommand.json<{ error: { message: string } }>().error.message).toContain(
      "unknown command '[redacted]'",
    );
  });

  it('message, hint and string details of any CliError are redacted, including nested ones', async () => {
    const configure = (p: Command) => {
      p.command('leak').action(() => {
        throw new CliError('api_error', `Bad credentials ${SECRET}`, {
          hint: `Retry without ${SECRET}`,
          details: { status: 403, header: `Bearer ${SECRET}`, nested: { values: [SECRET, 7] } },
        });
      });
    };
    const json = await runCli(['--json', 'leak'], { configure });
    expect(json.exitCode).toBe(6);
    expect(json.stdout).not.toContain(SECRET);
    expect(json.json()).toEqual({
      ok: false,
      error: {
        code: 'api_error',
        message: 'Bad credentials [redacted]',
        hint: 'Retry without [redacted]',
        details: { status: 403, header: 'Bearer [redacted]', nested: { values: ['[redacted]', 7] } },
      },
    });
    const human = await runCli(['leak'], { configure });
    expect(human.exitCode).toBe(6);
    expect(human.stderr).not.toContain(SECRET);
    expect(human.stderr).toContain('Bad credentials [redacted]');
    expect(human.stderr).toContain('Retry without [redacted]');
  });

  it('secrets registered at runtime are redacted from CliErrors too', async () => {
    const r = await runCli(['leak'], {
      configure: (p, ctx) => {
        ctx.redactor.add('hunter2-plain-value');
        p.command('leak').action(() => {
          throw new CliError('permission_denied', 'Rejected hunter2-plain-value', {
            hint: 'hunter2-plain-value is wrong',
          });
        });
      },
    });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).not.toContain('hunter2-plain-value');
  });
});
