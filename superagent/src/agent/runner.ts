/**
 * The agent loop — a manual streaming loop over the Messages API.
 *
 *   history + new turn ──▶ stream() ──▶ assistant message (persisted verbatim)
 *        ▲                                  │
 *        │                     stop_reason? ├─ end_turn ─────────▶ done
 *        │                                  ├─ pause_turn ───────▶ resend as is
 *        │                                  ├─ refusal ──────────▶ done (no tools)
 *        └── tool_results (one user msg) ◀──┴─ tool_use ─▶ validate ▶ approve? ▶ run
 *
 * The loop is manual (not the SDK tool runner) because a turn can block for
 * minutes on a WhatsApp approval, must be abortable with "stop", and persists
 * every message as it lands so a crash never leaves a half-written history.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Effort } from '../config';
import type { Services } from '../services';
import type { MessageParam } from '../store';
import { logger, errorMessage } from '../log';
import { truncate } from '../format';
import { toApiTool, ToolError, type Role, type RunKind, type ReplyTarget, type ToolContext, type ToolDef, type ToolResultContent } from '../tools/types';
import { buildSystem, supportsSystemMessages, turnContext } from './prompt';
import { contextSize, summarizeUsage } from './pricing';

const log = logger('runner');

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
type ToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
type ToolResultBlock = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type ToolUnion = Anthropic.Beta.Messages.BetaToolUnion;

export const BETAS = {
  compaction: 'compact-2026-09-04',
  fallback: 'server-side-fallback-2026-07-01',
  clearAt: 'mid-conversation-system-clear-at-2026-08-21',
  mcp: 'mcp-client-2025-11-20',
} as const;

const MAX_RESULT_CHARS = 60_000;

export interface RunRequest {
  conversationId: string;
  role: Role;
  kind: RunKind;
  /** The new turn: plain text, or content blocks (images, documents…). */
  input: string | Anthropic.Beta.Messages.BetaContentBlockParam[];
  /** Continue the stored conversation (chat) or start from nothing (background work). */
  persist: boolean;
  effort?: Effort;
  signal?: AbortSignal;
  replyTarget?: ReplyTarget;
  channelLabel?: string;
  /** Extra system instructions (what this job or mission is). */
  systemExtra?: string;
  /** Restrict the toolset (sub-agents get read-only tools). */
  toolFilter?: (t: ToolDef) => boolean;
  maxIterations?: number;
}

export interface RunResult {
  text: string;
  stopReason: string | null;
  aborted: boolean;
  costUsd: number;
  /** Messages a background run sent to the owner directly (send_message etc.). */
  sentMessages: string[];
  iterations: number;
}

export interface ToolRegistry {
  all(): ToolDef[];
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}

function queryText(input: RunRequest['input']): string {
  if (typeof input === 'string') return input;
  return input
    .map(b => (b.type === 'text' ? b.text : ''))
    .join(' ')
    .slice(0, 2000);
}

function capResult(content: ToolResultContent): ToolResultContent {
  if (typeof content === 'string') {
    return content.length > MAX_RESULT_CHARS
      ? `${content.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${content.length - MAX_RESULT_CHARS} characters]`
      : content;
  }
  return content.map(b =>
    b.type === 'text' && b.text.length > MAX_RESULT_CHARS ? { ...b, text: `${b.text.slice(0, MAX_RESULT_CHARS)}\n…[truncated]` } : b,
  );
}

/**
 * Make a stored history valid to send again: an assistant tool_use with no
 * results (crash mid-tool) gets "interrupted" results; a dangling system
 * message gets an assistant turn after it. Repairs are appended, never edits.
 */
export function repairTail(history: MessageParam[]): MessageParam[] {
  const last = history[history.length - 1];
  if (!last) return [];
  if (last.role === 'assistant' && Array.isArray(last.content)) {
    const uses = last.content.filter((b: any) => b.type === 'tool_use') as { id: string }[];
    if (uses.length) {
      return [
        {
          role: 'user',
          content: uses.map(u => ({
            type: 'tool_result' as const,
            tool_use_id: u.id,
            is_error: true,
            content: 'Interrupted before this tool finished (the agent restarted or was stopped).',
          })),
        },
      ];
    }
  }
  if (last.role === 'system') {
    return [{ role: 'assistant', content: [{ type: 'text', text: '(That turn was interrupted before I replied.)' }] }];
  }
  return [];
}

export class AgentRunner {
  private registry: ToolRegistry = { all: () => [] };

  constructor(private readonly services: () => Services) {}

  setRegistry(registry: ToolRegistry) {
    this.registry = registry;
  }

  /** Tools visible to a run, filtered by role and caller. */
  toolsFor(role: Role, filter?: (t: ToolDef) => boolean): ToolDef[] {
    return this.registry.all().filter(t => (role === 'owner' || !t.ownerOnly) && (!filter || filter(t)));
  }

  private apiTools(defs: ToolDef[]): ToolUnion[] {
    const s = this.services();
    const tools: ToolUnion[] = [
      { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 },
      ...defs.map(toApiTool),
    ];
    for (const server of s.config.mcpServers) {
      tools.push({ type: 'mcp_toolset', mcp_server_name: server.name });
    }
    return tools;
  }

  private betas(): string[] {
    const s = this.services();
    const betas: string[] = [BETAS.compaction, BETAS.fallback];
    if (supportsSystemMessages(s.config.model)) betas.push(BETAS.clearAt);
    if (s.config.mcpServers.length) betas.push(BETAS.mcp);
    return betas;
  }

  private mcpServers(): Anthropic.Beta.Messages.BetaRequestMCPServerURLDefinition[] | undefined {
    const servers = this.services().config.mcpServers;
    if (!servers.length) return undefined;
    return servers.map(m => ({ type: 'url', name: m.name, url: m.url, authorization_token: m.authorization_token ?? null }));
  }

  /** One streamed model call; retries a turn whose tool input wasn't parseable JSON. */
  private async callModel(params: {
    system: Anthropic.Beta.Messages.BetaTextBlockParam[];
    messages: MessageParam[];
    tools: ToolUnion[];
    effort: Effort;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<BetaMessage> {
    const s = this.services();
    let jsonRetries = 0;
    while (true) {
      const stream = s.claude.beta.messages.stream(
        {
          model: s.config.model,
          max_tokens: params.maxTokens,
          system: params.system,
          messages: params.messages,
          tools: params.tools,
          thinking: { type: 'adaptive' },
          output_config: { effort: params.effort },
          cache_control: { type: 'ephemeral' },
          fallbacks: 'default',
          betas: this.betas(),
          ...(this.mcpServers() ? { mcp_servers: this.mcpServers() } : {}),
        },
        { signal: params.signal },
      );
      try {
        return await stream.finalMessage();
      } catch (err) {
        if (err instanceof Anthropic.APIError || params.signal?.aborted || jsonRetries++ >= 2) throw err;
        log.warn('tool input was not parseable JSON, re-issuing the turn', err);
      }
    }
  }

  async run(req: RunRequest): Promise<RunResult> {
    const s = this.services();
    const signal = req.signal ?? new AbortController().signal;
    const effort = req.effort ?? (req.kind === 'chat' || req.kind === 'subagent' ? s.config.chatEffort : s.config.backgroundEffort);
    const defs = this.toolsFor(req.role, req.toolFilter);
    const byName = new Map(defs.map(d => [d.name, d]));
    const tools = this.apiTools(defs);
    const system = buildSystem(s, req.role, req.conversationId, req.systemExtra);

    const ctx: ToolContext = {
      conversationId: req.conversationId,
      role: req.role,
      runKind: req.kind,
      replyTarget: req.replyTarget,
      signal,
      services: s,
      sentMessages: [],
    };

    // ── Assemble the conversation ──────────────────────────────
    let messages: MessageParam[] = [];
    const append = (...msgs: MessageParam[]) => {
      messages.push(...msgs);
      if (req.persist) s.store.appendMessages(req.conversationId, msgs);
    };

    if (req.persist) {
      messages = s.store.history(req.conversationId);
      const repairs = repairTail(messages);
      if (repairs.length) append(...repairs);
    }

    const contextFor = () =>
      turnContext(s, {
        conversationId: req.conversationId,
        channel: req.channelLabel,
        query: queryText(req.input),
        runKind: req.kind,
      });
    const context = contextFor();
    const userContent: Anthropic.Beta.Messages.BetaContentBlockParam[] =
      typeof req.input === 'string' ? [{ type: 'text', text: req.input }] : req.input;

    if (supportsSystemMessages(s.config.model)) {
      append(
        { role: 'user', content: userContent },
        { role: 'system', content: context, clear_at: 'next_user_message' },
      );
    } else {
      append({ role: 'user', content: [{ type: 'text', text: `<context>\n${context}\n</context>` }, ...userContent] });
    }

    // ── Loop ───────────────────────────────────────────────────
    const maxIterations = req.maxIterations ?? (req.kind === 'chat' ? 40 : 60);
    const maxTokens = req.kind === 'chat' ? 32_000 : 64_000;
    let segmentText: string[] = [];
    let stopReason: string | null = null;
    let costUsd = 0;
    let iterations = 0;
    let aborted = false;

    try {
      while (iterations < maxIterations) {
        iterations++;
        const msg = await this.callModel({ system, messages, tools, effort, maxTokens, signal });
        stopReason = msg.stop_reason;
        const usage = summarizeUsage(s.config.model, msg.usage as any);
        costUsd += usage.costUsd;
        s.store.recordUsage({ conversationId: req.conversationId, kind: req.kind, model: s.config.model, ...usage });
        if (req.persist) s.store.setContextTokens(req.conversationId, contextSize(msg.usage as any));

        append({ role: 'assistant', content: msg.content as any });
        const text = textOf(msg.content);
        if (text) segmentText.push(text);

        if (msg.stop_reason === 'pause_turn') continue;
        if (msg.stop_reason === 'refusal') {
          if (!segmentText.length) segmentText.push("I can't help with that one.");
          break;
        }

        const uses = msg.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
        if (uses.length === 0) break;

        const truncated = msg.stop_reason === 'max_tokens' || msg.stop_reason === 'model_context_window_exceeded';
        // A cut-off tool input can parse as valid-but-partial JSON; never run it.
        const results = truncated
          ? uses.map(u => ({
              type: 'tool_result' as const,
              tool_use_id: u.id,
              is_error: true,
              content: 'Your output hit the token limit before this tool input was complete. Retry with a smaller input (split the work).',
            }))
          : await this.executeTools(uses, byName, ctx);
        append({ role: 'user', content: results });
        segmentText = [];
        if (signal.aborted) {
          aborted = true;
          break;
        }
        // A tool_result message clears the turn's context note, so the model
        // would lose track of the time mid-task. Re-attach a fresh copy after
        // every round; cleared copies cost nothing.
        if (supportsSystemMessages(s.config.model)) {
          append({ role: 'system', content: contextFor(), clear_at: 'next_user_message' });
        }
      }
    } catch (err) {
      if (signal.aborted || err instanceof Anthropic.APIUserAbortError) {
        aborted = true;
      } else {
        throw err;
      }
    }

    let text = segmentText.join('\n\n').trim();
    if (!text && !aborted && iterations >= maxIterations) {
      text = "I hit my step limit on this one before finishing. Tell me to keep going and I'll pick up where I left off.";
    }
    return { text, stopReason, aborted, costUsd, sentMessages: ctx.sentMessages, iterations };
  }

  /** Run every tool call from one assistant turn; approvals are asked one at a time. */
  private async executeTools(uses: ToolUseBlock[], byName: Map<string, ToolDef>, ctx: ToolContext): Promise<ToolResultBlock[]> {
    const s = ctx.services;
    let approvalChain: Promise<unknown> = Promise.resolve();

    const runOne = async (use: ToolUseBlock): Promise<ToolResultBlock> => {
      const def = byName.get(use.name);
      if (!def) {
        return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Unknown tool "${use.name}".` };
      }
      const parsed = (def.input as z.ZodType).safeParse(use.input);
      if (!parsed.success) {
        return {
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: true,
          content: JSON.stringify({ INVALID_INPUT: JSON.stringify(use.input), problems: z.prettifyError(parsed.error) }),
        };
      }
      const input = parsed.data;
      try {
        const summary = def.approval ? await def.approval(input, ctx) : null;
        if (summary) {
          const decision = await new Promise<Awaited<ReturnType<typeof s.approvals.request>>>((resolve, reject) => {
            approvalChain = approvalChain
              .then(() => s.approvals.request(ctx.conversationId, def.name, summary, ctx.signal, { freeText: ctx.runKind === 'chat' }))
              .then(resolve, reject);
          });
          if (decision.status !== 'approved') {
            const why =
              decision.status === 'expired'
                ? 'No answer came back in time, so it was not done.'
                : `${s.config.ownerName} said no${decision.note ? `: "${decision.note}"` : ''}.`;
            s.store.audit(ctx.conversationId, def.name, input, `not approved (${decision.status})`, true);
            return {
              type: 'tool_result',
              tool_use_id: use.id,
              is_error: true,
              content: `Not approved. ${why} Don't retry this another way; ask what they'd like instead.`,
            };
          }
        }
        const content = capResult(await def.run(input, ctx));
        s.store.audit(ctx.conversationId, def.name, input, typeof content === 'string' ? content : '[blocks]', false);
        return { type: 'tool_result', tool_use_id: use.id, content };
      } catch (err) {
        const message = err instanceof ToolError ? err.message : `Tool failed: ${errorMessage(err)}`;
        if (!(err instanceof ToolError)) log.warn(`tool ${def.name} failed`, err);
        s.store.audit(ctx.conversationId, def.name, input, message, true);
        return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: truncate(message, 4000) };
      }
    };

    return Promise.all(uses.map(runOne));
  }

  /**
   * On-demand compaction between turns: summarize the whole active history
   * into one signed block that replaces it. Only the summary carries forward,
   * so compaction never runs mid-turn.
   */
  async compact(conversationId: string, role: Role): Promise<boolean> {
    const s = this.services();
    const history = s.store.history(conversationId);
    if (history.length < 4) return false;
    const lastId = s.store.lastMessageId(conversationId);
    const resp = await s.claude.beta.messages.create({
      model: s.config.model,
      max_tokens: 8192,
      system: buildSystem(s, role, conversationId),
      messages: history,
      tools: this.apiTools(this.toolsFor(role)),
      compaction: {
        type: 'summarize',
        instructions:
          `Summarize this conversation between ${s.config.ownerName} and their personal agent so the agent can continue seamlessly. ` +
          'Keep: open requests and promises, decisions made, names of people/companies/projects with context, dates and deadlines, ' +
          'ids of drafts/events/jobs/missions mentioned, the owner\'s stated preferences, and anything left unresolved. ' +
          'Drop pleasantries and resolved detail. Do not call tools; respond with the summary text only.',
      },
      betas: this.betas(),
      ...(this.mcpServers() ? { mcp_servers: this.mcpServers() } : {}),
    });
    const usage = summarizeUsage(s.config.model, resp.usage as any);
    s.store.recordUsage({ conversationId, kind: 'compaction', model: s.config.model, ...usage });
    if (resp.stop_reason !== 'compaction' || !resp.content.some(b => b.type === 'compaction')) {
      log.warn(`compaction returned no summary (stop_reason=${resp.stop_reason})`);
      return false;
    }
    s.store.applyCompaction(conversationId, { role: 'assistant', content: resp.content as any }, lastId);
    log.info(`compacted ${conversationId} (${history.length} messages)`);
    return true;
  }
}
