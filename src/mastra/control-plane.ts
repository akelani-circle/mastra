import { timingSafeEqual } from 'node:crypto';

import { registerApiRoute } from '@mastra/core/server';

import { circle, pendingLogin, termsAccepted } from './circle-cli';
import { MissingIdentityError, tenantHomeFor } from './tenancy';

// The two steps of Circle setup the agent is forbidden to take, as plain HTTP so a front end can
// take them instead. `approval.ts` tells the user to run them in a terminal; deployed, they have none.

const TOKEN_HEADER = 'x-control-plane-token';

/** Not the same as no CORS config: the server's default is `origin: '*'`, which these must not inherit. */
const NO_BROWSER = { origin: [] as string[] };

type WalletStatus = {
  mainnet?: { email?: unknown; tokenStatus?: unknown; expiresIn?: unknown };
};

/** An unset token fails closed: the alternative is an open control plane on a public URL. */
function authorised(presented: string | undefined): boolean {
  const expected = process.env.CONTROL_PLANE_TOKEN;

  if (!expected || !presented) return false;

  const a = Buffer.from(expected);
  const b = Buffer.from(presented);

  return a.length === b.length && timingSafeEqual(a, b);
}

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

/** `wallet status` waits on the Terms: run early it fails with PERMISSION_DENIED and says nothing. */
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

/** Records a decision a person made; the route does not make one. */
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

/** The request id never leaves the server, so the completing call cannot be replayed from a browser. */
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
        // Circle puts this prefix in the email: a code that does not carry it is someone else's.
        ...(pending?.otpHead ? { otpHead: pending.otpHead } : {}),
      },
    };
  }),
});

/** The code is spent and not written down; the only thing that survives is the CLI's session. */
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
