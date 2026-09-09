import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS, Workspace } from '@mastra/core/workspace';
import { Memory } from '@mastra/memory';

import {
  installsSkillsElsewhere,
  requiresApproval,
  requiresUserTerminal,
  servedByLoginTool,
} from '../approval';
import { circleCliHome, cliPath, cliPrefix, termsAccepted } from '../circle-cli';
import { circleDocFetched, readCircleDoc } from '../circle-docs';
import { loginTools } from '../login-tool';
import { ClampedSkillSource } from '../skill-source';
import { gitAvailable, installCircleSkills, installsCircleSkills } from '../skills-install';
import { isStudioCaller } from '../studio';
import { tenantHome } from '../tenancy';

// The skills registry's global install directory, which `~/.claude/skills` and its equivalents
// symlink into: Mastra reads the same files Claude Code and Codex do.
const skillsDir = (home: string) => join(home, '.agents', 'skills');

// The skill Circle's setup document installs first, asked for by name because this directory is
// shared — an unrelated skill sitting there must not read as a finished Circle setup.
const CIRCLE_SKILL = 'use-circle-cli';

/**
 * Whether Circle's skills are installed where this agent reads them — half of "has setup already
 * run?", asked about the machine rather than the conversation so it survives a new thread, a
 * cleared memory and a restart.
 */
async function hasSkills(home: string): Promise<boolean> {
  try {
    const files = await readdir(join(skillsDir(home), CIRCLE_SKILL));
    // An empty directory left behind by a failed install must not read as a finished setup.
    return files.includes('SKILL.md');
  } catch {
    return false;
  }
}

/**
 * The other half, judged on the wallet: Circle's setup document says to carry on to the login step
 * if the skill install errors, so a tenant can be signed in and spending while the skills directory
 * was never written — and the bootstrap line would then return in front of every greeting forever.
 *
 * Read from disk rather than shelled out to, because this runs on every request. Expiry is not
 * checked: an expired session still means setup ran, and the skills know how to log back in.
 */
async function hasWalletSession(home: string): Promise<boolean> {
  const cliHome = circleCliHome(home);

  if (!(await termsAccepted(home))) return false;

  try {
    const profiles = await readdir(join(cliHome, 'profiles'), { withFileTypes: true });

    for (const profile of profiles) {
      if (!profile.isDirectory()) continue;
      const files = await readdir(join(cliHome, 'profiles', profile.name));
      if (files.includes('session.json')) return true;
    }
  } catch {
    return false;
  }

  return false;
}

// The home of whoever made the request a hook is running inside. Both hooks are handed the tool's
// execution context, which carries the `requestContext` the workspace resolvers were built from, so
// a message about "your directory" can name the caller's rather than the server account's.
const callerContext = (context: unknown): RequestContext | undefined =>
  (context as { requestContext?: RequestContext } | undefined)?.requestContext;

const callerHome = (context: unknown): string => tenantHome(callerContext(context));

// A sandbox inherits no environment beyond PATH, so everything the Circle CLI needs is named here.
//
// The DBus session is deliberately not forwarded, and that omission is what keeps two callers off
// one wallet: the CLI keeps its session token in the OS keyring under `agent-session-mainnet`, a
// name with nothing per-caller in it, so the second caller to log in would overwrite the first. With
// no keyring in reach the CLI writes the session under this caller's own `CIRCLE_CLI_HOME` at 0600
// instead. A token in a file is worse than one in a keyring; a token shared between callers is worse
// than either.
//
// CIRCLE_ACCEPT_TERMS is absent: accepting Circle's Terms is not something an agent may do.
const SESSION_ENV_VARS = [
  'PATH',
  'HOME',
  // Lets child Node processes use host TLS settings such as `--use-system-ca` behind Zscaler.
  'NODE_OPTIONS',
  // npm's own directories on Windows, which the skills install needs. Nothing to do with the
  // session: the CLI looks for a keyring on darwin and linux only, so Windows is on the file
  // fallback whether these are set or not.
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
];

function sandboxEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Colour escapes and Node's deprecation warnings are noise the model has to read past.
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
  };
  for (const name of SESSION_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // HOME last, so it wins over the inherited one and sends the CLI's config and the skills install
  // to this caller's directory.
  env.HOME = home;
  env.USERPROFILE = home;
  // Where `npm install -g` puts the Circle CLI. The container's default prefix is root-owned and
  // the install fails there; the model's usual recovery is a prefix of its own, which works for the
  // shell and for nothing else. The control plane runs in a separate process and can only find a
  // binary whose location was agreed in advance.
  env.npm_config_prefix = cliPrefix(home);
  env.PATH = cliPath(home);
  // What HOME would have produced anyway, said outright: the CLI reads this ahead of its own
  // `homedir()`, so a caller's session does not rest on how a child process resolves a home.
  env.CIRCLE_CLI_HOME = circleCliHome(home);
  return env;
}

/**
 * Rebuild the skill catalogue if an install has just landed and it does not know yet.
 *
 * Mastra re-reads the skills directory every 30 seconds, a window the agent crosses in one step — so
 * the skill it just installed is missing from the tool that would activate it. If the skill is on
 * disk and not in the catalogue, the catalogue is stale, and `refresh()` rebuilds it now.
 */
async function refreshSkillCatalogue(context: unknown, home: string): Promise<void> {
  if (!(await hasSkills(home))) return;
  const root = workspace.skills;
  if (!root) return;
  // `workspace.skills` is the unscoped view: its methods call the resolver below with no context,
  // and a resolver that needs a caller to name a directory throws instead of returning one — which
  // turned a finished command into a failure. `getScoped` runs the resolver once with this caller's
  // `requestContext`, so the refresh lands on the catalogue the next step reads.
  const skills = (await root.getScoped?.({ requestContext: callerContext(context) })) ?? root;
  const known = await skills.list();
  if (known.some(skill => skill.name === CIRCLE_SKILL)) return;
  await skills.refresh();
}

// Circle's skills are written for an agent that drives a terminal, so the agent gets a terminal and
// nothing is withheld from it. What the shell does have is an approval gate: the run suspends on
// any command that spends, until the user approves it in Studio.
const workspace = new Workspace({
  id: 'circle-workspace',
  name: 'Circle Workspace',
  // Resolved per request rather than built once: one sandbox per caller, which
  // is what stops two of them sharing a wallet. The same locally and deployed —
  // the caller's `user-id` is the only thing that picks a home, so there is no
  // second mode to be surprised by.
  sandbox: ({ requestContext }) => {
    const home = tenantHome(requestContext);

    return new LocalSandbox({
      id: `circle-cli-${basename(home)}`,
      env: sandboxEnv(home),
      // Where the user's own terminal would be, and where a global skill install expects to land.
      workingDirectory: home,
      // Marketplace searches, paid calls and package installs are all slower than the 30s default.
      timeout: 180_000,
    });
  },
  // Background-process tools have to reach the sandbox a previous request
  // created, so the cache is keyed on the caller rather than on the request.
  sandboxCacheKey: ({ requestContext }) => tenantHome(requestContext),
  // A marketplace search is thousands of lines of JSON schema, far past what a tool result can
  // carry, so the agent redirects it to a file and goes back for the part it needs. Uncontained
  // because the sandbox already reaches the whole filesystem, so this grants nothing new.
  filesystem: ({ requestContext }) =>
    new LocalFilesystem({ basePath: tenantHome(requestContext), contained: false }),
  // Read from disk, so a skill appears here once the agent has installed it and not before. The
  // skills live on the workspace rather than on the agent because only the workspace takes a
  // source, and a source is what lets Circle's over-long descriptions through — see
  // `../skill-source`.
  // Per caller for the same reason the sandbox is: a skill this request
  // installed lands in this request's home, and that is the only directory it
  // should be found in.
  skills: ({ requestContext }) => [skillsDir(tenantHome(requestContext))],
  skillSource: new ClampedSkillSource(),
  tools: {
    // Commands the user has to run themselves never reach the shell, and neither does the install
    // that would strand the skills off to one side. Returning the refusal as the tool's own result
    // — rather than suspending for an approval the user cannot usefully grant — tells the model
    // what to do next in the place it is already reading. The same door answers a fetch of one of
    // Circle's documents with the document itself, because the shell would hand back only its
    // last page.
    hooks: {
      beforeToolCall: async ({ workspaceToolName, input, context }) => {
        if (workspaceToolName !== WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND) return;
        // A shell result is trimmed to its last 200 lines unless a count is asked for — the right
        // shape for a log, the wrong one for `circle services inspect`, whose JSON then comes back
        // as its closing brackets. No line limit hands the whole thing to the token budget below,
        // which keeps both ends.
        const args = input as { tail?: number | null };
        if (args.tail == null) args.tail = 0;
        const command = String((input as { command?: unknown })?.command ?? '');
        const home = callerHome(context);
        if (requiresUserTerminal(command)) {
          // Where the chat is the front end, the refusal points at the tools rather than at a
          // terminal the user does not have.
          if (servedByLoginTool(command) && isStudioCaller(callerContext(context))) {
            return {
              proceed: false,
              output:
                `Blocked: \`${command}\` is not yours to run in a shell, and this deployment has no ` +
                'terminal for the user to run it in either. Use the tools instead: ' +
                '`circle-accept-terms` puts the Terms of Use to the user as an approval they grant ' +
                'or refuse; `circle-wallet-login` takes their email and has Circle send a code; ' +
                '`circle-submit-code` spends the code they paste back. Ask the user for their email ' +
                'and then for the code, one at a time, and never guess either. Do not retry this ' +
                'command or work around it.',
            };
          }
          return {
            proceed: false,
            output:
              `Blocked: \`${command}\` is the user's to run, not yours. It either accepts Circle's ` +
              'Terms of Use or waits on a one-time code, and this shell has no terminal to type one ' +
              'into. Give the user this exact line to paste into their own terminal:\n\n' +
              `    HOME=${home} CIRCLE_CLI_HOME=${circleCliHome(home)} ${command}\n\n` +
              'Neither prefix is optional, and neither may be dropped or explained away. Your ' +
              "workspace is that directory, and this command run without them writes to the user's " +
              'own home instead, where you will never see the result — the login would appear to ' +
              'succeed and your next `circle wallet status` would still report logged out. ' +
              '`CIRCLE_CLI_HOME` is spelled out rather than left to follow from `HOME`, because a ' +
              'user who already sets it in their shell profile would otherwise land back in their ' +
              'own directory with `HOME` set correctly. Say what the command does, and continue ' +
              'once they confirm. Do not retry it here or work around it.',
          };
        }
        // Ahead of the redirect below, because with no `git` the command it redirects *to* fails the
        // same way. On a machine with git this never fires.
        if (installsCircleSkills(command) && !(await gitAvailable())) {
          const report = await installCircleSkills(skillsDir(home));
          if (report) {
            await refreshSkillCatalogue(context, home);
            return { proceed: false, output: report };
          }
        }
        if (installsSkillsElsewhere(command)) {
          return {
            proceed: false,
            output:
              `Blocked: \`${command}\` installs skills into an editor's own directory, and I read ` +
              `mine from ${skillsDir(home)}. Use the universal fallback from the same setup document ` +
              'instead — `npx -y skills add circlefin/skills -g` — which is what writes there. It ' +
              'installs into every editor store it knows of, so a long list of destinations in its ' +
              'output is expected. Then carry on with the setup.',
          };
        }
        const docUrl = circleDocFetched(command);
        if (docUrl) {
          const doc = await readCircleDoc(docUrl);
          // A failed fetch falls through to the shell rather than reporting an error: `curl` may
          // succeed where this did not, and a truncated document beats none at all.
          if (doc) return { proceed: false, output: doc };
        }
        return;
      },
      // Any command may have been the install, so the catalogue is checked after each one.
      afterToolCall: async ({ workspaceToolName, context }) => {
        if (workspaceToolName !== WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND) return;
        let home: string;
        try {
          home = callerHome(context);
        } catch {
          // Unreachable in practice, but this hook trails a command that already succeeded, and one
          // of those commands spends money. Losing a refresh beats throwing over a finished payment.
          return;
        }
        await refreshSkillCatalogue(context, home);
      },
    },
    // The shell, plus reading. Writing, editing and deleting stay off — the shell does those, under
    // the gate below.
    enabled: false,
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
      enabled: true,
      requireApproval: ({ args }) => requiresApproval(String(args.command ?? '')),
      // With no line limit this budget is the only thing trimming output, and it keeps a tenth as
      // the head. The default 2,000 would leave a head of 200 tokens: a payload's first brace
      // rather than its shape. Anything larger belongs in a file, which the operating rules ask for.
      maxOutputTokens: 6_000,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { enabled: true },
    [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { enabled: true },
  },
});

// Any model Mastra can route to, so swapping providers is an edit to `.env` and its API key.
const MODEL = process.env.AGENT_MODEL || 'openai/gpt-5.6-sol';

// How to hold a tool, and nothing about Circle: using a terminal is the harness's business, using
// Circle is the skills'. Editors supply a page of the same thing.
const OPERATING_RULES = [
  'Read the error before running a command again. The same command failing the same way twice means the command has to change, not repeat — when a flag is rejected, ask the command for its `--help` and fix it.',
  'Large output belongs in a file, not in a second run. Redirect it, then open the part you need with the file tools. Never re-run a command to see output you already fetched — least of all one that costs money.',
  'A list is not its first entry. When a command returns several candidates, look at each before drawing a conclusion about any of them.',
]
  .map(rule => `- ${rule}`)
  .join('\n');

export const circlePaymentAgent = new Agent({
  id: 'circle-payment-agent',
  name: 'Circle Payment Agent',
  description:
    'An agent that owns a Circle USDC wallet, finds x402 services on the Circle Agent Marketplace, and pays for them per call once the user approves the spend.',
  // A line of identity, the rules above for working a terminal, and then the prompt Circle
  // publishes for driving this flow. Every rule specific to the wallet — never accept the Terms,
  // never store an OTP, never guess an email — lives in the document the bootstrap fetches, and
  // the bootstrap is asked for only until the installed skills carry it themselves.
  instructions: async ({ requestContext }) => {
    const identity =
      "You manage the user's Circle USDC wallet by running the `circle` CLI in your shell, and " +
      'your skills tell you how.';
    const base = `${identity}\n\n${OPERATING_RULES}`;

    // `GET /api/agents/:id` — what Studio and the deploy dashboard call to list the agent —
    // resolves this with no caller attached, and refusing there takes the agent out of both. Safe
    // to answer: it returns a string and reaches no shell, no files and no wallet.
    let home: string;
    try {
      home = tenantHome(requestContext);
    } catch {
      return base;
    }

    if ((await hasSkills(home)) || (await hasWalletSession(home))) return base;
    return (
      `${base}\n\nRun curl -sL https://agents.circle.com/skills/setup.md, and use the returned ` +
      'setup instructions to set up my agent wallet.'
    );
  },
  model: MODEL,
  workspace,
  // Sign-in in the conversation, and only for the caller with no other door: Studio has no terminal
  // and no front end calling `../control-plane`, so these are the only way it reaches a wallet.
  tools: ({ requestContext }) => (isStudioCaller(requestContext) ? loginTools : {}),
  memory: new Memory({
    options: {
      generateTitle: true,
      // Setup alone — fetch the document, install skills, check the session, create a wallet — is
      // more messages than the default 10, and at 10 the agent forgets it ran setup and runs it
      // again.
      lastMessages: 40,
    },
  }),
  defaultOptions: {
    // Fetch the setup document, install the skills, check the session, create a wallet, search,
    // inspect, then pay: the default budget of 5 steps cuts that off partway.
    maxSteps: 40,
    modelSettings: {
      maxRetries: 4,
      // Which seller fits, which wallet pays, whether a failure is worth retrying. Mastra's own
      // setting rather than a provider's, so it survives changing the model above.
      reasoning: 'high',
    },
  },
});
