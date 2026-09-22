import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Generous, because login talks to Circle twice, but bounded: a hung CLI holds a handler open. */
const TIMEOUT_MS = 60_000;

/** The CLI's own directory inside a caller's home: config, terms record, session profiles. */
export const circleCliHome = (home: string) => join(home, '.circle-cli');

/** The agent installs the CLI at runtime, and npm's default prefix is root-owned in a container. */
export const cliPrefix = (home: string) => join(home, '.local');

/** The caller's own installs ahead of whatever the server inherited. */
export const cliPath = (home: string) =>
  [join(cliPrefix(home), 'bin'), process.env.PATH]
    .filter((entry): entry is string => Boolean(entry))
    .join(delimiter);

/** `CIRCLE_ACCEPT_TERMS` is absent on purpose: this module runs `circle terms accept` itself. */
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

/** Never throws: an exception carrying a command line is how an OTP ends up in a log. */
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

type LoginRequest = {
  requestId?: unknown;
  email?: unknown;
  timestamp?: unknown;
  otpHead?: unknown;
};

/** The half of a login request that is safe to say out loud. */
export type PendingLogin = { requestId: string; email: string; otpHead?: string };

type TermsRecord = { accepted?: unknown; acceptedAt?: unknown; acceptedVia?: unknown };

/** Read from disk, so it survives a restart and answers the same in a new thread. */
export async function termsAccepted(home: string): Promise<boolean> {
  try {
    const raw = await readFile(join(circleCliHome(home), 'terms.json'), 'utf-8');
    const record = JSON.parse(raw) as TermsRecord;

    return record.accepted === true;
  } catch {
    return false;
  }
}

/** From the CLI's own files, not memory. Returns three fields; the rest stays on disk. */
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
      // A half-written file is not worth failing the request over.
    }
  }

  live.sort((a, b) => b.at - a.at);

  return live[0];
}
