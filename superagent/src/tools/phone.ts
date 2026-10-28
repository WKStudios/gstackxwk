/** Outbound phone calls (Twilio) to chase people or pass on a message. */

import { z } from 'zod';
import { defineTool, ToolError, type ToolDef } from './types';

export const phoneTools: ToolDef[] = [
  defineTool({
    name: 'place_call',
    description:
      'Phone someone on the owner\'s behalf: a synthesized voice delivers your message and can ask one question, recording the spoken answer. Use to chase a reply, confirm a booking, or pass on a message. The result comes back to this chat when the call ends. Always identify yourself as calling for the owner. Needs approval.',
    ownerOnly: true,
    input: z.object({
      to: z.string().describe('E.164 phone number, e.g. +447700900123'),
      name: z.string().describe('Who you are calling'),
      message: z.string().describe('What the voice says first. Start with who is calling and on whose behalf.'),
      question: z.string().optional().describe('One question to ask and record the answer to'),
    }),
    approval: input =>
      `📞 Call ${input.name} (${input.to})\nSays: "${input.message.slice(0, 300)}"${input.question ? `\nAsks: "${input.question.slice(0, 200)}"` : ''}`,
    run: async (input, ctx) => {
      const { twilio, store } = ctx.services;
      if (!twilio) throw new ToolError('Phone calls aren\'t configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER).');
      if (!/^\+\d{7,15}$/.test(input.to)) throw new ToolError('Use an E.164 number like +447700900123.');
      const call = store.createCall(ctx.conversationId, input.to, `${input.name}: ${input.question ?? input.message}`);
      const sid = await twilio.placeCall({ callId: call.id, to: input.to, message: input.message, question: input.question });
      store.updateCall(call.id, 'dialing', `twilio_sid=${sid}`);
      return `Calling ${input.name} now (${call.id}). The outcome will arrive in this chat when the call ends.`;
    },
  }),
];
