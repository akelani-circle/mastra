// Circle's instructions arrive as documents the agent fetches mid-run, and the shell trims command
// output before the model sees it — the right shape for a log, the wrong one for a document whose
// first instruction is near the top. `wallet-pay.md` is 27KB of guidance the agent reads before it
// spends. So a plain fetch of one of these documents is answered here, in full, instead.

/** Circle's published skill instructions and the index that lists them, pinned to host and path. */
const CIRCLE_DOC_URL =
  /^https:\/\/agents\.circle\.com\/(?:skills\/[a-z0-9-]+\.md|\.well-known\/agent-skills\/index\.json)$/;

const MAX_DOC_BYTES = 96 * 1024;

const FETCH_TIMEOUT_MS = 30_000;

/**
 * The Circle document a command fetches for the model to read, if that is all it does.
 *
 * A command that redirects, pipes or chains is left alone: `curl … -o setup.md` is the agent saving
 * a file, and answering it with a body it never asked to see would leave it reading a file that was
 * never written.
 */
export function circleDocFetched(command: string): string | undefined {
  const single = command.trim();
  if (/[|&;><]|\$\(|`/.test(single)) return undefined;
  if (!/^curl\b/.test(single)) return undefined;
  // `-o` and `-O` write to disk, and `--output` is the same flag spelled out.
  if (/(?:^| )(?:-[a-zA-Z]*[oO]|--output|--remote-name)(?: |$)/.test(single)) return undefined;

  const urls = single.split(/\s+/).filter(word => word.startsWith('http'));
  if (urls.length !== 1) return undefined;
  return CIRCLE_DOC_URL.test(urls[0]!) ? urls[0] : undefined;
}

/**
 * Fetch a Circle document in full, or return nothing so the caller can let the shell run the
 * command instead — a truncated document beats no document.
 */
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
