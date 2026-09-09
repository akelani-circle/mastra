import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Generous, because login talks to Circle twice, but bounded: a hung CLI holds a handler open. */
const TIMEOUT_MS = 60_000;

/** The CLI's own directory inside a caller's home: its config, terms record and session profiles. */
export const circleCliHome = (home: string) => join(home, '.circle-cli');

/**
 * The npm prefix a caller's own installs are pinned to. Nothing ships the Circle CLI — the agent
 * installs it at runtime — and on a deployed container npm's default prefix is root-owned.
 */
export const cliPrefix = (home: string) => join(home, '.local');

/**
 * PATH with the caller's own installs ahead of whatever the server inherited.
 *
 * A developer already has `circle` on their PATH, so the server inherits it and `execFile('circle')`
 * works. A deployed container has it nowhere but inside the caller's home, put there by the agent —
 * without this, the control plane reports NOT_INSTALLED for a binary one directory away.
 */
export const cliPath = (home: string) =>
  [join(cliPrefix(home), 'bin'), process.env.PATH]
    .filter((entry): entry is string => Boolean(entry))
    .join(delimiter);

/**
 * The environment a control-plane invocation runs under. Narrower than the sandbox's, but it has to
 * resolve `circle` to the same binary the agent's shell does.
 *
 * `CIRCLE_ACCEPT_TERMS` is absent, here most of all: this module is what runs `circle terms accept`,
 * so it is the one place a stray "accept everything" default would turn a person's decision into a
 * config value nobody reads.
 */
const cliEnv = (home: string): NodeJS.ProcessEnv => ({
  PATH: cliPath(home),
  HOME: home,
  USERPROFILE: home,
  CIRCLE_CLI_HOME: circleCliHome(home),
  NO_COLOR: '1',
  NODE_NO_WARNINGS: '1',
  ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
});

export type CliResult<T> = { ok: true; data: T } | { ok: false; message: string; code: string };

/** The `{ data }` / `{ error }` envelope every `--output json` command writes to stdout. */
type Envelope<T> = { data?: T; error?: { code?: string; message?: string; hint?: string } };

function parse<T>(stdout: string): Envelope<T> | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Envelope<T>;
  } catch {
    return undefined;
  }
}

/**
 * One `circle` command, with its JSON envelope unwrapped.
 *
 * The CLI reports a failure two ways at once — a non-zero exit *and* an `{ error }` body — and the
 * body is the useful half, so a throw is unwrapped back into the same shape a clean run produces.
 * What the caller never gets is an exception carrying a command line, which is how an OTP ends up
 * in a log.
 */
export async function circle<T>(home: string, args: string[]): Promise<CliResult<T>> {
  const argv = [...args, '--output', 'json'];

  try {
    const { stdout } = await run('circle', argv, {
      env: cliEnv(home),
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = parse<T>(stdout);

    if (parsed?.error) {
      return {
        ok: false,
        code: parsed.error.code ?? 'INTERNAL',
        message: parsed.error.message ?? 'The Circle CLI reported an error.',
      };
    }
    if (parsed && 'data' in parsed) return { ok: true, data: parsed.data as T };

    return { ok: false, code: 'INTERNAL', message: 'The Circle CLI returned no readable output.' };
  } catch (error) {
    const failed = error as { stdout?: string; code?: unknown; message?: string };
    const parsed = parse<T>(failed.stdout ?? '');

    if (parsed?.error) {
      return {
        ok: false,
        code: parsed.error.code ?? 'INTERNAL',
        message: parsed.error.message ?? 'The Circle CLI reported an error.',
      };
    }
    // A missing binary is a build problem, not something a caller can fix by trying again.
    if (failed.code === 'ENOENT') {
      return {
        ok: false,
        code: 'NOT_INSTALLED',
        message: 'The Circle CLI is not installed on the agent server.',
      };
    }

    return { ok: false, code: 'INTERNAL', message: 'The Circle CLI could not be run.' };
  }
}

/** The CLI's own window, restated: it refuses a request older than this and deletes the file. */
const LOGIN_REQUEST_TTL_MS = 10 * 60 * 1000;

/** What the CLI writes for a login it has started but not finished. */
type LoginRequest = {
  requestId?: unknown;
  email?: unknown;
  timestamp?: unknown;
  otpHead?: unknown;
};

/** The half of a login request that is safe to say out loud. */
export type PendingLogin = { requestId: string; email: string; otpHead?: string };

type TermsRecord = { accepted?: unknown; acceptedAt?: unknown; acceptedVia?: unknown };

/**
 * Terms acceptance, read from the file the CLI records it in — a fact about the filesystem, so it is
 * answerable after a restart, in a new thread, and from either front door.
 */
export async function termsAccepted(home: string): Promise<boolean> {
  try {
    const raw = await readFile(join(circleCliHome(home), 'terms.json'), 'utf-8');
    const record = JSON.parse(raw) as TermsRecord;

    return record.accepted === true;
  } catch {
    return false;
  }
}

/**
 * The most recent login this caller started and has not finished, read from the CLI's own files
 * rather than held in memory — a login sits between two requests a minute apart, and memory does not
 * survive a restart in between.
 *
 * Only three fields come back: the same file holds the device token and the encryption key the OTP
 * is exchanged against, and those have no reason to exist anywhere but on disk.
 */
export async function pendingLogin(home: string): Promise<PendingLogin | undefined> {
  const dir = join(circleCliHome(home), 'login-requests');

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return undefined;
  }

  const live: (PendingLogin & { at: number })[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    try {
      const request = JSON.parse(await readFile(join(dir, file), 'utf-8')) as LoginRequest;
      const at = typeof request.timestamp === 'number' ? request.timestamp : 0;

      if (typeof request.requestId !== 'string' || typeof request.email !== 'string') continue;
      if (Date.now() - at > LOGIN_REQUEST_TTL_MS) continue;

      live.push({
        at,
        requestId: request.requestId,
        email: request.email,
        ...(typeof request.otpHead === 'string' ? { otpHead: request.otpHead } : {}),
      });
    } catch {
      // A half-written file is not worth failing the request over; the next code request rewrites it.
    }
  }

  live.sort((a, b) => b.at - a.at);

  return live[0];
}
