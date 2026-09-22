// The shell tails command output, which truncates a document whose first instruction is near the
// top — `wallet-pay.md` is 27KB the agent reads before it spends. Fetches of these are answered here.

/** Circle's published skill instructions and the index that lists them, pinned to host and path. */
const CIRCLE_DOC_URL =
  /^https:\/\/agents\.circle\.com\/(?:skills\/[a-z0-9-]+\.md|\.well-known\/agent-skills\/index\.json)$/;

const MAX_DOC_BYTES = 96 * 1024;

const FETCH_TIMEOUT_MS = 30_000;

/** A command that redirects, pipes or chains is left alone — `curl … -o setup.md` saves a file. */
export function circleDocFetched(command: string): string | undefined {
  const single = command.trim();
  if (/[|&;><]|\$\(|`/.test(single)) return undefined;
  if (!/^curl\b/.test(single)) return undefined;
  if (/(?:^| )(?:-[a-zA-Z]*[oO]|--output|--remote-name)(?: |$)/.test(single)) return undefined;

  const urls = single.split(/\s+/).filter(word => word.startsWith('http'));
  if (urls.length !== 1) return undefined;
  return CIRCLE_DOC_URL.test(urls[0]!) ? urls[0] : undefined;
}

/** Returns nothing on failure so the caller can fall back to the shell: truncated beats missing. */
export async function readCircleDoc(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const body = await response.text();
    if (!body || body.length > MAX_DOC_BYTES) return undefined;
    return body;
  } catch {
    return undefined;
  }
}
