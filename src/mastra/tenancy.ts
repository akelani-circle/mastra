import { mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RequestContext } from '@mastra/core/request-context';

/** Where a caller's identity is read from. Our own front end sends exactly this. */
export const IDENTITY_KEY = 'user-id';

/** The caller Studio's own chat is attributed to. See `./studio`. */
export const STUDIO_CALLER = 'studio';

function resolveRoot(): string {
  const preferred = join(homedir(), '.circle-agent', 'tenants');

  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    // A container running as a UID with no passwd entry gets a `homedir()` it cannot write to.
    // /tmp always works; a restart empties it and every tenant logs into Circle again.
    const fallback = join(tmpdir(), 'circle-agent-tenants');
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

const TENANT_ROOT = resolveRoot();

/**
 * Thrown when a request arrives without an identity to attribute it to. There is no shared home to
 * fall back to — falling back is how every caller ends up spending one wallet.
 */
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

/** The home directory for this request, created if it does not exist yet. */
export function tenantHome(requestContext?: RequestContext): string {
  const id = requestContext?.get(IDENTITY_KEY);

  return tenantHomeFor(typeof id === 'string' ? id : undefined);
}

/**
 * The same directory, for a caller named outright. The control-plane routes are plain HTTP
 * handlers with no `RequestContext` to read, and both paths have to agree about which directory a
 * caller owns — otherwise the wallet a route logs in is not the wallet the agent spends from.
 */
export function tenantHomeFor(id?: string): string {
  const segment = typeof id === 'string' ? safeSegment(id) : '';

  if (!segment) throw new MissingIdentityError();

  const home = join(TENANT_ROOT, segment);
  mkdirSync(home, { recursive: true });

  return home;
}
