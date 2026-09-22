// Circle sign-in for Studio, which has neither a terminal nor a login form — a front end uses
// `./control-plane` instead. The OTP does pass through the model's context here, which the rest of
// the template avoids; Studio offers no other way to collect one. Treat a code typed here as spent.

import { createTool } from '@mastra/core/tools';
import type { ToolPayloadTransformTargetConfig } from '@mastra/core/tools';
import { z } from 'zod';

import { circle, pendingLogin, termsAccepted } from './circle-cli';
import { tenantHome } from './tenancy';

/** Named in the approval, so the user is deciding about something they can read. */
const TERMS_URL = 'https://www.circle.com/legal/developer-terms';

/** Either spelling the CLI accepts: six digits, or the full `B1X-123456` with its prefix. */
const OTP = /^(?:[A-Za-z0-9]{3}-)?\d{6}$/;

/** `requireApproval` is the whole design: the agent can ask, and only the user can answer. */
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

/** Half a login. The request id stays on disk, where `circle-submit-code` finds it. */
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
    // Without this, an unaccepted Terms surfaces as PERMISSION_DENIED about the wallet.
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

type SubmitInput = { otp: string };
type SubmitOutput = { loggedIn: boolean; email?: string; message?: string };

// Masks the code in the UI and the replayed transcript; `execute` still gets the real one, and the
// original is still stored beside it. Every phase is spelled out because an omitted one is blanked.
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

/** The code is not logged or echoed back; the only thing that survives is the CLI's session. */
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

/** Under the ids the agent's instructions and its shell block name. */
export const loginTools = {
  'circle-accept-terms': acceptCircleTermsTool,
  'circle-wallet-login': circleLoginTool,
  'circle-submit-code': submitCircleCodeTool,
};
