/**
 * Outbound phone calls via Twilio: say a message, optionally ask one question
 * and capture the spoken answer. Callbacks land on /twilio/* and the result is
 * handed back to the agent as an automated turn.
 */

import * as crypto from 'crypto';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function callTwiml(opts: { message: string; question?: string; gatherUrl: string; voice?: string }): string {
  const voice = opts.voice ?? 'Polly.Joanna';
  const say = (t: string) => `<Say voice="${voice}">${xmlEscape(t)}</Say>`;
  const gather = opts.question
    ? `<Gather input="speech" action="${xmlEscape(opts.gatherUrl)}" method="POST" speechTimeout="auto" timeout="8">${say(opts.question)}</Gather>${say("Sorry, I didn't catch that. I'll pass on the message. Goodbye.")}`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say(opts.message)}${gather}<Hangup/></Response>`;
}

/** Twilio request signature: base64(HMAC-SHA1(authToken, url + sorted key/value pairs)). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', authToken).update(data, 'utf-8').digest('base64');
}

export class TwilioClient {
  constructor(
    private readonly cfg: { accountSid: string; authToken: string; fromNumber: string },
    private readonly publicBaseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  verify(url: string, params: Record<string, string>, signature: string | null): boolean {
    if (!signature) return false;
    const expected = twilioSignature(this.cfg.authToken, url, params);
    return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  async placeCall(opts: { callId: string; to: string; message: string; question?: string }): Promise<string> {
    const twiml = callTwiml({
      message: opts.message,
      question: opts.question,
      gatherUrl: `${this.publicBaseUrl}/twilio/gather/${opts.callId}`,
    });
    if (twiml.length > 4000) throw new Error('Call script is too long; keep the message under ~3000 characters');
    const body = new URLSearchParams({
      To: opts.to,
      From: this.cfg.fromNumber,
      Twiml: twiml,
      StatusCallback: `${this.publicBaseUrl}/twilio/status/${opts.callId}`,
      StatusCallbackMethod: 'POST',
    });
    const resp = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${this.cfg.accountSid}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`Twilio ${resp.status}: ${json.message ?? 'call failed'}`);
    return json.sid as string;
  }
}
