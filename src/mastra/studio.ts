// `tenancy.ts` refuses a request with no `user-id`, and Studio has no field to put one in.
// `Origin` is written by the caller, so this is a convenience, not an authentication boundary.

import type { RequestContext } from '@mastra/core/request-context';
import type { Middleware } from '@mastra/core/server';

import { IDENTITY_KEY, STUDIO_CALLER } from './tenancy';

const CLOUD_STUDIO = '.studio.mastra.cloud';

/** A Studio looking at this very server: same-origin, or a Cloud page on the project's subdomain. */
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

/** Mounted after Mastra's own context middleware has put `requestContext` on the Hono context. */
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

export function isStudioCaller(requestContext?: RequestContext): boolean {
  return requestContext?.get(IDENTITY_KEY) === STUDIO_CALLER;
}
