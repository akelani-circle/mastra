// A skill Circle publishes, that Mastra will not load, and the smallest thing that changes that.
//
// Mastra caps a skill's `description` at 1024 characters and rejects anything longer rather than
// trimming it — a rejected skill is not in the catalogue at all. Circle's `pay-via-agent-wallet` is
// 1128 characters, so the one skill that tells this agent how to pay is the one skill missing, and
// the failure reads as the model declining to use a skill it was never offered.
//
// Nothing is written back: `~/.agents/skills` is shared with every other agent on the machine and
// `circle skill update` owns what is in it, so this shortens the copy Mastra parses.
//
// A stopgap. When Mastra's limit rises, delete it and pass the skills path straight to the workspace.

import matter from 'gray-matter';

import { LocalSkillSource } from '@mastra/core/workspace';
import type { SkillSource, SkillSourceEntry, SkillSourceStat } from '@mastra/core/workspace';

/** Hard-coded because `SKILL_LIMITS` is declared in Mastra's types but not exported at runtime. */
const MAX_DESCRIPTION_LENGTH = 1024;

/** What stands in for the sentences that were dropped. */
const ELISION = '[…]';

/**
 * Shorten a description to fit, taking sentences from the middle.
 *
 * The ends are the parts worth keeping: a description opens by saying what the skill is for and
 * closes with the trigger phrases a model matches against. What sits between them is usually
 * examples. Truncating at the limit would do the opposite — take the triggers, leave the examples.
 */
function shorten(description: string): string {
  const sentences = description.split(/(?<=\.)\s+/);
  const kept = [...sentences];
  while (kept.length > 2 && kept.join(' ').length + ELISION.length + 2 > MAX_DESCRIPTION_LENGTH) {
    kept.splice(Math.ceil(kept.length / 2) - 1, 1);
  }

  const half = Math.ceil(kept.length / 2);
  const joined =
    kept.length < sentences.length
      ? `${kept.slice(0, half).join(' ')} ${ELISION} ${kept.slice(half).join(' ')}`
      : kept.join(' ');

  // A description written as one very long sentence never enters the loop above, so it is cut.
  return joined.length > MAX_DESCRIPTION_LENGTH ? `${joined.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…` : joined;
}

/**
 * Rewrite a `SKILL.md` whose description is too long, and return every other one unchanged.
 *
 * Parsed and re-emitted with a YAML library rather than patched with a regular expression, because
 * the field is a quoted scalar with escapes inside it — Circle's runs to embedded quotation marks.
 */
export function clampSkillDescription(skillMd: string): string {
  try {
    const parsed = matter(skillMd);
    const description = parsed.data?.description;
    if (typeof description !== 'string' || description.length <= MAX_DESCRIPTION_LENGTH) return skillMd;
    return matter.stringify(parsed.content, { ...parsed.data, description: shorten(description) });
  } catch {
    // Front matter that will not parse is handed back untouched, so Mastra fails on it exactly as it
    // would have without this source in the way.
    return skillMd;
  }
}

/**
 * Reads skills from disk exactly as Mastra would, with over-long descriptions shortened in passing:
 * every method below is the built-in one, with a single file's contents rewritten on the way past.
 */
export class ClampedSkillSource implements SkillSource {
  readonly #source = new LocalSkillSource();

  exists(path: string): Promise<boolean> {
    return this.#source.exists(path);
  }

  stat(path: string): Promise<SkillSourceStat> {
    return this.#source.stat(path);
  }

  readdir(path: string): Promise<SkillSourceEntry[]> {
    return this.#source.readdir(path);
  }

  realpath(path: string): Promise<string> {
    return this.#source.realpath ? this.#source.realpath(path) : Promise.resolve(path);
  }

  async readFile(path: string): Promise<string | Buffer> {
    const contents = await this.#source.readFile(path);
    // Only the manifest carries the description; references and scripts pass through untouched.
    if (!path.endsWith('SKILL.md')) return contents;
    return clampSkillDescription(contents.toString());
  }
}
