import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { botIdFromToken, DISCORD_INTENTS, DiscordChannel, type SocketLike } from '../src/channels/discord';
import type { InboundMessage } from '../src/channels/types';
import { FakeClaude, idle, makeApp, tempDir, text, until } from './helpers';

const BOT_ID = '123456789012345678';
const TOKEN = `${Buffer.from(BOT_ID).toString('base64').replace(/=+$/, '')}.GhIjKl.signature`;
const OWNER = '111111111111';
const STRANGER = '222222222222';

class FakeSocket implements SocketLike {
  sent: any[] = [];
  closed?: number;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closed = code;
  }
  /** A payload from Discord. */
  server(p: object) {
    this.onmessage?.({ data: JSON.stringify(p) });
  }
  drop(code: number) {
    this.onclose?.({ code, reason: '' });
  }
}

/** A fake Discord: gateway sockets plus a REST API that records every call. */
function fakeDiscord() {
  const sockets: FakeSocket[] = [];
  const rest: { method: string; path: string; body: any }[] = [];
  let n = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const p = url.replace('https://discord.com/api/v10', '');
    rest.push({ method: init?.method ?? 'GET', path: p, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    if (p === '/users/@me/channels') return Response.json({ id: `dm-${JSON.parse(String(init?.body)).recipient_id}` });
    if (p.endsWith('/typing') || p.endsWith('/callback')) return new Response(null, { status: 204 });
    if (p.startsWith('https://cdn.discordapp.com/')) return new Response('bytes', { headers: { 'content-type': 'audio/ogg' } });
    return Response.json({ id: `msg${++n}` });
  };
  const socket = (url: string) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  };
  return { sockets, rest, fetchImpl, socket, posts: (channelId: string) => rest.filter(r => r.path === `/channels/${channelId}/messages`) };
}

function setup(env: Record<string, string> = {}, claude?: FakeClaude) {
  const made = makeApp({ claude, env: { DISCORD_BOT_TOKEN: TOKEN, ...env } });
  const d = fakeDiscord();
  const discord = new DiscordChannel(made.s.config.discord!, made.s.store, 'https://agent.example.com', {
    fetchImpl: d.fetchImpl,
    socket: d.socket,
    agentName: 'Agent TNSE',
  });
  made.s.channels.set('discord', discord);
  return { ...made, d, discord };
}

function ready(ws: FakeSocket, heartbeatMs = 60_000) {
  ws.server({ op: 10, d: { heartbeat_interval: heartbeatMs } });
  ws.server({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess1', resume_gateway_url: 'wss://resume.discord.gg', user: { id: BOT_ID, username: 'AgentTNSE' } } });
}

const dm = (ws: FakeSocket, id: string, user: string, content: string, extra: object = {}) =>
  ws.server({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id, channel_id: `dm-${user}`, author: { id: user, username: `user${user.slice(0, 2)}` }, content, attachments: [], ...extra } });

describe('Discord', () => {
  test('identifies, heartbeats, resumes when asked to reconnect, and stops on a rejected token', async () => {
    const { d, discord } = setup();
    discord.connect(() => {});
    const ws = d.sockets[0];
    expect(ws.url).toBe('wss://gateway.discord.gg/?v=10&encoding=json');
    ws.server({ op: 10, d: { heartbeat_interval: 40 } });
    expect(ws.sent[0]).toMatchObject({ op: 2, d: { token: TOKEN, intents: DISCORD_INTENTS } });
    await until(() => ws.sent.some(p => p.op === 1));
    ws.server({ op: 11 });
    ws.server({ op: 0, t: 'READY', s: 5, d: { session_id: 'sess1', resume_gateway_url: 'wss://resume.discord.gg', user: { id: BOT_ID } } });

    ws.server({ op: 7 });
    expect(ws.closed).toBe(4000);
    const ws2 = d.sockets[1];
    expect(ws2.url).toBe('wss://resume.discord.gg/?v=10&encoding=json');
    ws2.server({ op: 10, d: { heartbeat_interval: 20 } });
    expect(ws2.sent[0]).toEqual({ op: 6, d: { token: TOKEN, session_id: 'sess1', seq: 5 } });

    // Heartbeats that go unacknowledged mean a dead connection: resume on a fresh one.
    await until(() => d.sockets.length === 3);
    expect(d.sockets[2].url).toBe('wss://resume.discord.gg/?v=10&encoding=json');

    // A rejected token can't be fixed by retrying.
    d.sockets[2].drop(4004);
    await Bun.sleep(50);
    expect(d.sockets).toHaveLength(3);
    discord.stop();
  });

  test('the pairing code links the owner; after that only the owner reaches the agent', async () => {
    const claude = new FakeClaude(() => ({ content: [text('Hi Ada!')] }));
    const { app, s, d, discord } = setup({ PRIMARY_CHANNEL: 'discord' }, claude);
    discord.connect(msg => void app.router.handleInbound(msg));
    const ws = d.sockets[0];
    ready(ws);

    dm(ws, 'm1', OWNER, 'hi');
    await until(() => d.posts(`dm-${OWNER}`).length === 1);
    expect(d.posts(`dm-${OWNER}`)[0].body.content).toContain('pairing code');
    expect(claude.calls).toHaveLength(0);

    dm(ws, 'm2', OWNER, discord.pairingCode()!);
    await until(() => d.posts(`dm-${OWNER}`).length === 2);
    expect(d.posts(`dm-${OWNER}`)[1].body.content).toStartWith("✅ Linked! I'm Agent TNSE");
    expect(discord.pairingCode()).toBeNull();
    expect(s.delivery.primaryTarget('owner')).toEqual({ channel: 'discord', to: OWNER });

    dm(ws, 'm3', OWNER, 'hello');
    await until(() => claude.calls.length === 1);
    await idle(app);
    expect(d.posts(`dm-${OWNER}`).at(-1)!.body.content).toBe('Hi Ada!');
    expect(d.rest.some(r => r.path === `/channels/dm-${OWNER}/typing`)).toBe(true);
    expect(claude.calls[0].system[0].text).toContain('reaches you on Discord and a web chat');

    // Once someone is linked, other Discord users are ignored without a reply.
    dm(ws, 'm4', STRANGER, discord.pairingCode() ?? '000000');
    dm(ws, 'm5', STRANGER, 'hello');
    await Bun.sleep(30);
    await idle(app);
    expect(claude.calls).toHaveLength(1);
    expect(d.posts(`dm-${STRANGER}`)).toHaveLength(0);
    discord.stop();
  });

  test('approval buttons settle approvals and lock the prompt', async () => {
    const { app, s, d, discord } = setup({ DISCORD_OWNER_ID: OWNER, PRIMARY_CHANNEL: 'discord' });
    discord.connect(msg => void app.router.handleInbound(msg));
    const ws = d.sockets[0];
    ready(ws);
    expect(discord.pairingCode()).toBeNull();

    const decision = s.approvals.request('owner', 'gmail_send_draft', '📧 Send email\nTo: jai@acme.com');
    await until(() => d.posts(`dm-${OWNER}`).length === 1);
    const prompt = d.posts(`dm-${OWNER}`)[0].body;
    const [yes, no] = prompt.components[0].components;
    expect(yes).toMatchObject({ type: 2, style: 3, label: '✅ Approve' });
    expect(no).toMatchObject({ style: 4 });
    expect(yes.custom_id).toMatch(/^apv:.+:yes$/);

    ws.server({
      op: 0,
      t: 'INTERACTION_CREATE',
      s: 3,
      d: { type: 3, id: 'int1', token: 'tok1', channel_id: `dm-${OWNER}`, user: { id: OWNER }, data: { custom_id: yes.custom_id }, message: { content: prompt.content, components: prompt.components } },
    });
    expect(await decision).toEqual({ status: 'approved' });
    const ack = d.rest.find(r => r.path === '/interactions/int1/tok1/callback')!;
    expect(ack.body).toMatchObject({ type: 7, data: { components: [] } });
    expect(ack.body.data.content).toEndWith('→ *✅ Approve*');
    discord.stop();
  });

  test('attachments become media messages; long replies are split; files upload', async () => {
    const { d, discord } = setup({ DISCORD_OWNER_ID: OWNER });
    const got: InboundMessage[] = [];
    discord.connect(msg => got.push(msg));
    const ws = d.sockets[0];
    ready(ws);
    dm(ws, 'm1', OWNER, 'what is this?', {
      flags: 1 << 13,
      attachments: [
        { url: 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg', content_type: 'audio/ogg', filename: 'voice-message.ogg' },
        { url: 'https://cdn.discordapp.com/attachments/1/3/photo.png', content_type: 'image/png', filename: 'photo.png' },
      ],
    });
    expect(got.map(m => [m.id, m.type, m.text])).toEqual([
      ['m1', 'audio', 'what is this?'],
      ['m1:1', 'image', undefined],
    ]);
    expect(got[0].media).toMatchObject({ voice: true, mime: 'audio/ogg' });
    expect((await discord.downloadMedia(got[0].media!.id!)).mime).toBe('audio/ogg');
    await expect(discord.downloadMedia('https://evil.example/x.png')).rejects.toThrow('Refusing');

    await discord.sendText(OWNER, 'word '.repeat(900));
    const chunks = d.posts(`dm-${OWNER}`).map(p => p.body.content as string);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every(c => c.length <= 2000)).toBe(true);

    const file = path.join(tempDir(), 'brief.pdf');
    fs.writeFileSync(file, '%PDF-1.4');
    await discord.sendMedia(OWNER, { path: file, mime: 'application/pdf', kind: 'document', caption: 'Your brief' });
    const upload = d.posts(`dm-${OWNER}`).at(-1)!.body as FormData;
    expect(upload).toBeInstanceOf(FormData);
    expect(JSON.parse(String(upload.get('payload_json')))).toMatchObject({ content: 'Your brief', attachments: [{ id: 0, filename: 'brief.pdf' }] });
    expect(upload.get('files[0]')).toBeInstanceOf(Blob);
    discord.stop();
  });

  test('the invite link comes from the bot token; WhatsApp stays the default home', () => {
    expect(botIdFromToken(TOKEN)).toBe(BOT_ID);
    expect(botIdFromToken('not-a-token')).toBeNull();
    const { s, discord } = setup({ DISCORD_OWNER_ID: OWNER });
    expect(discord.inviteUrl()).toBe(`https://discord.com/oauth2/authorize?client_id=${BOT_ID}&scope=bot&permissions=0`);
    expect(s.delivery.primaryTarget('owner')).toEqual({ channel: 'whatsapp', to: '15550001111' });
  });
});
