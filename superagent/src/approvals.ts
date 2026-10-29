/**
 * Approval gates. A tool that needs the owner's OK parks its turn here:
 *
 *   tool call ─▶ request() ─▶ WhatsApp buttons [✅ Approve] [❌ Deny]
 *                    │                 │
 *                    │   tap / "yes" / 👍 reaction / any other reply
 *                    ▼                 ▼
 *               await decision ◀── handleInbound() ─ (runs outside the
 *                                                     conversation queue)
 *
 * While a chat turn waits on an approval, any other text counts as "no, and
 * here's what I want instead" — the note goes back to Claude so it can adjust.
 * Background approvals (schedules, missions) only take an explicit answer, so
 * ordinary chat isn't swallowed by a job you'd forgotten about.
 */

import type { Services } from './services';
import type { InboundMessage } from './channels/types';
import { logger } from './log';
import { truncate } from './format';

const log = logger('approvals');

export interface ApprovalDecision {
  status: 'approved' | 'denied' | 'expired';
  note?: string;
}

const YES = /^(y|yes|yep|yeah|ok|okay|approve|approved|go|go ahead|do it|send it|confirm|👍|✅)[.! ]*$/i;
const NO = /^(n|no|nope|deny|denied|cancel|don't|dont|❌|👎)[.! ]*$/i;

interface Waiter {
  resolve: (d: ApprovalDecision) => void;
  /** Free-text replies count as "no, do this instead" (chat turns only). */
  freeText: boolean;
  body: string;
}

export class Approvals {
  private waiters = new Map<string, Waiter>();

  constructor(
    private readonly services: () => Services,
    private readonly timeoutMs = 60 * 60_000,
  ) {}

  async request(
    conversationId: string,
    tool: string,
    summary: string,
    signal?: AbortSignal,
    opts: { freeText?: boolean } = {},
  ): Promise<ApprovalDecision> {
    const s = this.services();
    const row = s.store.createApproval(conversationId, tool, truncate(summary, 900));
    const body = `🔐 *Approval needed*\n${truncate(summary, 900)}`;
    const decision = new Promise<ApprovalDecision>(resolve => {
      const timer = setTimeout(() => this.settle(row.id, { status: 'expired' }), this.timeoutMs);
      const onAbort = () => this.settle(row.id, { status: 'denied', note: 'stopped' });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(row.id, {
        freeText: opts.freeText ?? false,
        body,
        resolve: d => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(d);
        },
      });
    });
    try {
      const messageId = await s.delivery.ask(conversationId, body, [
        { id: `apv:${row.id}:yes`, title: '✅ Approve' },
        { id: `apv:${row.id}:no`, title: '❌ Deny' },
      ]);
      if (messageId) s.store.setApprovalMessage(row.id, messageId);
    } catch (err) {
      log.error('could not send approval request', err);
      this.settle(row.id, { status: 'expired' });
    }
    return decision;
  }

  private settle(id: string, decision: ApprovalDecision): boolean {
    const waiter = this.waiters.get(id);
    const s = this.services();
    const row = s.store.getApproval(id);
    if (!row || row.status !== 'pending') {
      this.waiters.delete(id);
      return false;
    }
    s.store.resolveApproval(id, decision.status);
    this.waiters.delete(id);
    waiter?.resolve(decision);
    return true;
  }

  /** Returns true when the inbound message was an answer to a pending approval. */
  handleInbound(conversationId: string, msg: InboundMessage): boolean {
    const s = this.services();

    if (msg.buttonId?.startsWith('apv:')) {
      const [, id, answer] = msg.buttonId.split(':');
      const row = s.store.getApproval(id);
      if (!row || row.conversation_id !== conversationId) return true;
      if (!this.settle(id, { status: answer === 'yes' ? 'approved' : 'denied' })) {
        void s.delivery.reply(conversationId, { channel: msg.channel, to: msg.from }, 'That request already expired or was answered.');
      }
      return true;
    }

    if (msg.type === 'reaction' && msg.reaction?.messageId) {
      const row = s.store.approvalByMessage(msg.reaction.messageId);
      if (!row || row.status !== 'pending' || row.conversation_id !== conversationId) return false;
      if (/👍|✅|👌|🙏/.test(msg.reaction.emoji)) return this.settle(row.id, { status: 'approved' });
      if (/👎|❌|🚫/.test(msg.reaction.emoji)) return this.settle(row.id, { status: 'denied' });
      return false;
    }

    const pending = s.store.pendingApprovals(conversationId).filter(p => this.waiters.has(p.id));
    if (pending.length === 0) return false;
    const text = (msg.text ?? '').trim();
    if (!text || msg.type !== 'text' || /^stop( all)?[.!]?$/i.test(text)) return false; // stop aborts the whole run

    const quoted = msg.replyToId ? pending.find(p => p.message_id === msg.replyToId) : undefined;
    const chatOnes = pending.filter(p => this.waiters.get(p.id)!.freeText);
    const lastSent = s.store.recentTranscript(conversationId, 1)[0];
    const background = pending.filter(p => !this.waiters.get(p.id)!.freeText);
    const latestBackground = background[background.length - 1];
    // A bare "yes" settles a background approval only if that request is the last thing we said.
    const backgroundTarget =
      latestBackground && lastSent?.speaker === 'agent' && lastSent.text === this.waiters.get(latestBackground.id)!.body
        ? latestBackground
        : undefined;
    const yesNoTarget = quoted ?? chatOnes[chatOnes.length - 1] ?? backgroundTarget;
    if (yesNoTarget && YES.test(text)) return this.settle(yesNoTarget.id, { status: 'approved' });
    if (yesNoTarget && NO.test(text)) return this.settle(yesNoTarget.id, { status: 'denied' });

    const freeTextTarget = quoted && this.waiters.get(quoted.id)!.freeText ? quoted : chatOnes[chatOnes.length - 1];
    if (!freeTextTarget) return false;
    return this.settle(freeTextTarget.id, { status: 'denied', note: truncate(text, 1000) });
  }

  hasWaiter(id: string): boolean {
    return this.waiters.has(id);
  }
}
