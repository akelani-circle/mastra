import { mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RequestContext } from '@mastra/core/request-context';

/** Where a caller's identity is read from. Our own front end sends exactly this. */
export const IDENTITY_KEY = 'user-id';

/** Named by `./studio`, since Studio has no field to send an identity in. */
export const STUDIO_CALLER = 'studio';

function resolveRoot(): string {
  const preferred = join(homedir(), '.circle-agent', 'tenants');

  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    // A container running as a UID with no passwd entry gets an unwritable `homedir()`.
    const fallback = join(tmpdir(), 'circle-agent-tenants');
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

const TENANT_ROOT = resolveRoot();

/** No shared home to fall back to: falling back is how every caller ends up on one wallet. */
export class MissingIdentityError extends Error {
  constructor() {
    super(
      `No \`${IDENTITY_KEY}\` in requestContext. Every request must name the caller it belongs to; ` +
        'there is no shared workspace to fall back to.',
    );
    this.name = 'MissingIdentityError';
  }
}

/** The identity arrives in a request body, so `../../root` is a thing a caller can send. */
function safeSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
}

export function tenantHome(requestContext?: RequestContext): string {
  const id = requestContext?.get(IDENTITY_KEY);

  return tenantHomeFor(typeof id === 'string' ? id : undefined);
}

/** For the control-plane routes, which are plain handlers with no `RequestContext` to read. */
export function tenantHomeFor(id?: string): string {
  const segment = typeof id === 'string' ? safeSegment(id) : '';

  if (!segment) throw new MissingIdentityError();

  const home = join(TENANT_ROOT, segment);
  mkdirSync(home, { recursive: true });

  return home;
}
