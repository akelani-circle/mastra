// Circle's skills install by cloning a git repository, and a deployed image may have no git.
//
// `npx skills add circlefin/skills -g` — the universal fallback Circle's setup document publishes —
// spawns `git` and dies with ENOENT, and `circle skill install` shells out to the same command. The
// failure is quiet: the setup document says to carry on to the login step, so setup appears to
// finish while the skills directory was never written, and the bootstrap line returns on every
// request forever.
//
// So the install is done here instead, from the tarball GitHub serves for the same commit the clone
// would have fetched. With git on the machine — every laptop — this file does nothing.

import { execFile } from 'node:child_process';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The archive of the tree `git clone` would have produced. `HEAD` so the branch can be renamed. */
const TARBALL = 'https://codeload.github.com/circlefin/skills/tar.gz/HEAD';

/** Where the skills sit inside that archive, below the one top-level directory GitHub adds. */
const SKILLS_PATH = ['plugins', 'circle', 'skills'];

/** Comfortably larger than the ~850KB Circle publishes, and a stop on a repository that grows. */
const MAX_BYTES = 16 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 60_000;

/** Asked once per process: it is a property of the image and cannot change under a running server. */
let gitProbe: Promise<boolean> | undefined;

export function gitAvailable(): Promise<boolean> {
  gitProbe ??= run('git', ['--version'], { timeout: 5_000 }).then(
    () => true,
    () => false,
  );

  return gitProbe;
}

/**
 * Whether a command is trying to install Circle's skills. Both spellings reach the same clone. The
 * `npx` form is matched only for Circle's own repository.
 */
export function installsCircleSkills(command: string): boolean {
  const single = command.trim();

  if (/\bcircle\s+skill\s+install\b/.test(single)) return true;

  return /\bskills\s+add\b/.test(single) && /\bcirclefin\/skills\b/.test(single);
}

/** The single directory GitHub wraps an archive in, whatever the branch is called. */
async function topLevel(staging: string): Promise<string | undefined> {
  const entries = await readdir(staging, { withFileTypes: true });
  const dirs = entries.filter(entry => entry.isDirectory());

  return dirs.length === 1 ? dirs[0]!.name : undefined;
}

/**
 * Install Circle's skills into `destination`, or return nothing so the caller can let the original
 * command run and fail on its own terms.
 *
 * Staged inside the destination's own parent, not `/tmp`: the last step is a rename, and a rename
 * across two filesystems is not a rename at all.
 */
export async function installCircleSkills(destination: string): Promise<string | undefined> {
  const staging = join(dirname(destination), '.circle-skills-download');

  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await mkdir(destination, { recursive: true });

    const response = await fetch(TARBALL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;

    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.byteLength === 0 || archive.byteLength > MAX_BYTES) return undefined;

    const tarball = join(staging, 'skills.tar.gz');
    await writeFile(tarball, archive);
    await run('tar', ['-xzf', tarball, '-C', staging], { timeout: 60_000 });

    const root = await topLevel(staging);
    if (!root) return undefined;

    const source = join(staging, root, ...SKILLS_PATH);
    const skills = (await readdir(source, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();

    if (skills.length === 0) return undefined;

    for (const skill of skills) {
      const target = join(destination, skill);
      // Replaced rather than merged: a half-written skill must not survive under a good copy.
      await rm(target, { recursive: true, force: true });
      await rename(join(source, skill), target);
    }

    return (
      `Installed ${skills.length} Circle skills into ${destination}:\n` +
      skills.map(skill => `  - ${skill}`).join('\n') +
      '\n\nThis machine has no `git`, so the registry could not clone; the same skills were taken ' +
      "from Circle's published archive instead. They are installed and ready — do not run the " +
      'install again, and carry on with the setup from the next step.'
    );
  } catch {
    return undefined;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
