import { timingSafeEqual } from 'node:crypto';

import { registerApiRoute } from '@mastra/core/server';

import { circle, pendingLogin, termsAccepted } from './circle-cli';
import { MissingIdentityError, tenantHomeFor } from './tenancy';

/**
 * The control plane: the two steps of Circle setup the agent is forbidden to take, as plain HTTP so
 * a front end can take them instead.
 *
 * `approval.ts` blocks `circle terms accept` and `circle wallet login` in the sandbox and tells the
 * user to run them in their own terminal, which assumes they have a shell on the machine the agent
 * runs on. Deployed, nobody does. These routes run the same commands in the same tenant directory,
 * on a request carrying a person's decision. The agent cannot call them and the shell gate stands.
 */

/** The header the front end proves itself with. */
const TOKEN_HEADER = 'x-control-plane-token';

/**
 * An empty allowlist, which is not the same as no CORS config: the server's default is `origin: '*'`
 * and these are the last four routes that should inherit it. The token is what actually stops
 * anyone; this only keeps a page the user happens to have open from becoming a caller.
 */
const NO_BROWSER = { origin: [] as string[] };

type WalletStatus = {
  mainnet?: { email?: unknown; tokenStatus?: unknown; expiresIn?: unknown };
};

/**
 * Whether the caller is our own front end. Constant-time, because these routes accept Terms of Use
 * and start logins. An unset token fails closed — the alternative is an open control plane on a
 * public URL.
 */
function authorised(presented: string | undefined): boolean {
  const expected = process.env.CONTROL_PLANE_TOKEN;

  if (!expected || !presented) return false;

  const a = Buffer.from(expected);
  const b = Buffer.from(presented);

  return a.length === b.length && timingSafeEqual(a, b);
}

/** The caller's home, or the reason there isn't one. */
function homeFor(body: unknown): { home: string } | { error: string } {
  const id = (body as { userId?: unknown } | undefined)?.userId;

  try {
    return { home: tenantHomeFor(typeof id === 'string' ? id : undefined) };
  } catch (error) {
    if (error instanceof MissingIdentityError) {
      return { error: 'No `userId` in the request body.' };
    }
    return { error: 'That caller has no usable workspace.' };
  }
}

/** A route that needs a token and a caller, with both checks written once rather than four times. */
const guarded = (
  handle: (home: string, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>
) => {
  return async (c: {
    req: { header: (name: string) => string | undefined; json: () => Promise<unknown> };
    json: (body: unknown, status?: number) => Response;
  }): Promise<Response> => {
    if (!authorised(c.req.header(TOKEN_HEADER))) {
      return c.json({ error: 'Not authorised.' }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Expected a JSON body.' }, 400);
    }

    const resolved = homeFor(body);
    if ('error' in resolved) return c.json({ error: resolved.error }, 400);

    const result = await handle(resolved.home, (body ?? {}) as Record<string, unknown>);

    return c.json(result.body, result.status);
  };
};

/**
 * Where setup has got to, as a fact about the filesystem rather than about the conversation, so it is
 * still true after a restart or in a second browser.
 *
 * `wallet status` is skipped until the Terms are accepted because the CLI gates every command behind
 * them: run early, it fails with PERMISSION_DENIED and says nothing about the wallet.
 */
const statusRoute = registerApiRoute('/circle/status', {
  method: 'POST',
  cors: NO_BROWSER,
  handler: guarded(async home => {
    const accepted = await termsAccepted(home);

    if (!accepted) {
      return {
        status: 200,
        body: { termsAccepted: false, loggedIn: false, awaitingOtp: false },
      };
    }

    const pending = await pendingLogin(home);
    const status = await circle<WalletStatus>(home, ['wallet', 'status']);
    const mainnet = status.ok ? status.data.mainnet : undefined;

    return {
      status: 200,
      body: {
        termsAccepted: true,
        loggedIn: mainnet?.tokenStatus === 'VALID',
        ...(typeof mainnet?.email === 'string' ? { email: mainnet.email } : {}),
        ...(typeof mainnet?.expiresIn === 'string' ? { expiresIn: mainnet.expiresIn } : {}),
        awaitingOtp: pending !== undefined,
        ...(pending?.otpHead ? { otpHead: pending.otpHead } : {}),
        ...(pending?.email ? { pendingEmail: pending.email } : {}),
      },
    };
  }),
});

/**
 * Records the acceptance a person just made. The route does not decide anything — that is the whole
 * distinction between this and the agent doing it — and it refuses to write one down twice.
 */
const acceptTermsRoute = registerApiRoute('/circle/terms/accept', {
  method: 'POST',
  cors: NO_BROWSER,
  handler: guarded(async home => {
    if (await termsAccepted(home)) {
      return { status: 200, body: { termsAccepted: true, alreadyAccepted: true } };
    }

    const result = await circle<{ message?: string }>(home, ['terms', 'accept']);

    if (!result.ok) {
      return { status: 502, body: { error: result.message, code: result.code } };
    }

    return { status: 200, body: { termsAccepted: true, alreadyAccepted: false } };
  }),
});

/**
 * Starts a login: Circle emails a code, and the CLI writes the request that code answers to. The
 * request id stays here — the completing call finds it on disk, so it cannot be replayed from a
 * browser's history.
 */
const initLoginRoute = registerApiRoute('/circle/login/init', {
  method: 'POST',
  cors: NO_BROWSER,
  handler: guarded(async (home, body) => {
    const email = typeof body.email === 'string' ? body.email.trim() : '';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { status: 400, body: { error: 'That does not look like an email address.' } };
    }
    if (!(await termsAccepted(home))) {
      return { status: 409, body: { error: "Circle's Terms have not been accepted yet." } };
    }

    const result = await circle<{ message?: string }>(home, [
      'wallet',
      'login',
      email,
      '--type',
      'agent',
      '--init',
    ]);

    if (!result.ok) {
      return { status: 502, body: { error: result.message, code: result.code } };
    }

    const pending = await pendingLogin(home);

    return {
      status: 200,
      body: {
        otpSent: true,
        email,
        // Circle puts this prefix in the email too. A code whose prefix does not match it is a code
        // someone else asked for.
        ...(pending?.otpHead ? { otpHead: pending.otpHead } : {}),
      },
    };
  }),
});

/**
 * Finishes a login with the code from the user's inbox. The code arrives, is spent, and is not
 * written down: not logged, not echoed back, not stored. The only thing that survives this handler
 * is the session the CLI writes.
 */
const completeLoginRoute = registerApiRoute('/circle/login/complete', {
  method: 'POST',
  cors: NO_BROWSER,
  handler: guarded(async (home, body) => {
    const otp = typeof body.otp === 'string' ? body.otp.trim() : '';

    if (!/^(?:[A-Za-z0-9]{3}-)?\d{6}$/.test(otp)) {
      return { status: 400, body: { error: 'That does not look like a Circle code.' } };
    }

    const pending = await pendingLogin(home);

    if (!pending) {
      return {
        status: 409,
        body: { error: 'No sign-in is waiting for a code, or the last one expired.' },
      };
    }

    const result = await circle<{ email?: string }>(home, [
      'wallet',
      'login',
      '--request',
      pending.requestId,
      '--otp',
      otp,
    ]);

    if (!result.ok) {
      return { status: 502, body: { error: result.message, code: result.code } };
    }

    return { status: 200, body: { loggedIn: true, email: pending.email } };
  }),
});

export const controlPlaneRoutes = [
  statusRoute,
  acceptTermsRoute,
  initLoginRoute,
  completeLoginRoute,
];
