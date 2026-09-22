// Mastra rejects a skill whose `description` runs past 1024 characters, and Circle's
// `pay-via-agent-wallet` is 1128 — so the skill that tells this agent how to pay never loads.
// Shortens the copy Mastra parses; nothing is written back to `~/.agents/skills`.
// A stopgap: when Mastra's limit rises, pass the skills path straight to the workspace instead.

import matter from 'gray-matter';

import { LocalSkillSource } from '@mastra/core/workspace';
import type { SkillSource, SkillSourceEntry, SkillSourceStat } from '@mastra/core/workspace';

/** Hard-coded because `SKILL_LIMITS` is declared in Mastra's types but not exported at runtime. */
const MAX_DESCRIPTION_LENGTH = 1024;

const ELISION = '[…]';

/** Drops middle sentences: the ends carry the purpose and the trigger phrases, the middle examples. */
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

  // One very long sentence never enters the loop above, so it is cut.
  return joined.length > MAX_DESCRIPTION_LENGTH ? `${joined.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…` : joined;
}

/** Re-emitted with a YAML library, not a regex: the field is a quoted scalar with escapes inside. */
export function clampSkillDescription(skillMd: string): string {
  try {
    const parsed = matter(skillMd);
    const description = parsed.data?.description;
    if (typeof description !== 'string' || description.length <= MAX_DESCRIPTION_LENGTH) return skillMd;
    return matter.stringify(parsed.content, { ...parsed.data, description: shorten(description) });
  } catch {
    // Unparseable front matter is handed back untouched, so Mastra fails on it as it would have.
    return skillMd;
  }
}

/** `LocalSkillSource`, with `SKILL.md` rewritten on the way past. */
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
    if (!path.endsWith('SKILL.md')) return contents;
    return clampSkillDescription(contents.toString());
  }
}
