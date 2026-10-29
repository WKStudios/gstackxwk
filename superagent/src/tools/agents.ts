/** Sub-agents (parallel research) and the code sandbox. */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { defineTool, ToolError, type ToolContext, type ToolDef } from './types';
import { startBackground, finishBackground } from '../background';
import { filesRoot, mimeFor, relPath, resolveFile, saveFile } from './files';
import { truncate } from '../format';
import { summarizeUsage } from '../agent/pricing';
import { BETAS } from '../agent/runner';
import { errorMessage } from '../log';

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

function subagentInstructions(owner: string, title: string, goal?: string): string {
  return `# You are a sub-agent
You're one of several sub-agents working in parallel for ${owner}'s agent${goal ? ` on: ${goal}` : ''}. Your part: "${title}".
- Do the research yourself with the tools you have; you can't message ${owner} or ask questions.
- Prefer primary sources, check dates, and verify numbers with a second source where it matters.
- Finish with a compact report (under ~400 words): findings first, then sources as links, then anything uncertain.`;
}

export const agentTools: ToolDef[] = [
  defineTool({
    name: 'delegate',
    description:
      'Split work across parallel sub-agents (up to 12). Each gets a brief, researches with web search, the browser, memory and read-only email/calendar/notes, and reports back. Use for research with independent parts (compare 5 vendors, dig into a company from several angles). Set background=true for anything longer than a couple of minutes: you reply now, and the combined results come back to this chat as an automated update for you to summarize.',
    input: z.object({
      goal: z.string().describe('The overall question these parts answer'),
      tasks: z
        .array(z.object({ title: z.string(), brief: z.string().describe('Standalone instructions: what to find, scope, output') }))
        .min(1)
        .max(12),
      background: z.boolean().optional(),
    }),
    run: async (input, ctx) => {
      const { runner, config, hooks } = ctx.services;
      if (input.tasks.length > config.maxSubagents) throw new ToolError(`At most ${config.maxSubagents} sub-agents at once.`);
      const runAll = (signal: AbortSignal) =>
        mapLimit(input.tasks, config.maxSubagents, async t => {
          try {
            const r = await runner.run({
              conversationId: ctx.conversationId,
              role: ctx.role,
              kind: 'subagent',
              input: t.brief,
              persist: false,
              signal,
              toolFilter: d => !!d.readOnly,
              systemExtra: subagentInstructions(config.ownerName, t.title, input.goal),
              maxIterations: 30,
            });
            return `## ${t.title}\n${truncate(r.text || '(no findings)', 8000)}`;
          } catch (err) {
            return `## ${t.title}\n(failed: ${errorMessage(err)})`;
          }
        });

      if (!input.background) {
        const results = await runAll(ctx.signal);
        return results.join('\n\n');
      }

      const task = startBackground(ctx.conversationId, `${input.tasks.length} sub-agents: ${truncate(input.goal, 80)}`);
      void runAll(task.controller.signal).then(results => {
        finishBackground(task.id);
        if (task.controller.signal.aborted) return;
        hooks.enqueueTurn(
          ctx.conversationId,
          `<automated_update source="sub-agents">\nBackground research finished for: ${input.goal}\n\n${results.join('\n\n')}\n</automated_update>\nWrite ${config.ownerName} the final answer from these results (recommendation first, sources linked).`,
        );
      });
      return `Started ${input.tasks.length} sub-agent(s) in the background (${task.id}). Results will come back to this chat. Tell ${config.ownerName} it's running and roughly what to expect.`;
    },
  }),
  defineTool({
    name: 'run_code',
    description:
      'Run Python/bash in a secure cloud sandbox (no internet). Use for data analysis, spreadsheets, charts, converting or reading files (docx/xlsx/pptx/csv/zip), and calculations. Pass files from the files folder; files the code creates come back into the files folder so you can send_file them. The sandbox keeps state between calls in this conversation.',
    input: z.object({
      task: z.string().describe('What to compute or produce, including output file names'),
      files: z.array(z.string()).optional().describe('Paths in the files folder to upload into the sandbox'),
      fresh: z.boolean().optional().describe('Start a new sandbox instead of reusing the last one'),
    }),
    run: async (input, ctx) => runSandbox(input, ctx),
  }),
];

function collectFileIds(value: unknown, out: Set<string>) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) collectFileIds(v, out);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.file_id === 'string' && typeof obj.type === 'string' && obj.type.endsWith('_output')) out.add(obj.file_id);
  for (const v of Object.values(obj)) collectFileIds(v, out);
}

async function runSandbox(input: { task: string; files?: string[]; fresh?: boolean }, ctx: ToolContext): Promise<string> {
  const { claude, store, config } = ctx.services;
  const root = filesRoot(store, ctx.conversationId);
  const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [
    {
      type: 'text',
      text: `${input.task}\n\nWork in the sandbox. Uploaded input files are in the working directory. Write any files meant for ${config.ownerName} to the working directory and say their names. End with a short plain-text summary of the result.`,
    },
  ];
  for (const f of input.files ?? []) {
    const p = resolveFile(root, f);
    const uploaded = await claude.files.upload({
      file: await toFile(fs.readFileSync(p), path.basename(p), { type: mimeFor(p) }),
    });
    content.push({ type: 'container_upload', file_id: uploaded.id });
  }

  const containerKey = `container:${ctx.conversationId}`;
  let container = input.fresh ? undefined : store.get(containerKey) ?? undefined;
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: 'user', content }];
  const fileIds = new Set<string>();
  let finalText = '';

  for (let i = 0; i < 8; i++) {
    let msg: Anthropic.Beta.Messages.BetaMessage;
    try {
      msg = await claude.beta.messages
        .stream(
          {
            model: config.model,
            max_tokens: 16_000,
            messages,
            tools: [{ type: 'code_execution_20260521', name: 'code_execution' }],
            output_config: { effort: 'medium' },
            fallbacks: 'default',
            betas: [BETAS.fallback],
            ...(container ? { container } : {}),
          },
          { signal: ctx.signal },
        )
        .finalMessage();
    } catch (err) {
      if (container && err instanceof Anthropic.APIError && err.status && err.status < 500) {
        // The saved sandbox expired; start a fresh one.
        container = undefined;
        store.set(containerKey, null);
        i--;
        continue;
      }
      throw err;
    }
    const usage = summarizeUsage(config.model, msg.usage as any);
    store.recordUsage({ conversationId: ctx.conversationId, kind: 'sandbox', model: config.model, ...usage });
    if (msg.container?.id) {
      container = msg.container.id;
      store.set(containerKey, container);
    }
    collectFileIds(msg.content, fileIds);
    messages.push({ role: 'assistant', content: msg.content as any });
    const text = msg.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
    if (text) finalText = text;
    if (msg.stop_reason !== 'pause_turn') break;
  }

  const saved: string[] = [];
  for (const id of fileIds) {
    try {
      const meta = await claude.files.retrieveMetadata(id);
      const resp = await claude.files.download(id);
      const file = saveFile(root, 'out', meta.filename || `${id}.bin`, Buffer.from(await resp.arrayBuffer()));
      saved.push(relPath(root, file));
    } catch (err) {
      saved.push(`(could not download ${id}: ${errorMessage(err)})`);
    }
  }
  return `${finalText || '(no summary)'}${saved.length ? `\n\nFiles saved: ${saved.join(', ')}` : ''}`;
}
