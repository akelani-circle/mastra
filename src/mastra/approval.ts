// Which shell commands stop for the user first, and which the agent may not run at all.
//
// Most of what the agent does is recoverable, so the default is to run. What stops is what cannot be
// taken back: a stablecoin transfer has no chargeback, and x402 settles before the seller answers.
// This is not a sandbox — for a ceiling no instruction can argue past, cap spending with
// `circle wallet limit set`.

/** Matched anywhere in a segment, so a pipe or a `$(…)` cannot slip one through. */
const SPENDS: readonly RegExp[] = [
  // x402 charges before the request resolves, so this is spent on send.
  /\bcircle services pay\b/,
  /\bcircle wallet transfer\b/,
  /\bcircle bridge transfer\b/,
  /\bcircle gateway (deposit|withdraw)\b/,
  // A signature can authorise a later transfer, so it spends just as surely, only afterwards.
  /\bcircle wallet (swap|execute|sign)\b/,
];

/**
 * Commands only the user can complete, in a terminal the agent does not have. Circle's own rule for
 * the first; the rest wait on a one-time code, which must never pass through the agent.
 */
const USER_ONLY: readonly RegExp[] = [
  /\bcircle terms (accept|reset)\b/,
  /\bcircle wallet login\b/,
  /\bcircle wallet limit (set|reset)\b/,
];

/**
 * Installs that put skills where this agent does not look: `--tool claude-code` writes an editor's
 * plugin directory, `--tool codex` writes `.agents/skills` relative to the working directory. The
 * universal fallback from the same setup document writes the one directory the agent reads.
 */
const WRONG_SKILL_STORE: readonly RegExp[] = [/\bcircle skill install\b/];

// `circle services pay --estimate` returns a price without signing, and `--help` prints text.
// Prompting for either trains the user to approve payment dialogs without reading them.
const ESTIMATE = /(?:^| )--estimate(?: |$)/;
const HELP = /(?:^| )(?:--help|-h)(?: |$)/;

/** Whether a single command spends nothing despite naming a gated one. */
function isReadOnlyInvocation(segment: string): boolean {
  if (HELP.test(segment)) return true;
  // Starts with, so a payment hidden inside a substitution stays gated.
  if (!segment.startsWith('circle services pay ')) return false;
  // One payment per segment: `… pay X --estimate $(… pay Y)` reads as an estimate and is not.
  const payments = segment.match(/\bcircle services pay\b/g) ?? [];
  return payments.length === 1 && ESTIMATE.test(segment);
}

/** A shell line is not one command, so each piece is judged on its own. */
function segmentsOf(command: string): string[] {
  return command
    .split(/\|\||&&|[;|\n]/)
    .map(segment => segment.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function matches(command: string, patterns: readonly RegExp[]): boolean {
  return segmentsOf(command).some(
    segment => patterns.some(pattern => pattern.test(segment)) && !isReadOnlyInvocation(segment),
  );
}

/**
 * Whether `command` spends money, and so needs the user to approve it first. Deliberately narrow —
 * an approval prompt the user answers by reflex protects nothing when the one that matters arrives.
 */
export function requiresApproval(command: string): boolean {
  return matches(command, SPENDS);
}

/** Whether `command` is one the user has to run themselves. */
export function requiresUserTerminal(command: string): boolean {
  return matches(command, USER_ONLY);
}

/**
 * The two blocked commands the login tools can complete without a terminal. `circle wallet limit
 * set` is deliberately absent: a spending cap the agent can raise is not a cap.
 */
const SERVED_BY_TOOL: readonly RegExp[] = [/\bcircle terms accept\b/, /\bcircle wallet login\b/];

/** Whether a blocked `command` has a tool that can finish it in the conversation. */
export function servedByLoginTool(command: string): boolean {
  return matches(command, SERVED_BY_TOOL);
}

/** Whether `command` installs skills somewhere this agent would never find them. */
export function installsSkillsElsewhere(command: string): boolean {
  return matches(command, WRONG_SKILL_STORE);
}
