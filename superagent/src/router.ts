/**
 * Inbound routing. Each conversation is a lane that runs one thing at a time,
 * because history must stay strictly sequential:
 *
 *   message ─▶ allowlist ─▶ approval answer? ─▶ command? ─▶ debounce (people
 *   send 3 bubbles in a row) ─▶ lane queue ─▶ agent turn ─▶ reply ─▶ compact?
 *
 * Approval answers and "stop" bypass the queue — the running turn is the
 * thing waiting on them.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Services } from './services';
import type { InboundMessage } from './channels/types';
import type { ReplyTarget, Role } from './tools/types';
import { buildUserTurn } from './inbound';
import { repairTail } from './agent/runner';
import { filesRoot, saveFile } from './tools/files';
import { logger, errorMessage } from './log';
import { clock, localDate } from './clock';
import type { Commands } from './commands';
import { discordOwner } from './channels/discord';

const log = logger('router');

type Task =
  | { kind: 'inbound'; msgs: InboundMessage[]; target: ReplyTarget; role: Role }
  | { kind: 'internal'; text: string }
  | { kind: 'note'; label: string; text: string }
  | { kind: 'fn'; fn: () => Promise<void> };

interface Lane {
  busy: boolean;
  queue: Task[];
  abort?: AbortController;
  debounce?: { msgs: InboundMessage[]; target: ReplyTarget; role: Role; timer: ReturnType<typeof setTimeout> };
}

export function friendlyError(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) return "I'm being rate-limited by the Claude API. Give me a minute and try again.";
  if (err instanceof Anthropic.AuthenticationError) return 'My Claude API key was rejected — check ANTHROPIC_API_KEY on the server.';
  if (err instanceof Anthropic.InternalServerError) return 'Claude is having trouble right now (server error). Try again shortly.';
  if (err instanceof Anthropic.APIError && err.status === 529) return 'Claude is overloaded right now. Try again in a minute.';
  if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(errorMessage(err))) {
    return 'Your Anthropic account is out of API credits. Add some at console.anthropic.com → Settings → Billing, then send your message again.';
  }
  if (err instanceof Anthropic.BadRequestError) return `The request to Claude was rejected: ${errorMessage(err).slice(0, 300)}`;
  return `Something went wrong on my side: ${errorMessage(err).slice(0, 300)}`;
}

export class Router {
  private lanes = new Map<string, Lane>();
  private seen = new Set<string>();
  commands?: Commands;

  constructor(private readonly services: () => Services) {}

  private lane(conversationId: string): Lane {
    let lane = this.lanes.get(conversationId);
    if (!lane) {
      lane = { busy: false, queue: [] };
      this.lanes.set(conversationId, lane);
    }
    return lane;
  }

  identify(msg: InboundMessage): { conversationId: string; role: Role } | null {
    const { config, store } = this.services();
    if (msg.channel === 'web' || msg.channel === 'console') return { conversationId: 'owner', role: 'owner' };
    if (msg.channel === 'discord') return msg.from === discordOwner(store, config) ? { conversationId: 'owner', role: 'owner' } : null;
    if (config.owners.includes(msg.from)) return { conversationId: 'owner', role: 'owner' };
    if (config.members.includes(msg.from)) return { conversationId: `member:${msg.from}`, role: 'member' };
    return null;
  }

  isBusy(conversationId: string): boolean {
    const lane = this.lanes.get(conversationId);
    return !!lane && (lane.busy || lane.queue.length > 0 || !!lane.debounce);
  }

  async handleInbound(msg: InboundMessage): Promise<void> {
    const s = this.services();
    // Meta retries webhooks; process each message id once.
    if (this.seen.has(msg.id)) return;
    this.seen.add(msg.id);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));

    const who = this.identify(msg);
    if (!who) {
      log.warn(`ignoring message from unknown sender ${msg.channel}:${msg.from}`);
      return;
    }
    const { conversationId, role } = who;
    const target: ReplyTarget = { channel: msg.channel, to: msg.from };
    if (s.channels.get(msg.channel)?.hasSessionWindow) s.store.touchWindow(`${msg.channel}:${msg.from}`);
    s.delivery.rememberActive(conversationId, target);
    const ch = s.channels.get(msg.channel);
    if (ch?.markRead && msg.type !== 'reaction') ch.markRead(msg.id, true).catch(err => log.debug('markRead failed', err));

    // The owner just reopened the conversation: deliver anything held back.
    try {
      await s.delivery.flushOutbox(conversationId, target);
    } catch (err) {
      log.warn('outbox flush failed', err);
    }

    if (s.approvals.handleInbound(conversationId, msg)) return;
    if (msg.type === 'reaction') return;
    if (msg.type === 'text' && msg.text && this.commands?.matches(msg.text)) {
      await this.commands.handle({ conversationId, role, target, text: msg.text });
      return;
    }
    this.debounce(conversationId, role, target, msg);
  }

  private debounce(conversationId: string, role: Role, target: ReplyTarget, msg: InboundMessage) {
    const { config } = this.services();
    const lane = this.lane(conversationId);
    if (config.debounceMs <= 0) {
      this.enqueue(conversationId, { kind: 'inbound', msgs: [msg], target, role });
      return;
    }
    if (lane.debounce) {
      clearTimeout(lane.debounce.timer);
      lane.debounce.msgs.push(msg);
      lane.debounce.target = target;
    } else {
      lane.debounce = { msgs: [msg], target, role, timer: undefined as any };
    }
    // Voice notes and files take a moment to arrive in sequence; wait a little longer after them.
    const wait = msg.type === 'text' ? config.debounceMs : config.debounceMs * 2;
    lane.debounce.timer = setTimeout(() => {
      const d = lane.debounce!;
      lane.debounce = undefined;
      this.enqueue(conversationId, { kind: 'inbound', msgs: d.msgs, target: d.target, role: d.role });
    }, wait);
  }

  enqueue(conversationId: string, task: Task) {
    const lane = this.lane(conversationId);
    lane.queue.push(task);
    if (!lane.busy) void this.drain(conversationId);
  }

  /** Background work wants the agent to say something (e.g. research finished). */
  enqueueTurn(conversationId: string, text: string) {
    this.enqueue(conversationId, { kind: 'internal', text });
  }

  appendNote(conversationId: string, label: string, text: string) {
    this.enqueue(conversationId, { kind: 'note', label, text });
  }

  /** Run something with exclusive access to the conversation (e.g. /new). */
  exclusive(conversationId: string, fn: () => Promise<void>) {
    this.enqueue(conversationId, { kind: 'fn', fn });
  }

  /** Abort the running turn and drop anything queued. */
  stop(conversationId: string): { aborted: boolean; dropped: number } {
    const lane = this.lane(conversationId);
    let dropped = 0;
    if (lane.debounce) {
      clearTimeout(lane.debounce.timer);
      dropped += lane.debounce.msgs.length;
      lane.debounce = undefined;
    }
    const kept = lane.queue.filter(t => t.kind === 'note' || t.kind === 'fn');
    dropped += lane.queue.length - kept.length;
    lane.queue = kept;
    const aborted = !!lane.abort && !lane.abort.signal.aborted;
    lane.abort?.abort();
    return { aborted, dropped };
  }

  private async drain(conversationId: string) {
    const lane = this.lane(conversationId);
    if (lane.busy) return;
    lane.busy = true;
    try {
      while (lane.queue.length) {
        let task = lane.queue.shift()!;
        // Messages that piled up while the agent was busy become one turn.
        while (task.kind === 'inbound' && lane.queue[0]?.kind === 'inbound') {
          const next = lane.queue.shift() as Extract<Task, { kind: 'inbound' }>;
          task = { ...task, msgs: [...task.msgs, ...next.msgs], target: next.target };
        }
        try {
          await this.runTask(conversationId, task, lane);
        } catch (err) {
          log.error(`task failed in ${conversationId}`, err);
        }
      }
    } finally {
      lane.busy = false;
      lane.abort = undefined;
    }
  }

  private appendSafely(conversationId: string, messages: Parameters<Services['store']['appendMessages']>[1]) {
    const { store } = this.services();
    const repairs = repairTail(store.history(conversationId));
    store.appendMessages(conversationId, [...repairs, ...messages]);
  }

  private async runTask(conversationId: string, task: Task, lane: Lane) {
    switch (task.kind) {
      case 'note':
        this.appendSafely(conversationId, [{ role: 'assistant', content: [{ type: 'text', text: `[${task.label}] ${task.text}` }] }]);
        return;
      case 'fn':
        await task.fn();
        return;
      case 'internal':
        return this.runInternal(conversationId, task.text, lane);
      case 'inbound':
        return this.runInbound(conversationId, task, lane);
    }
  }

  private budgetExceeded(): { exceeded: boolean; spent: number; budget: number } {
    const { store, config } = this.services();
    const spent = store.usageForDay().cost;
    const override = parseFloat(store.get(`budget:${localDate(clock.now(), config.timezone)}`) ?? '');
    const budget = Number.isFinite(override) ? override : config.dailyBudgetUsd;
    return { exceeded: budget > 0 && spent >= budget, spent, budget };
  }

  private async runInbound(conversationId: string, task: Extract<Task, { kind: 'inbound' }>, lane: Lane) {
    const s = this.services();
    const { target, role } = task;
    const budget = this.budgetExceeded();
    if (budget.exceeded) {
      await s.delivery.reply(
        conversationId,
        target,
        `I've hit today's spending limit ($${budget.spent.toFixed(2)} of $${budget.budget.toFixed(2)}). Send */budget ${Math.ceil(budget.budget * 2)}* to raise it for today.`,
      );
      return;
    }

    lane.abort = new AbortController();
    const signal = lane.abort.signal;
    const ch = s.channels.get(target.channel as any);
    const lastId = task.msgs[task.msgs.length - 1].id;
    // WhatsApp's typing bubble fades after ~25s; keep it alive while working.
    const typing = ch?.markRead ? setInterval(() => ch.markRead!(lastId, true).catch(() => {}), 20_000) : undefined;
    const progress = setTimeout(() => {
      s.delivery.reply(conversationId, target, '⏳ Still on it — this one is taking a bit longer.').catch(() => {});
    }, 120_000);

    try {
      const turn = await buildUserTurn(s, conversationId, task.msgs);
      s.store.addTranscript(conversationId, 'user', target.channel, turn.transcript);
      const result = await s.runner.run({
        conversationId,
        role,
        kind: 'chat',
        input: turn.content,
        persist: true,
        signal,
        replyTarget: target,
        channelLabel: { whatsapp: 'WhatsApp', discord: 'Discord', web: 'web chat', console: 'terminal' }[target.channel],
      });
      if (result.aborted) return;
      if (!result.text) {
        if (!result.sentMessages.length) await s.delivery.reply(conversationId, target, '👍');
      } else {
        const voice = s.store.get('voice_mode') ?? 'mirror';
        if (s.media.canSpeak && (voice === 'always' || (voice === 'mirror' && turn.hadVoice))) {
          try {
            const audio = await s.media.speak(result.text);
            const file = saveFile(filesRoot(s.store, conversationId), 'out', `reply-${Date.now()}.ogg`, audio);
            await s.delivery.sendMedia(conversationId, { path: file, mime: 'audio/ogg', kind: 'audio', voice: true }, target);
          } catch (err) {
            log.warn('voice reply failed; sending text only', err);
          }
        }
        await s.delivery.reply(conversationId, target, result.text);
      }
      await this.maybeCompact(conversationId, role);
    } catch (err) {
      if (signal.aborted) return;
      log.error('turn failed', err);
      await s.delivery.reply(conversationId, target, friendlyError(err)).catch(() => {});
    } finally {
      clearTimeout(progress);
      if (typing) clearInterval(typing);
    }
  }

  private async runInternal(conversationId: string, text: string, lane: Lane) {
    const s = this.services();
    const role: Role = conversationId.startsWith('member:') ? 'member' : 'owner';
    lane.abort = new AbortController();
    try {
      const result = await s.runner.run({
        conversationId,
        role,
        kind: 'chat',
        input: text,
        persist: true,
        signal: lane.abort.signal,
        channelLabel: 'automated update',
      });
      if (!result.aborted && result.text) await s.delivery.notify(conversationId, result.text);
      await this.maybeCompact(conversationId, role);
    } catch (err) {
      if (lane.abort.signal.aborted) return;
      log.error('automated turn failed', err);
      await s.delivery.notify(conversationId, `⚠️ Background work finished but I couldn't summarize it: ${friendlyError(err)}`).catch(() => {});
    }
  }

  private async maybeCompact(conversationId: string, role: Role) {
    const s = this.services();
    if (s.store.contextTokens(conversationId) < s.config.compactAtTokens) return;
    try {
      await s.runner.compact(conversationId, role);
    } catch (err) {
      log.warn('compaction failed; will retry after the next turn', err);
    }
  }
}
