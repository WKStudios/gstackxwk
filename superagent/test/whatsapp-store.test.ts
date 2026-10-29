import { describe, expect, test } from 'bun:test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parseWebhook, verifyChallenge, verifySignature, WhatsAppChannel } from '../src/channels/whatsapp';
import { Store, ftsQuery } from '../src/store';
import { clock } from '../src/clock';
import { tempDir } from './helpers';

const cfg = {
  token: 'tok',
  phoneNumberId: '123',
  appSecret: 'secret',
  verifyToken: 'verify',
  graphVersion: 'v24.0',
  templateName: 'agent_update',
  templateLanguage: 'en',
};

function fakeGraph() {
  const requests: { url: string; body: any; init?: RequestInit }[] = [];
  let failVoice = false;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    requests.push({ url, body, init });
    if (url.endsWith('/media')) return Response.json({ id: 'media_1' });
    if (failVoice && body?.audio?.voice) return Response.json({ error: { message: 'voice not supported' } }, { status: 400 });
    return Response.json({ messages: [{ id: `wamid.${requests.length}` }] });
  };
  return { requests, fetchImpl, setFailVoice: (v: boolean) => (failVoice = v) };
}

describe('WhatsApp webhook', () => {
  test('signature verification', () => {
    const body = '{"a":1}';
    const sig = `sha256=${crypto.createHmac('sha256', 'secret').update(body).digest('hex')}`;
    expect(verifySignature('secret', body, sig)).toBe(true);
    expect(verifySignature('secret', body + ' ', sig)).toBe(false);
    expect(verifySignature('secret', body, null)).toBe(false);
    expect(verifySignature('secret', body, 'sha256=abc')).toBe(false);
  });

  test('verification handshake', () => {
    expect(verifyChallenge(new URL('https://x/w?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=42'), 'verify')).toBe('42');
    expect(verifyChallenge(new URL('https://x/w?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42'), 'verify')).toBeNull();
  });

  test('parses every message type we handle', () => {
    const value = {
      contacts: [{ wa_id: '1555', profile: { name: 'Ada' } }],
      statuses: [{ status: 'failed', recipient_id: '1555', errors: [{ code: 131047, title: 'Re-engagement message' }] }],
      messages: [
        { from: '1555', id: 'm1', timestamp: '1761660000', type: 'text', text: { body: 'hi' }, context: { id: 'wamid.prev' } },
        { from: '1555', id: 'm2', timestamp: '1761660001', type: 'image', image: { id: 'img1', mime_type: 'image/jpeg', caption: 'receipt' } },
        { from: '1555', id: 'm3', timestamp: '1761660002', type: 'audio', audio: { id: 'aud1', mime_type: 'audio/ogg; codecs=opus', voice: true } },
        { from: '1555', id: 'm4', timestamp: '1761660003', type: 'document', document: { id: 'doc1', mime_type: 'application/pdf', filename: 'inv.pdf' } },
        { from: '1555', id: 'm5', timestamp: '1761660004', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'apv:x:yes', title: 'Approve' } } },
        { from: '1555', id: 'm6', timestamp: '1761660005', type: 'reaction', reaction: { message_id: 'wamid.out1', emoji: '👍' } },
        { from: '1555', id: 'm7', timestamp: '1761660006', type: 'location', location: { latitude: 51.5, longitude: -0.1, name: 'Office' } },
        { from: '1555', id: 'm8', timestamp: '1761660007', type: 'contacts', contacts: [{ name: { formatted_name: 'Sam' }, phones: [{ phone: '+44 1' }] }] },
        { from: '1555', id: 'm9', timestamp: '1761660008', type: 'order' },
      ],
    };
    const { messages, failures } = parseWebhook({ entry: [{ changes: [{ value }] }] });
    expect(failures[0]).toContain('131047');
    expect(messages.map(m => m.type)).toEqual(['text', 'image', 'audio', 'document', 'button', 'reaction', 'location', 'contacts', 'unsupported']);
    expect(messages[0]).toMatchObject({ text: 'hi', replyToId: 'wamid.prev', profileName: 'Ada' });
    expect(messages[2].media).toMatchObject({ id: 'aud1', voice: true });
    expect(messages[3].media).toMatchObject({ filename: 'inv.pdf', mime: 'application/pdf' });
    expect(messages[4].buttonId).toBe('apv:x:yes');
    expect(messages[5].reaction).toEqual({ messageId: 'wamid.out1', emoji: '👍' });
    expect(messages[7].text).toContain('Sam · +44 1');
  });
});

describe('WhatsApp sending', () => {
  test('long text is converted and chunked; only the first chunk quotes', async () => {
    const g = fakeGraph();
    const ch = new WhatsAppChannel(cfg, g.fetchImpl);
    await ch.sendText('1555', `**Hi**\n\n${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`, { replyTo: 'wamid.q' });
    expect(g.requests).toHaveLength(2);
    expect(g.requests[0].url).toBe('https://graph.facebook.com/v24.0/123/messages');
    expect(g.requests[0].body.text.body.startsWith('*Hi*')).toBe(true);
    expect(g.requests[0].body.context).toEqual({ message_id: 'wamid.q' });
    expect(g.requests[1].body.context).toBeUndefined();
    expect((g.requests[0].init!.headers as any).Authorization).toBe('Bearer tok');
  });

  test('buttons are capped at 3 with 20-char titles', async () => {
    const g = fakeGraph();
    await new WhatsAppChannel(cfg, g.fetchImpl).sendButtons('1555', 'Approve?', [
      { id: 'a', title: 'A very long button title indeed' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
      { id: 'd', title: 'D' },
    ]);
    const buttons = g.requests[0].body.interactive.action.buttons;
    expect(buttons).toHaveLength(3);
    expect(buttons[0].reply.title.length).toBeLessThanOrEqual(20);
  });

  test('voice notes upload then send, falling back to plain audio', async () => {
    const g = fakeGraph();
    g.setFailVoice(true);
    const file = path.join(tempDir(), 'v.ogg');
    fs.writeFileSync(file, 'OggS');
    await new WhatsAppChannel(cfg, g.fetchImpl).sendMedia('1555', { path: file, mime: 'audio/ogg', kind: 'audio', voice: true });
    expect(g.requests.map(r => r.url.split('/').pop())).toEqual(['media', 'messages', 'messages']);
    expect(g.requests[1].body.audio).toEqual({ id: 'media_1', voice: true });
    expect(g.requests[2].body.audio).toEqual({ id: 'media_1' });
  });

  test('templates carry a flattened preview', async () => {
    const g = fakeGraph();
    await new WhatsAppChannel(cfg, g.fetchImpl).sendTemplate('1555', 'Line one\nLine two');
    expect(g.requests[0].body.template).toEqual({
      name: 'agent_update',
      language: { code: 'en' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Line one Line two' }] }],
    });
  });

  test('API errors surface the Graph message', async () => {
    const ch = new WhatsAppChannel(cfg, async () => Response.json({ error: { message: 'Invalid OAuth access token' } }, { status: 401 }));
    await expect(ch.sendText('1555', 'x')).rejects.toThrow('Invalid OAuth access token');
  });
});

describe('Store', () => {
  const store = () => new Store(tempDir(), 'Europe/London', ':memory:');

  test('history is append-only and compaction moves the start pointer', () => {
    const s = store();
    s.appendMessages('owner', [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ]);
    const last = s.lastMessageId('owner');
    s.appendMessages('owner', [{ role: 'assistant', content: 'arrived during compaction' }]);
    s.applyCompaction('owner', { role: 'assistant', content: [{ type: 'compaction', content: 'sum', signature: 's' }] as any }, last);
    const h = s.history('owner');
    expect(h[0].content).toEqual([{ type: 'compaction', content: 'sum', signature: 's' }]);
    expect(h[1]).toEqual({ role: 'assistant', content: 'arrived during compaction' });
    expect(h).toHaveLength(2);
    s.resetHistory('owner');
    expect(s.history('owner')).toEqual([]);
  });

  test('memories upsert by scope+kind+subject and are searchable', () => {
    const s = store();
    const owner = ['owner', 'shared'];
    s.remember('owner', 'person', 'Jai Patel', 'CFO at Acme', ['acme']);
    const m = s.remember('owner', 'person', 'jai patel', 'CFO at Acme; prefers calls', ['acme'], true);
    expect(s.listMemories(owner)).toHaveLength(1);
    expect(m.pinned).toBe(1);
    expect(s.recall(owner, 'who is Jai?')[0].content).toContain('prefers calls');
    expect(s.recall(owner, 'acme')).toHaveLength(1);
    expect(s.recall(owner, '"; DROP TABLE memories; --')).toEqual([]);
    expect(s.forget(owner, m.id)).toBe(true);
    expect(s.recall(owner, 'jai')).toEqual([]);
  });

  test("members can't see or delete the owner's memories; shared ones are visible to all", () => {
    const s = store();
    const member = ['member:1555', 'shared'];
    const secret = s.remember('owner', 'person', 'Dr Lee', 'my therapist, Tuesdays', [], true);
    s.remember('shared', 'project', 'Atlas', 'launch on 12 Nov');
    s.remember('member:1555', 'preference', 'replies', 'bullet points');
    expect(s.recall(member, 'Lee therapist')).toEqual([]);
    expect(s.pinnedMemories(member)).toEqual([]);
    expect(s.forget(member, secret.id)).toBe(false);
    expect(s.listMemories(member).map(m => m.subject).sort()).toEqual(['Atlas', 'replies']);
    expect(s.listMemories(['owner', 'shared']).map(m => m.subject).sort()).toEqual(['Atlas', 'Dr Lee']);
  });

  test('FTS queries are sanitized', () => {
    expect(ftsQuery('when did "Jai" email me?')).toBe('"when" OR "did" OR "jai" OR "email" OR "me"');
    expect(ftsQuery('?!')).toBeNull();
  });

  test('transcript search', () => {
    const s = store();
    s.addTranscript('owner', 'user', 'whatsapp', 'Remind me about the Lisbon offsite budget');
    s.addTranscript('owner', 'agent', 'whatsapp', 'Done.');
    expect(s.searchTranscript('owner', 'lisbon')[0].text).toContain('Lisbon');
    expect(s.searchTranscript('member:1', 'lisbon')).toEqual([]);
  });

  test('24h window with safety margin', () => {
    const s = store();
    const real = clock.now;
    try {
      clock.now = () => new Date('2026-10-28T10:00:00Z');
      s.touchWindow('whatsapp:1555');
      clock.now = () => new Date('2026-10-29T09:00:00Z');
      expect(s.windowOpen('whatsapp:1555')).toBe(true);
      clock.now = () => new Date('2026-10-29T09:55:00Z');
      expect(s.windowOpen('whatsapp:1555')).toBe(false);
      expect(s.windowOpen('whatsapp:other')).toBe(false);
    } finally {
      clock.now = real;
    }
  });

  test('usage is bucketed by local day', () => {
    const s = store();
    s.recordUsage({ conversationId: 'owner', kind: 'chat', model: 'm', inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0, webSearches: 1, costUsd: 0.5 });
    s.recordUsage({ conversationId: 'owner', kind: 'job', model: 'm', inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0, webSearches: 0, costUsd: 0.25 });
    expect(s.usageForDay()).toMatchObject({ cost: 0.75, calls: 2, searches: 1 });
  });

  test('hosted files expire', () => {
    const s = store();
    const token = s.hostFile('/tmp/x.pdf', 'x.pdf', 'application/pdf', 1);
    expect(s.hostedFile(token)?.filename).toBe('x.pdf');
    const real = clock.now;
    try {
      clock.now = () => new Date(Date.now() + 2 * 3600_000);
      expect(s.hostedFile(token)).toBeNull();
    } finally {
      clock.now = real;
    }
  });
});
