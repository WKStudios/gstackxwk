/** Memory, messaging, files, PDFs, images and skills. */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { chromium } from 'playwright';
import { defineTool, ToolError, type ToolContext, type ToolDef } from './types';
import { formatMemory } from '../agent/prompt';
import { filesRoot, mimeFor, relPath, resolveFile, saveFile } from './files';
import { truncate } from '../format';
import { formatLocal } from '../clock';
import { memoryScopes } from '../store';

const MEMORY_KINDS = ['person', 'project', 'preference', 'voice', 'deadline', 'commitment', 'fact', 'note', 'place', 'account'] as const;

async function deliverText(ctx: ToolContext, text: string): Promise<string> {
  const { delivery } = ctx.services;
  if (ctx.replyTarget) {
    await delivery.reply(ctx.conversationId, ctx.replyTarget, text);
    ctx.sentMessages.push(text);
    return 'sent';
  }
  const result = await delivery.notify(ctx.conversationId, text);
  ctx.sentMessages.push(text);
  return result === 'queued' ? 'queued (quiet hours or WhatsApp window closed — it will arrive when possible)' : 'sent';
}

const memoryTools: ToolDef[] = [
  defineTool({
    name: 'remember',
    description:
      'Save or update a durable memory about the owner\'s world: people (who they are, how the owner knows them), projects, preferences, writing voice, deadlines, commitments. Call this whenever you learn something you would want to know next week. Same kind+subject updates the existing memory. Pin only the handful of facts that matter in almost every conversation.',
    input: z.object({
      kind: z.enum(MEMORY_KINDS),
      subject: z.string().describe('Short handle, e.g. "Jai Patel" or "Project Atlas" or "email style"'),
      content: z.string().describe('The full current knowledge about this subject, rewritten (not appended) when updating'),
      tags: z.array(z.string()).optional(),
      pinned: z.boolean().optional().describe('Always include in context. Use sparingly.'),
      shared: z.boolean().optional().describe('Visible to the owner and every team member (team facts only, never personal details)'),
    }),
    run: async (input, ctx) => {
      const scope = input.shared ? 'shared' : ctx.conversationId;
      const m = ctx.services.store.remember(scope, input.kind, input.subject, input.content, input.tags ?? [], input.pinned ?? false);
      return `Saved memory #${m.id} (${m.kind}: ${m.subject}${input.shared ? ', shared' : ''}).`;
    },
  }),
  defineTool({
    name: 'recall',
    description:
      'Search memories by keywords (names, companies, topics). Call this before asking the owner something you might already know, and before drafting anything personal.',
    readOnly: true,
    input: z.object({ query: z.string(), kind: z.enum(MEMORY_KINDS).optional(), limit: z.number().int().max(30).optional() }),
    run: async (input, ctx) => {
      const rows = ctx.services.store.recall(memoryScopes(ctx.conversationId), input.query, input.limit ?? 10, input.kind);
      return rows.length ? rows.map(formatMemory).join('\n') : 'No matching memories.';
    },
  }),
  defineTool({
    name: 'list_memories',
    description: 'List memories, most recently updated first, optionally by kind.',
    readOnly: true,
    input: z.object({ kind: z.enum(MEMORY_KINDS).optional(), limit: z.number().int().max(100).optional() }),
    run: async (input, ctx) => {
      const rows = ctx.services.store.listMemories(memoryScopes(ctx.conversationId), input.kind, input.limit ?? 30);
      return rows.length ? rows.map(formatMemory).join('\n') : 'No memories yet.';
    },
  }),
  defineTool({
    name: 'forget',
    description: 'Delete a memory by id when it is wrong or the owner asks you to forget it.',
    input: z.object({ id: z.number().int() }),
    run: async (input, ctx) =>
      ctx.services.store.forget(memoryScopes(ctx.conversationId), input.id) ? `Forgot memory #${input.id}.` : `No memory #${input.id}.`,
  }),
  defineTool({
    name: 'search_history',
    description:
      'Full-text search over past conversations with the owner (including ones summarized away). Use for "what did I say about…", "when did we discuss…".',
    readOnly: true,
    input: z.object({ query: z.string(), limit: z.number().int().max(30).optional() }),
    run: async (input, ctx) => {
      const { store, config } = ctx.services;
      const rows = store.searchTranscript(ctx.conversationId, input.query, input.limit ?? 10);
      if (!rows.length) return 'Nothing found in past conversations.';
      return rows
        .map(r => `[${formatLocal(new Date(r.created_at), config.timezone)}] ${r.speaker === 'user' ? config.ownerName : 'You'}: ${truncate(r.text, 500)}`)
        .join('\n');
    },
  }),
];

const messagingTools: ToolDef[] = [
  defineTool({
    name: 'send_message',
    description:
      'Send the owner a message right now, before your final reply — for progress updates on long tasks, or for results from scheduled/background work. Your final reply is sent automatically; don\'t duplicate it here.',
    input: z.object({ text: z.string() }),
    run: async (input, ctx) => `Message ${await deliverText(ctx, input.text)}.`,
  }),
  defineTool({
    name: 'send_voice_note',
    description:
      'Send the owner a spoken voice note (text-to-speech). Use when they asked to listen rather than read, or sent you a voice note and want one back. Write for the ear: short sentences, no lists or links.',
    input: z.object({ text: z.string().describe('What to say, under ~1 minute of speech') }),
    run: async (input, ctx) => {
      const { media, store, delivery } = ctx.services;
      if (!media.canSpeak) throw new ToolError('Voice replies are not configured (TTS_API_KEY or OPENAI_API_KEY).');
      const audio = await media.speak(input.text);
      const file = saveFile(filesRoot(store, ctx.conversationId), 'out', `voice-${Date.now()}.ogg`, audio);
      await delivery.sendMedia(ctx.conversationId, { path: file, mime: 'audio/ogg', kind: 'audio', voice: true }, ctx.replyTarget);
      ctx.sentMessages.push(`[voice note] ${input.text}`);
      return 'Voice note sent.';
    },
  }),
  defineTool({
    name: 'send_file',
    description:
      'Send a file from the agent files folder to the owner (PDFs, images, CSVs, screenshots, anything you created or downloaded). Paths are relative to the files folder, as returned by other tools.',
    input: z.object({
      path: z.string(),
      caption: z.string().optional(),
      filename: z.string().optional().describe('Name the owner sees'),
    }),
    run: async (input, ctx) => {
      const { store, delivery } = ctx.services;
      const file = resolveFile(filesRoot(store, ctx.conversationId), input.path);
      const mime = mimeFor(file);
      const kind = mime.startsWith('image/') && !mime.includes('svg') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document';
      const size = fs.statSync(file).size;
      const limit = kind === 'image' ? 5 : kind === 'document' ? 100 : 16;
      if (size > limit * 1024 * 1024) {
        const token = store.hostFile(file, input.filename || path.basename(file), mime);
        const link = `${ctx.services.config.publicBaseUrl}/files/${token}/${encodeURIComponent(input.filename || path.basename(file))}`;
        return `Too large to attach (${(size / 1048576).toFixed(1)}MB). Share this link instead: ${link}`;
      }
      const result = await delivery.sendMedia(
        ctx.conversationId,
        { path: file, mime, kind, caption: input.caption, filename: input.filename || path.basename(file) },
        ctx.replyTarget,
      );
      ctx.sentMessages.push(`[file] ${path.basename(file)}`);
      return result === 'queued' ? 'Queued as a download link (WhatsApp window closed).' : 'File sent.';
    },
  }),
  defineTool({
    name: 'host_file',
    description: 'Create a private download link (expires) for a file in the files folder. Use for large files or when the owner wants a link to share.',
    input: z.object({ path: z.string(), hours: z.number().int().min(1).max(720).optional() }),
    run: async (input, ctx) => {
      const { store, config } = ctx.services;
      const file = resolveFile(filesRoot(store, ctx.conversationId), input.path);
      const name = path.basename(file);
      const token = store.hostFile(file, name, mimeFor(file), input.hours ?? 72);
      return `${config.publicBaseUrl}/files/${token}/${encodeURIComponent(name)} (expires in ${input.hours ?? 72}h)`;
    },
  }),
];

const PDF_CSS = `
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1a1a; line-height: 1.5; font-size: 11pt; }
  h1 { font-size: 20pt; margin: 0 0 4pt; } h2 { font-size: 14pt; margin: 18pt 0 6pt; border-bottom: 1px solid #ddd; padding-bottom: 3pt; }
  h3 { font-size: 12pt; margin: 14pt 0 4pt; } table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
  th, td { border: 1px solid #ddd; padding: 4pt 6pt; text-align: left; vertical-align: top; } th { background: #f5f5f5; }
  code, pre { font-family: Menlo, Consolas, monospace; font-size: 9.5pt; background: #f6f6f6; } pre { padding: 8pt; white-space: pre-wrap; }
  a { color: #0b57d0; } .muted { color: #666; }
`;

/** Shared headless Chromium for PDF rendering (separate from the browse server). */
let pdfBrowser: Promise<import('playwright').Browser> | null = null;

export async function renderPdf(html: string, title: string, landscape = false): Promise<Buffer> {
  // CHROMIUM_PATH lets servers use a system Chromium instead of Playwright's download.
  if (!pdfBrowser) pdfBrowser = chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const browser = await pdfBrowser.catch(err => {
    pdfBrowser = null;
    throw err;
  });
  const page = await browser.newPage();
  try {
    const doc = /<html[\s>]/i.test(html)
      ? html
      : `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title><style>${PDF_CSS}</style></head><body>${html}</body></html>`;
    // External resources are untrusted here; render what we were given, nothing more.
    await page.route('**/*', route => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    await page.setContent(doc, { waitUntil: 'load', timeout: 20_000 });
    return Buffer.from(
      await page.pdf({ format: 'A4', landscape, printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' } }),
    );
  } finally {
    await page.close();
  }
}

const fileTools: ToolDef[] = [
  defineTool({
    name: 'make_pdf',
    description:
      'Render HTML into a polished PDF in the files folder (reports, briefs, invoices, itineraries). Write semantic HTML (h1/h2/p/ul/table); a clean stylesheet is added unless you include your own <style>. External URLs are not loaded, so embed images as data: URIs. Then send it with send_file.',
    input: z.object({
      filename: z.string().describe('e.g. "acme-research.pdf"'),
      title: z.string(),
      html: z.string().describe('Body HTML, or a full HTML document'),
      landscape: z.boolean().optional(),
    }),
    run: async (input, ctx) => {
      const pdf = await renderPdf(input.html, input.title, input.landscape);
      const name = input.filename.toLowerCase().endsWith('.pdf') ? input.filename : `${input.filename}.pdf`;
      const root = filesRoot(ctx.services.store, ctx.conversationId);
      const file = saveFile(root, 'out', name, pdf);
      return `Saved ${relPath(root, file)} (${Math.ceil(pdf.length / 1024)} KB). Send it with send_file.`;
    },
  }),
  defineTool({
    name: 'write_file',
    description: 'Save a text file (CSV, Markdown, ICS calendar invite, JSON, vCard…) to the files folder, e.g. to send with send_file.',
    input: z.object({ filename: z.string(), content: z.string() }),
    run: async (input, ctx) => {
      const root = filesRoot(ctx.services.store, ctx.conversationId);
      const file = saveFile(root, 'out', input.filename, input.content);
      return `Saved ${relPath(root, file)} (${input.content.length} chars).`;
    },
  }),
  defineTool({
    name: 'generate_image',
    description: 'Generate an image from a text prompt and save it to the files folder. Send it with send_file.',
    input: z.object({
      prompt: z.string(),
      size: z.enum(['1024x1024', '1536x1024', '1024x1536']).optional(),
      filename: z.string().optional(),
    }),
    run: async (input, ctx) => {
      const { media, store } = ctx.services;
      if (!media.canImagine) throw new ToolError('Image generation is not configured (IMAGE_API_KEY or OPENAI_API_KEY).');
      const png = await media.generateImage(input.prompt, input.size ?? '1024x1024');
      const root = filesRoot(store, ctx.conversationId);
      const file = saveFile(root, 'out', input.filename ?? `image-${Date.now()}.png`, png);
      return `Saved ${relPath(root, file)}.`;
    },
  }),
];

const skillTools: ToolDef[] = [
  defineTool({
    name: 'read_skill',
    description: 'Read a playbook (skill) before doing the task it covers.',
    readOnly: true,
    input: z.object({ name: z.string() }),
    run: async (input, ctx) => {
      const skill = ctx.services.skills.get(input.name);
      if (!skill) throw new ToolError(`No skill "${input.name}". Available: ${ctx.services.skills.list().map(s => s.name).join(', ')}`);
      return skill.body;
    },
  }),
  defineTool({
    name: 'save_skill',
    description:
      'Create or update a playbook for something the owner does repeatedly ("how I like my weekly report", "how to file receipts"). Write clear steps that name the tools to use.',
    input: z.object({
      name: z.string().describe('lowercase-with-dashes'),
      description: z.string().describe('One line: when to use it'),
      body: z.string().describe('Markdown steps'),
    }),
    run: async (input, ctx) => {
      try {
        const skill = ctx.services.skills.save(input.name, input.description, input.body);
        return `Saved skill "${skill.name}". It will be listed in your skills from the next conversation turn.`;
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
    },
  }),
];

export const coreTools: ToolDef[] = [...memoryTools, ...messagingTools, ...fileTools, ...skillTools];
