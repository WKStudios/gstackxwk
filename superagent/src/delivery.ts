/**
 * Getting words to the owner. Replies go straight back to where the message
 * came from. Proactive messages (schedules, missions, background results)
 * respect two rules:
 *
 *   quiet hours ──▶ hold in the outbox until they end (unless urgent)
 *   WhatsApp 24h window closed ──▶ send the approved template as a nudge,
 *                                  hold the full text until the owner replies
 */

import * as path from 'path';
import type { Services } from './services';
import type { Button, Channel, ChannelName, OutboundMedia } from './channels/types';
import type { ReplyTarget } from './tools/types';
import { clock, inQuietHours, formatLocal } from './clock';
import { logger } from './log';
import { truncate } from './format';
import { discordOwner } from './channels/discord';

const log = logger('delivery');

export type DeliveryResult = 'sent' | 'queued';

export class Delivery {
  constructor(private readonly services: () => Services) {}

  private channel(name: string): Channel {
    const ch = this.services().channels.get(name as ChannelName);
    if (!ch) throw new Error(`Channel "${name}" is not configured`);
    return ch;
  }

  /** Where proactive messages for a conversation go by default: PRIMARY_CHANNEL, else WhatsApp, Discord, web. */
  primaryTarget(conversationId: string): ReplyTarget {
    const s = this.services();
    if (conversationId.startsWith('member:')) return { channel: 'whatsapp', to: conversationId.slice('member:'.length) };
    const discordUser = s.channels.has('discord') ? discordOwner(s.store, s.config) : null;
    const options: Partial<Record<ChannelName, ReplyTarget>> = {
      ...(s.channels.has('whatsapp') && s.config.owners[0] ? { whatsapp: { channel: 'whatsapp', to: s.config.owners[0] } } : {}),
      ...(discordUser ? { discord: { channel: 'discord', to: discordUser } } : {}),
      ...(s.channels.has('web') ? { web: { channel: 'web', to: 'owner' } } : {}),
    };
    const preferred = s.config.primaryChannel ? options[s.config.primaryChannel] : undefined;
    return preferred ?? options.whatsapp ?? options.discord ?? options.web ?? { channel: 'console', to: 'owner' };
  }

  rememberActive(conversationId: string, target: ReplyTarget) {
    this.services().store.setJson(`active:${conversationId}`, { ...target, at: clock.now().toISOString() });
  }

  /** The channel the owner used in the last 15 minutes, else the primary one. */
  activeTarget(conversationId: string): ReplyTarget {
    const s = this.services();
    const active = s.store.getJson<(ReplyTarget & { at: string }) | null>(`active:${conversationId}`, null);
    if (active && s.channels.has(active.channel as ChannelName) && clock.now().getTime() - new Date(active.at).getTime() < 15 * 60_000) {
      return { channel: active.channel, to: active.to };
    }
    return this.primaryTarget(conversationId);
  }

  private windowOpen(target: ReplyTarget): boolean {
    const ch = this.channel(target.channel);
    return !ch.hasSessionWindow || this.services().store.windowOpen(`${target.channel}:${target.to}`);
  }

  private record(conversationId: string, target: ReplyTarget, messageId: string | undefined, text: string) {
    const s = this.services();
    if (messageId) s.store.recordOutbound(messageId, conversationId, text);
    s.store.addTranscript(conversationId, 'agent', target.channel, text);
  }

  /** Reply in an active conversation (the owner just wrote, so the window is open). */
  async reply(conversationId: string, target: ReplyTarget, text: string, opts?: { replyTo?: string }): Promise<string | undefined> {
    if (!text.trim()) return undefined;
    const id = await this.channel(target.channel).sendText(target.to, text, opts);
    this.record(conversationId, target, id, text);
    return id;
  }

  /** A message the owner didn't just ask for. */
  async notify(conversationId: string, text: string, opts: { urgent?: boolean; target?: ReplyTarget } = {}): Promise<DeliveryResult> {
    const s = this.services();
    if (!text.trim()) return 'sent';
    if (!opts.urgent && inQuietHours(clock.now(), s.config.timezone, s.config.quietHours)) {
      s.store.queueOutbox(conversationId, text, 'quiet_hours');
      return 'queued';
    }
    const target = opts.target ?? this.activeTarget(conversationId);
    if (!this.windowOpen(target)) {
      await this.nudge(conversationId, target, text);
      s.store.queueOutbox(conversationId, text, 'window');
      return 'queued';
    }
    await this.reply(conversationId, target, text);
    return 'sent';
  }

  /** Outside WhatsApp's 24h window only a pre-approved template may be sent. */
  private async nudge(conversationId: string, target: ReplyTarget, text: string) {
    const ch = this.channel(target.channel);
    const s = this.services();
    const key = `nudged:${conversationId}`;
    // One nudge per closed window is enough; the rest wait in the outbox.
    if (s.store.get(key)) return;
    if (!ch.sendTemplate || !s.config.whatsapp?.templateName) {
      log.warn('WhatsApp window closed and no WHATSAPP_TEMPLATE_NAME set; message held until the owner writes');
      return;
    }
    try {
      await ch.sendTemplate(target.to, truncate(text, 300));
      s.store.set(key, clock.now().toISOString());
    } catch (err) {
      log.error('template nudge failed', err);
    }
  }

  /** Buttons (approvals). Falls back to a held text prompt when the window is closed. */
  async ask(conversationId: string, body: string, buttons: Button[]): Promise<string | undefined> {
    const target = this.activeTarget(conversationId);
    if (!this.windowOpen(target)) {
      await this.nudge(conversationId, target, body);
      this.services().store.queueOutbox(conversationId, `${body}\n\nReply *yes* to approve or *no* to cancel.`, 'window');
      return undefined;
    }
    const id = await this.channel(target.channel).sendButtons(target.to, body, buttons);
    this.record(conversationId, target, id, body);
    return id;
  }

  async sendMedia(conversationId: string, media: OutboundMedia, target?: ReplyTarget): Promise<DeliveryResult> {
    const s = this.services();
    const t = target ?? this.activeTarget(conversationId);
    if (!this.windowOpen(t)) {
      const token = s.store.hostFile(media.path, media.filename || path.basename(media.path), media.mime);
      const link = `${s.config.publicBaseUrl}/files/${token}/${encodeURIComponent(media.filename || path.basename(media.path))}`;
      return this.notify(conversationId, `📎 ${media.caption ? `${media.caption}\n` : ''}${link}`, { target: t });
    }
    const id = await this.channel(t.channel).sendMedia(t.to, media);
    this.record(conversationId, t, id, `[sent ${media.kind}: ${media.filename || path.basename(media.path)}]${media.caption ? ` ${media.caption}` : ''}`);
    return 'sent';
  }

  /** Deliver anything held back (quiet hours over, or the owner reopened the window). */
  async flushOutbox(conversationId: string, target?: ReplyTarget): Promise<number> {
    const s = this.services();
    const held = s.store.pendingOutbox(conversationId);
    if (held.length === 0) return 0;
    const t = target ?? this.activeTarget(conversationId);
    if (!this.windowOpen(t)) return 0;
    s.store.set(`nudged:${conversationId}`, null);
    let sent = 0;
    for (const row of held) {
      const when = formatLocal(new Date(row.created_at), s.config.timezone);
      const prefix = row.reason === 'quiet_hours' ? `🌙 Held during quiet hours (${when}):\n` : `📬 From ${when}:\n`;
      try {
        await this.reply(conversationId, t, `${prefix}${row.text}`);
        s.store.markOutboxDelivered(row.id);
        sent++;
      } catch (err) {
        log.error('outbox delivery failed', err);
        break;
      }
    }
    return sent;
  }
}
