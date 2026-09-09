// Circle sign-in, in the conversation, for the caller with no front end of its own.
//
// `approval.ts` blocks `circle terms accept` and `circle wallet login` in the shell, and its advice —
// paste the command into your own terminal — assumes a shell on the machine the agent runs on. A
// front end calls `./control-plane` instead. Mastra Studio is neither: no terminal, and no place to
// put a login form. So the login runs as three tools the agent drives and cannot finish alone.
//
// About the code. The template's own rule is that an OTP never passes through the model's context,
// and here it does, because Studio's chat has no other way to collect one: its suspended-tool UI is
// read-only, and its only interactive path is approve/decline. What is left of the rule is that the
// code is single-use and expires in ten minutes. Treat a code typed here as a code spent.

import { createTool } from '@mastra/core/tools';
import type { ToolPayloadTransformTargetConfig } from '@mastra/core/tools';
import { z } from 'zod';

import { circle, pendingLogin, termsAccepted } from './circle-cli';
import { tenantHome } from './tenancy';

/** Named in the approval, so the user is deciding about something they can read. */
const TERMS_URL = 'https://www.circle.com/legal/developer-terms';

/** Either spelling the CLI accepts: six digits, or the full `B1X-123456` with its prefix. */
const OTP = /^(?:[A-Za-z0-9]{3}-)?\d{6}$/;

/**
 * Accepting Circle's Terms of Use, as an approval rather than a tool call. `requireApproval` is the
 * whole design: the agent can ask, and only the user can answer, which is what keeps Circle's rule
 * intact where a plain tool would break it.
 */
export const acceptCircleTermsTool = createTool({
  id: 'circle-accept-terms',
  description:
    "Ask the user to accept Circle's Terms of Use, which every other `circle` command is gated " +
    'behind. Requires the user to approve; you cannot accept on their behalf. Call this when ' +
    '`circle wallet status` reports the Terms have not been accepted, and show them the terms at ' +
    `${TERMS_URL} when you do.`,
  inputSchema: z.object({}),
  outputSchema: z.object({
    accepted: z.boolean(),
    alreadyAccepted: z.boolean().optional(),
    message: z.string().optional(),
  }),
  requireApproval: true,
  execute: async (_input, context) => {
    const home = tenantHome(context.requestContext);

    if (await termsAccepted(home)) {
      return { accepted: true, alreadyAccepted: true };
    }

    const result = await circle<{ message?: string }>(home, ['terms', 'accept']);

    if (!result.ok) {
      return { accepted: false, message: result.message };
    }

    return { accepted: true, alreadyAccepted: false };
  },
});

/**
 * Asking Circle to send a code — half a login. It hands back the anti-phishing prefix so the user
 * about to read a code out of their inbox can tell whether it is theirs. The request id stays on
 * disk, where `circle-submit-code` finds it.
 */
export const circleLoginTool = createTool({
  id: 'circle-wallet-login',
  description:
    'Start signing the user in to Circle with their email address. Circle emails them a one-time ' +
    'code. Ask the user for their email in chat and never invent one. Requires the Terms to be ' +
    'accepted first. After this succeeds, show them the returned prefix, ask them to paste the ' +
    'code from their email, and pass it to `circle-submit-code` — that call is what finishes the ' +
    'login.',
  inputSchema: z.object({
    email: z.string().describe('The email address the user gave you. Never invent one.'),
  }),
  outputSchema: z.object({
    codeSent: z.boolean(),
    email: z.string().optional(),
    otpHead: z
      .string()
      .optional()
      .describe(
        'The anti-phishing prefix Circle put in the email. Show it to the user: a code that does ' +
          'not carry this prefix belongs to someone else and must not be submitted.',
      ),
    message: z.string().optional(),
  }),
  execute: async ({ email }, context) => {
    const home = tenantHome(context.requestContext);
    const address = email.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      return { codeSent: false, message: 'That does not look like an email address.' };
    }
    // A login run before acceptance fails with PERMISSION_DENIED — an error about the Terms wearing
    // the costume of an error about the wallet.
    if (!(await termsAccepted(home))) {
      return {
        codeSent: false,
        message:
          "Circle's Terms have not been accepted yet. Call `circle-accept-terms` first, then try again.",
      };
    }

    const init = await circle<{ message?: string }>(home, [
      'wallet',
      'login',
      address,
      '--type',
      'agent',
      '--init',
    ]);

    if (!init.ok) {
      return { codeSent: false, message: init.message };
    }

    const pending = await pendingLogin(home);

    return {
      codeSent: true,
      email: address,
      ...(pending?.otpHead ? { otpHead: pending.otpHead } : {}),
    };
  },
});

/** What `circle-submit-code` is called with and answers, named so its transform can be typed. */
type SubmitInput = { otp: string };
type SubmitOutput = { loggedIn: boolean; email?: string; message?: string };

/**
 * What the code looks like to everything that keeps a copy. The `input` phase is replaced with a
 * mask, so the rendered call and the transcript replayed on later turns carry `******`; `execute`
 * still receives the real one.
 *
 * A reduction and not a fix: the transformed value is stored beside the original, so the code is
 * still on disk. What it buys is that the code stops being replayed into the model's context every
 * turn, and stops being shown in the UI.
 *
 * Every other phase is spelled out because configuring a target opts the whole payload in, and a
 * phase with no transformer is replaced by a placeholder — an omitted line here would blank the
 * tool's result.
 */
const SUBMIT_PHASES: ToolPayloadTransformTargetConfig<SubmitInput, SubmitOutput> = {
  // The streaming half, which would otherwise spell the code out one token at a time.
  inputDelta: () => '',
  input: () => ({ otp: '******' }),
  output: ({ output }) => output,
  error: ({ error }) => error,
  approval: () => ({ otp: '******' }),
  suspend: ({ suspendPayload }) => suspendPayload,
  resume: ({ resumeData }) => resumeData,
};

/**
 * Spending the code, and finishing the login. The code is not logged, not echoed back in the result,
 * and not stored here — the only thing that survives is the session the CLI writes.
 */
export const submitCircleCodeTool = createTool({
  id: 'circle-submit-code',
  description:
    'Finish the sign-in started by `circle-wallet-login`, using the one-time code the user pasted ' +
    'into the chat. Pass it exactly as they wrote it — six digits, or the full form with Circle’s ' +
    'prefix. Never guess a code, never reuse one, and never call this without a code the user has ' +
    'just given you. On success the wallet is ready and no `circle wallet create` is needed.',
  inputSchema: z.object({
    otp: z.string().describe('The code the user pasted: 123456, or the full B1X-123456.'),
  }),
  outputSchema: z.object({
    loggedIn: z.boolean(),
    email: z.string().optional(),
    message: z.string().optional(),
  }),
  transform: { display: SUBMIT_PHASES, transcript: SUBMIT_PHASES },
  execute: async ({ otp }, context) => {
    const home = tenantHome(context.requestContext);
    const code = otp.trim();

    if (!OTP.test(code)) {
      return { loggedIn: false, message: 'That does not look like a Circle code.' };
    }

    const pending = await pendingLogin(home);

    if (!pending) {
      return {
        loggedIn: false,
        message:
          'No sign-in is waiting for a code, or the last one expired. Start again with ' +
          '`circle-wallet-login`.',
      };
    }

    const result = await circle<{ email?: string }>(home, [
      'wallet',
      'login',
      '--request',
      pending.requestId,
      '--otp',
      code,
    ]);

    if (!result.ok) {
      return { loggedIn: false, message: result.message };
    }

    return { loggedIn: true, email: pending.email };
  },
});

/** All three, under the ids the agent's instructions and its shell block name. */
export const loginTools = {
  'circle-accept-terms': acceptCircleTermsTool,
  'circle-wallet-login': circleLoginTool,
  'circle-submit-code': submitCircleCodeTool,
};
