import { describe, expect, test } from 'bun:test';
import * as crypto from 'crypto';
import { createHandler } from '../src/server';
import { twilioSignature } from '../src/integrations/twilio';
import { saveFile } from '../src/tools/files';
import type { WebEvent } from '../src/channels/web';
import { idle, makeApp, until } from './helpers';

const WA_ENV = {
  WHATSAPP_TOKEN: 'tok',
  WHATSAPP_PHONE_NUMBER_ID: '123',
  WHATSAPP_APP_SECRET: 'appsecret',
  WHATSAPP_VERIFY_TOKEN: 'verify-me',
};

const sign = (body: string) => `sha256=${crypto.createHmac('sha256', 'appsecret').update(body).digest('hex')}`;

describe('WhatsApp webhook', () => {
  test('handshake, signature check, and inbound messages', async () => {
    const { app, wa, claude } = makeApp({ env: WA_ENV });
    const handle = createHandler(app);
    const ok = await handle(new Request('https://agent.example.com/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=777'));
    expect(await ok.text()).toBe('777');
    expect((await handle(new Request('https://agent.example.com/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1'))).status).toBe(403);

    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ from: '15550001111', id: 'wamid.A', timestamp: '1761660000', type: 'text', text: { body: 'hello from the phone' } }] } }] }],
    });
    const forged = await handle(new Request('https://agent.example.com/webhook/whatsapp', { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=00' } }));
    expect(forged.status).toBe(401);

    const res = await handle(new Request('https://agent.example.com/webhook/whatsapp', { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } }));
    expect(res.status).toBe(200);
    // Meta retries; a duplicate delivery must not trigger a second turn.
    await handle(new Request('https://agent.example.com/webhook/whatsapp', { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body) } }));
    await until(() => wa.texts().length > 0);
    await idle(app);
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0].messages[0].content[0].text).toBe('hello from the phone');
    expect(wa.texts()).toEqual(['ok']);
  });
});

describe('web chat', () => {
  test('token sign-in sets a cookie; the page, history and send need it', async () => {
    const { app, claude } = makeApp({ app: { onlyGivenChannels: false } });
    const handle = createHandler(app);
    expect((await handle(new Request('https://agent.example.com/chat'))).status).toBe(401);
    expect((await handle(new Request('https://agent.example.com/chat/history'))).status).toBe(401);

    const login = await handle(new Request('https://agent.example.com/chat?token=admin-secret'));
    expect(login.status).toBe(302);
    const setCookie = login.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Secure');
    const cookie = setCookie.split(';')[0];

    const page = await handle(new Request('https://agent.example.com/chat', { headers: { cookie } }));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Superagent</title>');

    const events: WebEvent[] = [];
    app.web.subscribe('owner', ev => events.push(ev));
    const sent = await handle(
      new Request('https://agent.example.com/chat/send', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi from the browser' }),
      }),
    );
    expect(sent.status).toBe(200);
    await until(() => events.length > 0);
    await idle(app);
    expect(events[0]).toMatchObject({ type: 'text', text: 'ok' });
    expect(claude.calls[0].messages.at(-1).content).toContain('Channel: web chat.');
    const history = (await (await handle(new Request('https://agent.example.com/chat/history', { headers: { cookie } }))).json()) as any[];
    expect(history.map(h => [h.speaker, h.text])).toEqual([
      ['user', 'hi from the browser'],
      ['agent', 'ok'],
    ]);
  });

  test('the inline page script parses', async () => {
    const { app } = makeApp({ app: { onlyGivenChannels: false } });
    const handle = createHandler(app);
    const login = await handle(new Request('https://agent.example.com/chat?token=admin-secret'));
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const html = await (await handle(new Request('https://agent.example.com/chat', { headers: { cookie } }))).text();
    const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
    // Parse only — catches template-literal escaping mistakes in the inline JS.
    expect(() => new Function(script)).not.toThrow();
  });
});

describe('files, OAuth and phone callbacks', () => {
  test('hosted files are sandboxed and expire', async () => {
    const { app, s } = makeApp();
    const handle = createHandler(app);
    const file = saveFile(s.store.filesDir, 'out', 'note.html', '<script>alert(1)</script>');
    const token = s.store.hostFile(file, 'note.html', 'text/html');
    const res = await handle(new Request(`https://agent.example.com/files/${token}/note.html`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await handle(new Request('https://agent.example.com/files/deadbeef/x'))).status).toBe(404);
  });

  test('a stale Google callback is rejected', async () => {
    const { app } = makeApp({ env: { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' } });
    const res = await createHandler(app)(new Request('https://agent.example.com/oauth/google/callback?code=x&state=forged'));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('expired');
  });

  test('Twilio callbacks are signature-checked and hand the answer to the agent', async () => {
    const env = { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'twtoken', TWILIO_FROM_NUMBER: '+15550009999' };
    const { app, s, claude, wa } = makeApp({ env });
    s.store.touchWindow('whatsapp:15550001111');
    const handle = createHandler(app);
    const call = s.store.createCall('owner', '+447700900123', 'Sam: when will the contract be signed?');
    const url = `https://agent.example.com/twilio/gather/${call.id}`;
    const params = { SpeechResult: 'Friday afternoon', Confidence: '0.92', CallSid: 'CA1' };
    const unsigned = await handle(new Request(url, { method: 'POST', body: new URLSearchParams(params) }));
    expect(unsigned.status).toBe(403);
    const res = await handle(
      new Request(url, { method: 'POST', body: new URLSearchParams(params), headers: { 'x-twilio-signature': twilioSignature('twtoken', url, params) } }),
    );
    expect(await res.text()).toContain('<Say>Thank you. I will pass that on. Goodbye.</Say>');
    await until(() => wa.texts().length > 0);
    await idle(app);
    expect(claude.calls[0].messages[0].content[0].text).toContain('their answer: "Friday afternoon"');
    expect(s.store.getCall(call.id)!.transcript).toContain('They said: Friday afternoon');

    const statusUrl = `https://agent.example.com/twilio/status/${call.id}`;
    const statusParams = { CallStatus: 'completed', CallSid: 'CA1' };
    await handle(new Request(statusUrl, { method: 'POST', body: new URLSearchParams(statusParams), headers: { 'x-twilio-signature': twilioSignature('twtoken', statusUrl, statusParams) } }));
    await idle(app);
    // Already reported via the answer — no second update.
    expect(claude.calls).toHaveLength(1);
    expect(s.store.getCall(call.id)!.status).toBe('completed');
  });
});
