/**
 * Discord — a bot the owner DMs. No business verification, no public URL and
 * no 24h window: the agent keeps an outbound connection to Discord's gateway
 * and replies over the REST API.
 *
 *   Discord gateway ──MESSAGE_CREATE / INTERACTION_CREATE──▶ parse ─▶ router
 *   router ─▶ sendText / sendButtons / sendMedia ──▶ discord.com/api/v10
 *
 * Only DMs are read. The bot answers one person: DISCORD_OWNER_ID, or whoever
 * first DMs it the pairing code printed in the server log.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Config } from '../config';
import type { Store } from '../store';
import { logger } from '../log';
import { chunkText, truncate } from '../format';
import type { Button, Channel, InboundMessage, InboundType, OutboundMedia } from './types';

const log = logger('discord');

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
// DIRECT_MESSAGES | DIRECT_MESSAGE_REACTIONS. DM text arrives without the privileged message-content intent.
export const DISCORD_INTENTS = (1 << 12) | (1 << 13);
const VOICE_MESSAGE_FLAG = 1 << 13;
const UPLOAD_LIMIT = 10 * 1024 * 1024;
// Close codes after which reconnecting can't help.
const FATAL_CLOSE: Record<number, string> = {
  4004: 'Discord rejected the bot token. Check DISCORD_BOT_TOKEN (Developer Portal → Bot → Reset Token).',
  4010: 'Discord rejected the shard settings.',
  4011: 'Discord requires sharding for this bot.',
  4012: 'Discord rejected the gateway version.',
  4013: 'Discord rejected the gateway intents.',
  4014: 'Discord refused the gateway intents for this bot.',
};
const OWNER_KEY = 'discord:owner';

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DiscordOptions {
  fetchImpl?: FetchLike;
  socket?: (url: string) => SocketLike;
  agentName?: string;
}

/** The linked owner: DISCORD_OWNER_ID if set, else whoever paired. */
export function discordOwner(store: Store, config: Config): string | null {
  return config.discord?.ownerId ?? store.get(OWNER_KEY) ?? null;
}

/** A bot token starts with the base64 of the bot's id, which is also its application id. */
export function botIdFromToken(token: string): string | null {
  try {
    const id = Buffer.from(token.split('.')[0] ?? '', 'base64').toString('utf-8');
    return /^\d{5,25}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function mediaType(mime: string): InboundType {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

export class DiscordChannel implements Channel {
  readonly name = 'discord' as const;
  readonly hasSessionWindow = false;

  private readonly fetchImpl: FetchLike;
  private readonly socket: (url: string) => SocketLike;
  private readonly agentName: string;
  private onInbound: (msg: InboundMessage) => void = () => {};

  private ws?: SocketLike;
  private seq: number | null = null;
  private sessionId?: string;
  private resumeUrl?: string;
  private resuming = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private firstBeat?: ReturnType<typeof setTimeout>;
  private acked = true;
  private backoffMs = 1000;
  private stopped = false;
  private botId?: string;
  private code = String(crypto.randomInt(100000, 1000000));

  private readonly dmChannels = new Map<string, string>();
  private readonly messageChannels = new Map<string, string>();
  private readonly typing = new Map<string, { timer: ReturnType<typeof setInterval>; until: number }>();

  constructor(
    private readonly cfg: NonNullable<Config['discord']>,
    private readonly store: Store,
    private readonly publicBaseUrl: string,
    opts: DiscordOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.socket = opts.socket ?? (url => new WebSocket(url) as unknown as SocketLike);
    this.agentName = opts.agentName ?? 'your agent';
  }

  owner(): string | null {
    return this.cfg.ownerId ?? this.store.get(OWNER_KEY) ?? null;
  }

  /** The one-time code that links a Discord account, while none is linked. */
  pairingCode(): string | null {
    return this.owner() ? null : this.code;
  }

  /** Discord only lets you DM a bot you share a server with; this adds it to one of yours. */
  inviteUrl(): string | null {
    const id = botIdFromToken(this.cfg.token);
    return id ? `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=0` : null;
  }

  // ─── Gateway ─────────────────────────────────────────────────

  connect(onInbound: (msg: InboundMessage) => void) {
    this.onInbound = onInbound;
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    this.clearHeartbeat();
    for (const id of [...this.typing.keys()]) this.stopTyping(id);
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onclose = null;
      ws.close(1000);
    }
  }

  private open() {
    const url = this.resuming && this.resumeUrl ? `${this.resumeUrl.replace(/\/$/, '')}/?v=10&encoding=json` : GATEWAY;
    const ws = this.socket(url);
    this.ws = ws;
    ws.onmessage = ev => {
      if (this.ws !== ws) return;
      try {
        this.onPayload(JSON.parse(String(ev.data)));
      } catch (err) {
        log.warn('bad gateway payload', err);
      }
    };
    ws.onclose = ev => {
      if (this.ws === ws) this.onClose(ev.code);
    };
    ws.onerror = () => {}; // a close event follows
  }

  private send(payload: unknown) {
    this.ws?.send(JSON.stringify(payload));
  }

  private onPayload(p: { op: number; d: any; s?: number | null; t?: string | null }) {
    if (typeof p.s === 'number') this.seq = p.s;
    switch (p.op) {
      case 10: // HELLO
        this.startHeartbeat(p.d?.heartbeat_interval ?? 41_250);
        if (this.resuming && this.sessionId) {
          this.send({ op: 6, d: { token: this.cfg.token, session_id: this.sessionId, seq: this.seq } });
        } else {
          this.resuming = false;
          this.send({
            op: 2,
            d: { token: this.cfg.token, intents: DISCORD_INTENTS, properties: { os: process.platform, browser: 'gstack-superagent', device: 'gstack-superagent' } },
          });
        }
        break;
      case 11: // HEARTBEAT_ACK
        this.acked = true;
        break;
      case 1: // the gateway asks for a heartbeat now
        this.beat();
        break;
      case 7: // RECONNECT
        this.reconnect(true);
        break;
      case 9: // INVALID_SESSION; d says whether it can be resumed
        if (!p.d) {
          this.sessionId = undefined;
          this.seq = null;
        }
        setTimeout(() => this.reconnect(!!p.d), 1000 + Math.random() * 4000);
        break;
      case 0:
        this.dispatch(p.t ?? '', p.d);
        break;
    }
  }

  private startHeartbeat(intervalMs: number) {
    this.clearHeartbeat();
    this.acked = true;
    // The first beat is jittered so a fleet of reconnecting clients spreads out.
    this.firstBeat = setTimeout(() => {
      this.beat();
      this.heartbeat = setInterval(() => {
        if (!this.acked) {
          log.warn('gateway stopped acknowledging heartbeats; reconnecting');
          this.reconnect(true);
          return;
        }
        this.beat();
      }, intervalMs);
    }, intervalMs * Math.random());
  }

  private beat() {
    this.acked = false;
    this.send({ op: 1, d: this.seq });
  }

  private clearHeartbeat() {
    if (this.firstBeat) clearTimeout(this.firstBeat);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.firstBeat = this.heartbeat = undefined;
  }

  private reconnect(resume: boolean) {
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onclose = null;
      // Any code but 1000/1001 keeps the session resumable.
      ws.close(4000, 'reconnecting');
    }
    if (this.stopped) return;
    this.resuming = resume && !!this.sessionId;
    this.open();
  }

  private onClose(code: number) {
    this.clearHeartbeat();
    this.ws = undefined;
    if (this.stopped) return;
    if (FATAL_CLOSE[code]) {
      log.error(`${FATAL_CLOSE[code]} (close code ${code}). Discord is off until the agent restarts.`);
      return;
    }
    if (code === 4007 || code === 4009) {
      this.sessionId = undefined;
      this.seq = null;
    }
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    log.warn(`gateway closed (${code}); reconnecting in ${Math.round(wait / 1000)}s`);
    setTimeout(() => {
      if (this.stopped || this.ws) return;
      this.resuming = !!this.sessionId;
      this.open();
    }, wait);
  }

  private dispatch(type: string, d: any) {
    switch (type) {
      case 'READY':
        this.sessionId = d?.session_id;
        this.resumeUrl = d?.resume_gateway_url;
        this.botId = d?.user?.id;
        this.backoffMs = 1000;
        log.info(`connected as ${d?.user?.username ?? 'bot'}`);
        break;
      case 'RESUMED':
        this.backoffMs = 1000;
        break;
      case 'MESSAGE_CREATE':
        this.onMessage(d);
        break;
      case 'INTERACTION_CREATE':
        void this.onInteraction(d);
        break;
      case 'MESSAGE_REACTION_ADD':
        if (d?.guild_id || !d?.user_id || d.user_id === this.botId) return;
        this.onInbound({
          channel: 'discord',
          from: String(d.user_id),
          id: `reaction:${d.message_id}:${d.user_id}:${d.emoji?.name ?? ''}`,
          timestamp: new Date(),
          type: 'reaction',
          reaction: { messageId: String(d.message_id), emoji: d.emoji?.name ?? '' },
        });
        break;
    }
  }

  private onMessage(d: any) {
    const author = d?.author;
    if (!author?.id || d.guild_id || author.bot || author.id === this.botId) return;
    const from = String(author.id);
    this.dmChannels.set(from, String(d.channel_id));
    this.rememberMessage(String(d.id), String(d.channel_id));
    const content: string = (d.content ?? '').trim();

    if (!this.owner()) {
      if (content === this.code) {
        this.store.set(OWNER_KEY, from);
        log.info(`linked to Discord user ${author.username ?? from}`);
        void this.sendText(from, `✅ Linked! I'm ${this.agentName}, and this Discord account is the only one I'll answer. Say hi, or try "what's on my calendar tomorrow?"`).catch(err =>
          log.warn('pairing reply failed', err),
        );
      } else {
        log.warn(`Discord DM from ${author.username ?? from}, but no one is linked yet. To link, DM the bot this pairing code: ${this.code}`);
        void this.sendText(from, 'To link me to your Discord account, send the 6-digit pairing code shown where the agent is running.').catch(() => {});
      }
      return;
    }

    const base = {
      channel: 'discord' as const,
      from,
      profileName: author.global_name ?? author.username,
      timestamp: d.timestamp ? new Date(d.timestamp) : new Date(),
      replyToId: d.message_reference?.message_id,
    };
    const attachments: any[] = d.attachments ?? [];
    if (!attachments.length) {
      if (content) this.onInbound({ ...base, id: String(d.id), type: 'text', text: content });
      else if (d.sticker_items?.length) this.onInbound({ ...base, id: String(d.id), type: 'sticker', text: `[sticker: ${d.sticker_items[0]?.name ?? 'sticker'}]` });
      return;
    }
    attachments.forEach((a, i) => {
      const mime = a.content_type || 'application/octet-stream';
      const caption = i === 0 && content ? content : undefined;
      this.onInbound({
        ...base,
        id: i === 0 ? String(d.id) : `${d.id}:${i}`,
        type: mediaType(mime),
        text: caption,
        media: { id: String(a.url), mime, filename: a.filename, caption, voice: mime.startsWith('audio/') && !!((d.flags ?? 0) & VOICE_MESSAGE_FLAG) },
      });
    });
  }

  /** A button press: acknowledge within Discord's 3 seconds, then hand it to the router. */
  private async onInteraction(d: any) {
    if (d?.type !== 3) return;
    const user = d.user ?? d.member?.user;
    if (!user?.id || d.guild_id) return;
    const customId = String(d.data?.custom_id ?? '');
    const buttons = (d.message?.components ?? []).flatMap((row: any) => row.components ?? []);
    const label = buttons.find((b: any) => b.custom_id === customId)?.label ?? customId;
    this.dmChannels.set(String(user.id), String(d.channel_id));
    this.rememberMessage(String(d.id), String(d.channel_id));
    try {
      // Replace the buttons with the choice so the prompt can't be answered twice.
      await this.api('POST', `/interactions/${d.id}/${d.token}/callback`, {
        type: 7,
        data: { content: truncate(`${d.message?.content ?? ''}\n\n→ *${label}*`, 2000), components: [] },
      });
    } catch (err) {
      log.warn('could not acknowledge button press', err);
    }
    this.onInbound({
      channel: 'discord',
      from: String(user.id),
      id: `interaction:${d.id}`,
      timestamp: new Date(),
      type: 'button',
      buttonId: customId,
      text: label,
    });
  }

  /** Which DM a message came from, so markRead can show "typing…" there. Only recent ones matter. */
  private rememberMessage(messageId: string, channelId: string) {
    this.messageChannels.set(messageId, channelId);
    if (this.messageChannels.size > 500) this.messageChannels.delete(this.messageChannels.keys().next().value!);
  }

  // ─── REST ────────────────────────────────────────────────────

  private async api(method: string, pathname: string, body?: unknown, attempt = 0): Promise<any> {
    const headers: Record<string, string> = { Authorization: `Bot ${this.cfg.token}`, 'User-Agent': 'DiscordBot (https://github.com/garrytan/gstack, 0.4)' };
    const init: RequestInit = { method, headers };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const resp = await this.fetchImpl(`${API}${pathname}`, init);
    if (resp.status === 429 && attempt < 3) {
      const json: any = await resp.json().catch(() => ({}));
      await Bun.sleep(Math.min(Number(json.retry_after ?? 1), 30) * 1000);
      return this.api(method, pathname, body, attempt + 1);
    }
    if (resp.status === 204) return {};
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`Discord API ${resp.status}: ${json?.message ?? 'request failed'}`);
    return json;
  }

  /** Confirms the token works. */
  async whoami(): Promise<{ id: string; username: string }> {
    return this.api('GET', '/users/@me');
  }

  private async dmChannel(userId: string): Promise<string> {
    const known = this.dmChannels.get(userId);
    if (known) return known;
    const ch = await this.api('POST', '/users/@me/channels', { recipient_id: userId });
    this.dmChannels.set(userId, String(ch.id));
    return String(ch.id);
  }

  private async post(channelId: string, payload: Record<string, unknown>): Promise<string | undefined> {
    this.stopTyping(channelId);
    const msg = await this.api('POST', `/channels/${channelId}/messages`, { allowed_mentions: { parse: [] }, ...payload });
    return msg?.id ? String(msg.id) : undefined;
  }

  async sendText(to: string, text: string, opts?: { replyTo?: string }): Promise<string | undefined> {
    const channelId = await this.dmChannel(to);
    let lastId: string | undefined;
    for (const [i, chunk] of chunkText(text, 1900).entries()) {
      lastId = await this.post(channelId, {
        content: chunk,
        ...(i === 0 && opts?.replyTo ? { message_reference: { message_id: opts.replyTo, fail_if_not_exists: false } } : {}),
      });
    }
    return lastId;
  }

  async sendButtons(to: string, body: string, buttons: Button[]): Promise<string | undefined> {
    const channelId = await this.dmChannel(to);
    const style = (id: string) => (/:yes$/.test(id) ? 3 : /:no$/.test(id) ? 4 : 2);
    return this.post(channelId, {
      content: truncate(body, 2000),
      components: [{ type: 1, components: buttons.slice(0, 5).map(b => ({ type: 2, style: style(b.id), label: truncate(b.title, 80), custom_id: b.id.slice(0, 100) })) }],
    });
  }

  async sendMedia(to: string, media: OutboundMedia): Promise<string | undefined> {
    const filename = media.filename || path.basename(media.path);
    const size = fs.statSync(media.path).size;
    if (size > UPLOAD_LIMIT) {
      // Too big for a bot upload: send an expiring link instead.
      const token = this.store.hostFile(media.path, filename, media.mime);
      const link = `${this.publicBaseUrl}/files/${token}/${encodeURIComponent(filename)}`;
      return this.sendText(to, `📎 ${media.caption ? `${media.caption}\n` : ''}${link}`);
    }
    const channelId = await this.dmChannel(to);
    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({ content: media.caption ? truncate(media.caption, 2000) : undefined, attachments: [{ id: 0, filename }], allowed_mentions: { parse: [] } }),
    );
    form.append('files[0]', new Blob([new Uint8Array(fs.readFileSync(media.path))], { type: media.mime }), filename);
    this.stopTyping(channelId);
    const msg = await this.api('POST', `/channels/${channelId}/messages`, form);
    return msg?.id ? String(msg.id) : undefined;
  }

  /** Discord has no read receipts; this shows "typing…" until the reply goes out. */
  async markRead(messageId: string, typing = false): Promise<void> {
    const channelId = this.messageChannels.get(messageId) ?? this.messageChannels.get(messageId.replace(/^interaction:/, '').replace(/:\d+$/, ''));
    if (typing && channelId) this.startTyping(channelId);
  }

  private startTyping(channelId: string) {
    // Discord's indicator lasts 10s; keep it up while the router keeps asking (it does every 20s mid-turn).
    const until = Date.now() + 45_000;
    const current = this.typing.get(channelId);
    if (current) {
      current.until = until;
      return;
    }
    const fire = () => void this.api('POST', `/channels/${channelId}/typing`).catch(() => {});
    fire();
    const timer = setInterval(() => {
      const t = this.typing.get(channelId);
      if (!t || Date.now() > t.until) this.stopTyping(channelId);
      else fire();
    }, 8_000);
    this.typing.set(channelId, { timer, until });
  }

  private stopTyping(channelId: string) {
    const t = this.typing.get(channelId);
    if (!t) return;
    clearInterval(t.timer);
    this.typing.delete(channelId);
  }

  async downloadMedia(url: string): Promise<{ data: Buffer; mime: string }> {
    const host = new URL(url).hostname;
    if (host !== 'cdn.discordapp.com' && host !== 'media.discordapp.net') throw new Error(`Refusing to download from ${host}`);
    const resp = await this.fetchImpl(url);
    if (!resp.ok) throw new Error(`Discord attachment download failed (${resp.status})`);
    return { data: Buffer.from(await resp.arrayBuffer()), mime: resp.headers.get('content-type') || 'application/octet-stream' };
  }
}
