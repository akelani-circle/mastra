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

// The registry's global install directory, which `~/.claude/skills` and friends symlink into.
const skillsDir = (home: string) => join(home, '.agents', 'skills');

// Named, not counted: this directory is shared, so an unrelated skill is not a finished setup.
const CIRCLE_SKILL = 'use-circle-cli';

/** Half of "has setup run?", asked about the machine so it survives a new thread and a restart. */
async function hasSkills(home: string): Promise<boolean> {
  try {
    const files = await readdir(join(skillsDir(home), CIRCLE_SKILL));
    // An empty directory left by a failed install must not read as a finished setup.
    return files.includes('SKILL.md');
  } catch {
    return false;
  }
}

/** The other half: a tenant can be signed in while the skill install failed. Expiry is not checked. */
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

// The caller's home, from the execution context both hooks are handed.
const callerContext = (context: unknown): RequestContext | undefined =>
  (context as { requestContext?: RequestContext } | undefined)?.requestContext;

const callerHome = (context: unknown): string => tenantHome(callerContext(context));

// A sandbox inherits nothing but PATH, so everything the CLI needs is named here.
// No DBus, and that omission is what keeps two callers off one wallet: the CLI's keyring entry is
// `agent-session-mainnet` for everyone, so out of reach of a keyring it falls back to a 0600 file
// under this caller's own `CIRCLE_CLI_HOME`. `CIRCLE_ACCEPT_TERMS` is absent on purpose.
const SESSION_ENV_VARS = [
  'PATH',
  'HOME',
  // Lets child Node processes use host TLS settings such as `--use-system-ca`.
  'NODE_OPTIONS',
  // npm's own directories on Windows, which the skills install needs.
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
];

function sandboxEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Colour escapes and deprecation warnings are noise the model has to read past.
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
  };
  for (const name of SESSION_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  // Last, so it wins over the inherited one.
  env.HOME = home;
  env.USERPROFILE = home;
  // A container's default prefix is root-owned; the control plane can only find an agreed location.
  env.npm_config_prefix = cliPrefix(home);
  env.PATH = cliPath(home);
  // Read ahead of the CLI's own `homedir()`, so a session does not rest on how a child resolves it.
  env.CIRCLE_CLI_HOME = circleCliHome(home);
  return env;
}

/** Mastra re-reads the skills directory every 30s, a window the agent crosses in a single step. */
async function refreshSkillCatalogue(context: unknown, home: string): Promise<void> {
  if (!(await hasSkills(home))) return;
  const root = workspace.skills;
  if (!root) return;
  // The unscoped view calls the resolver with no context, and that resolver throws without a caller.
  const skills = (await root.getScoped?.({ requestContext: callerContext(context) })) ?? root;
  const known = await skills.list();
  if (known.some(skill => skill.name === CIRCLE_SKILL)) return;
  await skills.refresh();
}

// A full terminal, with an approval gate: the run suspends on any command that spends.
const workspace = new Workspace({
  id: 'circle-workspace',
  name: 'Circle Workspace',
  // Per request, not built once: one sandbox per caller is what stops two of them sharing a wallet.
  sandbox: ({ requestContext }) => {
    const home = tenantHome(requestContext);

    return new LocalSandbox({
      id: `circle-cli-${basename(home)}`,
      env: sandboxEnv(home),
      // Where the user's own terminal would be, and where a global skill install lands.
      workingDirectory: home,
      // Marketplace searches, paid calls and package installs all outrun the 30s default.
      timeout: 180_000,
    });
  },
  // Background-process tools reach a sandbox a previous request created, so this keys on the caller.
  sandboxCacheKey: ({ requestContext }) => tenantHome(requestContext),
  // Uncontained because the sandbox already reaches the whole filesystem, so this grants nothing new.
  filesystem: ({ requestContext }) =>
    new LocalFilesystem({ basePath: tenantHome(requestContext), contained: false }),
  // On the workspace rather than the agent because only the workspace takes a `skillSource`.
  skills: ({ requestContext }) => [skillsDir(tenantHome(requestContext))],
  skillSource: new ClampedSkillSource(),
  tools: {
    // Refusals come back as the tool's own result, so the model reads what to do next in place.
    hooks: {
      beforeToolCall: async ({ workspaceToolName, input, context }) => {
        if (workspaceToolName !== WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND) return;
        // The default 200-line tail returns the closing brackets of a JSON document. No line limit
        // hands the whole thing to the token budget below, which keeps both ends.
        const args = input as { tail?: number | null };
        if (args.tail == null) args.tail = 0;
        const command = String((input as { command?: unknown })?.command ?? '');
        const home = callerHome(context);
        if (requiresUserTerminal(command)) {
          // In Studio the refusal points at the tools, not a terminal the user does not have.
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
        // Ahead of the redirect below: with no `git` the command it redirects *to* fails the same way.
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
          // A failed fetch falls through to the shell: `curl` may succeed where this did not.
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
          // This hook trails a command that already ran, and one of those spends money.
          return;
        }
        await refreshSkillCatalogue(context, home);
      },
    },
    // The shell, plus reading. Writing and deleting stay off; the shell does those, under the gate.
    enabled: false,
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
      enabled: true,
      requireApproval: ({ args }) => requiresApproval(String(args.command ?? '')),
      // The only thing trimming output now, and it keeps a tenth as the head — 2,000 would leave 200.
      maxOutputTokens: 6_000,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { enabled: true },
    [WORKSPACE_TOOLS.FILESYSTEM.GREP]: { enabled: true },
  },
});

// Any model Mastra can route to, so swapping providers is an edit to `.env` and its API key.
const MODEL = process.env.AGENT_MODEL || 'openai/gpt-5.6-sol';

// How to hold a tool, and nothing about Circle — that belongs to the skills.
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
  // Every wallet-specific rule lives in the document the bootstrap line fetches, not here.
  instructions: async ({ requestContext }) => {
    const identity =
      "You manage the user's Circle USDC wallet by running the `circle` CLI in your shell, and " +
      'your skills tell you how.';
    const base = `${identity}\n\n${OPERATING_RULES}`;

    // `GET /api/agents/:id` resolves this with no caller; refusing would hide the agent from Studio.
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
  // Only for Studio, which has neither a terminal nor a front end calling `../control-plane`.
  tools: ({ requestContext }) => (isStudioCaller(requestContext) ? loginTools : {}),
  memory: new Memory({
    options: {
      generateTitle: true,
      // At the default 10 the agent forgets it ran setup and runs it again.
      lastMessages: 40,
    },
  }),
  defaultOptions: {
    // Setup, then search, inspect and pay: the default 5 cuts that off partway.
    maxSteps: 40,
    modelSettings: {
      maxRetries: 4,
      // Mastra's own setting rather than a provider's, so it survives changing the model above.
      reasoning: 'high',
    },
  },
});
