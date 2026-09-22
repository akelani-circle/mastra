// Not a sandbox. For a ceiling no instruction can argue past, cap spending with `circle wallet limit set`.

/** Matched anywhere in a segment, so a pipe or a `$(…)` cannot slip one through. */
const SPENDS: readonly RegExp[] = [
  /\bcircle services pay\b/,
  /\bcircle wallet transfer\b/,
  /\bcircle bridge transfer\b/,
  /\bcircle gateway (deposit|withdraw)\b/,
  // A signature can authorise a later transfer, so it spends too, only afterwards.
  /\bcircle wallet (swap|execute|sign)\b/,
];

/** Wait on a one-time code, which must never pass through the agent. */
const USER_ONLY: readonly RegExp[] = [
  /\bcircle terms (accept|reset)\b/,
  /\bcircle wallet login\b/,
  /\bcircle wallet limit (set|reset)\b/,
];

/** `--tool claude-code` and `--tool codex` write directories this agent never reads. */
const WRONG_SKILL_STORE: readonly RegExp[] = [/\bcircle skill install\b/];

const ESTIMATE = /(?:^| )--estimate(?: |$)/;
const HELP = /(?:^| )(?:--help|-h)(?: |$)/;

function isReadOnlyInvocation(segment: string): boolean {
  if (HELP.test(segment)) return true;
  // Starts with, so a payment hidden inside a substitution stays gated.
  if (!segment.startsWith('circle services pay ')) return false;
  // One payment per segment: `… pay X --estimate $(… pay Y)` reads as an estimate and is not.
  const payments = segment.match(/\bcircle services pay\b/g) ?? [];
  return payments.length === 1 && ESTIMATE.test(segment);
}

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

export function requiresApproval(command: string): boolean {
  return matches(command, SPENDS);
}

export function requiresUserTerminal(command: string): boolean {
  return matches(command, USER_ONLY);
}

/** `circle wallet limit set` is absent: a cap the agent can raise is not a cap. */
const SERVED_BY_TOOL: readonly RegExp[] = [/\bcircle terms accept\b/, /\bcircle wallet login\b/];

export function servedByLoginTool(command: string): boolean {
  return matches(command, SERVED_BY_TOOL);
}

export function installsSkillsElsewhere(command: string): boolean {
  return matches(command, WRONG_SKILL_STORE);
}
