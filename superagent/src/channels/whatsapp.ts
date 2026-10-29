/**
 * WhatsApp Business Cloud API (Meta, official). Webhook in, Graph API out.
 *
 *   Meta ──POST /webhook/whatsapp──▶ verifySignature ─▶ parseWebhook ─▶ router
 *   router ─▶ sendText / sendButtons / sendMedia ──▶ graph.facebook.com
 *
 * Free-form messages are only allowed for 24h after the user's last message;
 * outside that window we must open with an approved template (see delivery.ts).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Config } from '../config';
import { logger } from '../log';
import { chunkText, markdownToWhatsApp, templateSafe, truncate } from '../format';
import type { Button, Channel, InboundMessage, InboundType, OutboundMedia } from './types';

const log = logger('whatsapp');

export function verifySignature(appSecret: string, rawBody: string, header: string | null): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const given = header.slice('sha256='.length);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

/** Webhook verification handshake (GET). Returns the challenge or null. */
export function verifyChallenge(url: URL, verifyToken: string): string | null {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token === verifyToken && challenge) return challenge;
  return null;
}

/** Normalize a Cloud API webhook payload into channel-agnostic messages. */
export function parseWebhook(payload: any): { messages: InboundMessage[]; failures: string[] } {
  const messages: InboundMessage[] = [];
  const failures: string[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (!value) continue;
      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c?.wa_id && c?.profile?.name) names.set(c.wa_id, c.profile.name);
      }
      for (const status of value.statuses ?? []) {
        if (status?.status === 'failed') {
          const err = status.errors?.[0];
          failures.push(`${status.recipient_id}: ${err?.code ?? ''} ${err?.title ?? ''} ${err?.error_data?.details ?? ''}`.trim());
        }
      }
      for (const m of value.messages ?? []) {
        const parsed = parseMessage(m);
        if (parsed) {
          parsed.profileName = names.get(m.from);
          messages.push(parsed);
        }
      }
    }
  }
  return { messages, failures };
}

function parseMessage(m: any): InboundMessage | null {
  if (!m?.from || !m?.id) return null;
  const base = {
    channel: 'whatsapp' as const,
    from: String(m.from),
    id: String(m.id),
    timestamp: m.timestamp ? new Date(parseInt(m.timestamp, 10) * 1000) : new Date(),
    replyToId: m.context?.id,
  };
  const type = m.type as string;
  switch (type) {
    case 'text':
      return { ...base, type: 'text', text: m.text?.body ?? '' };
    case 'image':
    case 'video':
    case 'sticker':
      return {
        ...base,
        type: type as InboundType,
        media: { id: m[type]?.id, mime: m[type]?.mime_type ?? 'application/octet-stream', caption: m[type]?.caption },
        text: m[type]?.caption,
      };
    case 'audio':
      return {
        ...base,
        type: 'audio',
        media: { id: m.audio?.id, mime: m.audio?.mime_type ?? 'audio/ogg', voice: !!m.audio?.voice },
      };
    case 'document':
      return {
        ...base,
        type: 'document',
        media: {
          id: m.document?.id,
          mime: m.document?.mime_type ?? 'application/octet-stream',
          filename: m.document?.filename,
          caption: m.document?.caption,
        },
        text: m.document?.caption,
      };
    case 'location':
      return {
        ...base,
        type: 'location',
        location: {
          latitude: m.location?.latitude,
          longitude: m.location?.longitude,
          name: m.location?.name,
          address: m.location?.address,
        },
      };
    case 'contacts': {
      const lines = (m.contacts ?? []).map((c: any) => {
        const phones = (c.phones ?? []).map((p: any) => p.phone).filter(Boolean).join(', ');
        const emails = (c.emails ?? []).map((e: any) => e.email).filter(Boolean).join(', ');
        return [c.name?.formatted_name, phones, emails].filter(Boolean).join(' · ');
      });
      return { ...base, type: 'contacts', text: `Shared contact(s):\n${lines.join('\n')}` };
    }
    case 'interactive': {
      const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
      return { ...base, type: 'button', buttonId: reply?.id, text: reply?.title };
    }
    case 'button':
      return { ...base, type: 'button', buttonId: m.button?.payload, text: m.button?.text };
    case 'reaction':
      return {
        ...base,
        type: 'reaction',
        reaction: { messageId: m.reaction?.message_id, emoji: m.reaction?.emoji ?? '' },
      };
    default:
      return { ...base, type: 'unsupported', text: `[unsupported WhatsApp message type: ${type}]` };
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class WhatsAppChannel implements Channel {
  readonly name = 'whatsapp' as const;
  readonly hasSessionWindow = true;
  private readonly base: string;

  constructor(
    private readonly cfg: NonNullable<Config['whatsapp']>,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.base = `https://graph.facebook.com/${cfg.graphVersion}`;
  }

  private async graph(pathname: string, body: unknown): Promise<any> {
    const resp = await this.fetchImpl(`${this.base}/${pathname}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = json?.error;
      throw new Error(`WhatsApp API ${resp.status}: ${err?.message ?? 'request failed'}${err?.error_data?.details ? ` — ${err.error_data.details}` : ''}`);
    }
    return json;
  }

  private async send(to: string, payload: Record<string, unknown>): Promise<string | undefined> {
    const json = await this.graph(`${this.cfg.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      ...payload,
    });
    return json?.messages?.[0]?.id;
  }

  async sendText(to: string, text: string, opts?: { replyTo?: string }): Promise<string | undefined> {
    const chunks = chunkText(markdownToWhatsApp(text));
    let lastId: string | undefined;
    for (const [i, chunk] of chunks.entries()) {
      lastId = await this.send(to, {
        type: 'text',
        text: { body: chunk, preview_url: chunks.length === 1 },
        ...(i === 0 && opts?.replyTo ? { context: { message_id: opts.replyTo } } : {}),
      });
    }
    return lastId;
  }

  async sendButtons(to: string, body: string, buttons: Button[]): Promise<string | undefined> {
    return this.send(to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: truncate(markdownToWhatsApp(body), 1024) },
        action: {
          buttons: buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id, title: truncate(b.title, 20) } })),
        },
      },
    });
  }

  private async upload(filePath: string, mime: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', new Blob([fs.readFileSync(filePath)], { type: mime }), filename);
    const resp = await this.fetchImpl(`${this.base}/${this.cfg.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.token}` },
      body: form,
    });
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.id) throw new Error(`WhatsApp media upload failed (${resp.status}): ${json?.error?.message ?? 'unknown error'}`);
    return json.id;
  }

  async sendMedia(to: string, media: OutboundMedia): Promise<string | undefined> {
    const filename = media.filename || path.basename(media.path);
    const id = await this.upload(media.path, media.mime, filename);
    const caption = media.caption ? truncate(markdownToWhatsApp(media.caption), 1024) : undefined;
    switch (media.kind) {
      case 'image':
        return this.send(to, { type: 'image', image: { id, caption } });
      case 'video':
        return this.send(to, { type: 'video', video: { id, caption } });
      case 'document':
        return this.send(to, { type: 'document', document: { id, filename, caption } });
      case 'audio':
        if (media.voice) {
          try {
            return await this.send(to, { type: 'audio', audio: { id, voice: true } });
          } catch (err) {
            // Older API versions reject the voice flag; plain audio still plays.
            log.warn('voice flag rejected, retrying as plain audio', err);
          }
        }
        return this.send(to, { type: 'audio', audio: { id } });
    }
  }

  async sendTemplate(to: string, preview: string): Promise<string | undefined> {
    if (!this.cfg.templateName) throw new Error('WHATSAPP_TEMPLATE_NAME is not configured');
    return this.send(to, {
      type: 'template',
      template: {
        name: this.cfg.templateName,
        language: { code: this.cfg.templateLanguage },
        components: [{ type: 'body', parameters: [{ type: 'text', text: templateSafe(preview) }] }],
      },
    });
  }

  async markRead(messageId: string, typing = false): Promise<void> {
    await this.graph(`${this.cfg.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      ...(typing ? { typing_indicator: { type: 'text' } } : {}),
    });
  }

  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mime: string }> {
    const metaResp = await this.fetchImpl(`${this.base}/${mediaId}`, {
      headers: { Authorization: `Bearer ${this.cfg.token}` },
    });
    const meta: any = await metaResp.json().catch(() => ({}));
    if (!metaResp.ok || !meta.url) throw new Error(`WhatsApp media lookup failed (${metaResp.status})`);
    const fileResp = await this.fetchImpl(meta.url, { headers: { Authorization: `Bearer ${this.cfg.token}` } });
    if (!fileResp.ok) throw new Error(`WhatsApp media download failed (${fileResp.status})`);
    return { data: Buffer.from(await fileResp.arrayBuffer()), mime: meta.mime_type || 'application/octet-stream' };
  }
}
