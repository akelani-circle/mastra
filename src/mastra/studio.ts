// Naming the one caller that cannot name itself.
//
// `tenancy.ts` refuses a request with no `user-id`, and Mastra Studio has no field to put one in —
// so a deployment whose only front end is Studio refuses every request Studio makes. This names
// `studio` for it, and only when the request came from Studio's own page.
//
// `Origin` is a header the caller writes, so this is a convenience and not an authentication
// boundary. Cap the wallet with `circle wallet limit set` on anything strangers can reach.

import type { RequestContext } from '@mastra/core/request-context';
import type { Middleware } from '@mastra/core/server';

import { IDENTITY_KEY, STUDIO_CALLER } from './tenancy';

/** Where Mastra Cloud serves a deployment's Studio from, as a host suffix rather than one URL. */
const CLOUD_STUDIO = '.studio.mastra.cloud';

/**
 * Whether `origin` is a Studio looking at this very server: a Mastra Cloud page on the project's
 * own subdomain, or the Studio this process serves itself, which is same-origin. A front end on
 * another port is cross-origin here and gets the refusal it would have got anyway.
 */
function fromStudio(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return false;

  let hostname: string;
  let sameOrigin: boolean;

  try {
    const url = new URL(origin);
    hostname = url.hostname;
    sameOrigin = host === url.host;
  } catch {
    return false;
  }

  return sameOrigin || hostname.endsWith(CLOUD_STUDIO);
}

/**
 * Mounted in `./index`, after Mastra's own context middleware has put the `requestContext` on the
 * Hono context. Setting the id here keeps one answer to "who is this": the workspace resolvers, the
 * skills directory and the CLI home all read the field they always did.
 */
export const studioCallerMiddleware: Middleware = async (c, next) => {
  const requestContext = c.get('requestContext') as RequestContext | undefined;

  if (
    requestContext &&
    !requestContext.get(IDENTITY_KEY) &&
    fromStudio(c.req.header('origin'), c.req.header('host'))
  ) {
    requestContext.set(IDENTITY_KEY, STUDIO_CALLER);
  }

  return next();
};

/** Whether this request is the one the middleware named. Read by the agent to pick its sign-in. */
export function isStudioCaller(requestContext?: RequestContext): boolean {
  return requestContext?.get(IDENTITY_KEY) === STUDIO_CALLER;
}
