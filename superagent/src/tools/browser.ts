/**
 * Real-browser tool on top of gstack browse. Secrets from the vault are
 * substituted at execution time ({{secret:NAME}}) and redacted from output,
 * so logins work without the password ever entering the conversation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { splitArgs } from '../integrations/browser';
import { defineTool, ToolError, type ToolDef, type ToolResultContent } from './types';
import { filesRoot, resolveFile } from './files';
import { assertPublicUrl } from '../net';
import type { Store } from '../store';

const BLOCKED = new Set(['eval', 'chain', 'cookie-import', 'cookie-import-browser', 'stop', 'restart']);
const SECRET_RE = /\{\{secret:([A-Za-z0-9_.-]+)\}\}/g;

export function vaultGet(store: Store, name: string): string | null {
  return store.get(`vault:${name.toLowerCase()}`);
}

export function vaultNames(store: Store): string[] {
  return (store.db.query("SELECT key FROM kv WHERE key LIKE 'vault:%' ORDER BY key").all() as { key: string }[]).map(r =>
    r.key.slice('vault:'.length),
  );
}

function substitute(store: Store, arg: string, used: Map<string, string>): string {
  return arg.replace(SECRET_RE, (_m, name: string) => {
    const value = vaultGet(store, name);
    if (value === null) throw new ToolError(`No vault secret "${name}". The owner can add it with /vault set ${name} <value>.`);
    used.set(name, value);
    return value;
  });
}

function redact(text: string, used: Map<string, string>): string {
  let out = text;
  for (const [name, value] of used) if (value.length >= 3) out = out.split(value).join(`[secret:${name}]`);
  return out;
}

export const browserTools: ToolDef[] = [
  defineTool({
    name: 'browser',
    description: `Drive a real headless Chromium (cookies and tabs persist between calls). Give one or more gstack browse commands, run in order:
  goto <url> · back · reload · url · text · html [sel] · links · forms
  snapshot -i   (interactive elements with @e refs — use refs as selectors)
  click @e3 · fill @e4 "value" · select @e5 "option" · type "text" · press Enter · scroll · wait --networkidle
  screenshot    (saved to the files folder and shown to you) · pdf · js "<expr>" · tabs · newtab <url>
  upload @e2 <path-in-files-folder> · dialog-accept · console --errors
Use {{secret:NAME}} for passwords and codes stored in the vault — never ask the owner to paste them in chat.
Set commits=true when the commands submit a form, apply, post, purchase, send, book, delete, or change account settings — the owner approves first.`,
    readOnly: true,
    input: z.object({
      commands: z.array(z.string()).min(1).max(25),
      commits: z.boolean().describe('True if this sequence submits, sends, buys, books, posts or deletes anything'),
      purpose: z.string().optional().describe('One line for the approval prompt, e.g. "Submit the visa application form"'),
    }),
    approval: (input, ctx) => {
      if (!input.commits) return null;
      if (ctx.runKind === 'subagent') throw new ToolError('Sub-agents can only read pages; report back and let the main agent act.');
      const shown = input.commands.map(c => c.replace(SECRET_RE, '[secret:$1]')).slice(0, 8);
      return `🌐 ${input.purpose ?? 'Browser action that submits or changes something'}\n${shown.map(c => `• ${c}`).join('\n')}`;
    },
    run: async (input, ctx): Promise<ToolResultContent> => {
      const { browser, store } = ctx.services;
      const root = filesRoot(store, ctx.conversationId);
      if (ctx.role !== 'owner' && input.commands.some(c => new RegExp(SECRET_RE.source).test(c))) {
        throw new ToolError("The vault belongs to the owner; secrets aren't available in this conversation.");
      }
      const used = new Map<string, string>();
      const outputs: string[] = [];
      let lastShot: string | null = null;
      const shotsDir = path.join(root, 'shots');
      fs.mkdirSync(shotsDir, { recursive: true });

      for (const raw of input.commands) {
        if (ctx.signal.aborted) break;
        const [command, ...rest] = splitArgs(raw.trim());
        if (!command) continue;
        if (BLOCKED.has(command)) throw new ToolError(`"${command}" isn't available to the agent.`);
        let args = rest.map(a => substitute(store, a, used));
        if (command === 'screenshot' || command === 'pdf') {
          const file = path.join(command === 'pdf' ? path.join(root, 'out') : shotsDir, `${command}-${Date.now()}.${command === 'pdf' ? 'pdf' : 'png'}`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          args = [file];
          if (command === 'screenshot') lastShot = file;
        } else if (command === 'snapshot') {
          const o = args.findIndex(a => a === '-o' || a === '--output');
          if (o >= 0) args.splice(o, 2);
          if (args.includes('-a') || args.includes('--annotate')) {
            lastShot = path.join(shotsDir, `annotated-${Date.now()}.png`);
            args.push('-o', lastShot);
          }
        } else if (command === 'responsive') {
          args = [path.join(shotsDir, `responsive-${Date.now()}`)];
        } else if ((command === 'goto' || command === 'newtab') && args[0]) {
          if (!/^https?:\/\//i.test(args[0])) args[0] = `https://${args[0]}`;
          assertPublicUrl(args[0]);
        } else if (command === 'upload') {
          args = args.map((a, i) => (i === 0 ? a : resolveFile(root, a)));
        }
        try {
          const out = await browser.command(command, args);
          outputs.push(`$ ${raw.replace(SECRET_RE, '[secret:$1]')}\n${redact(out.trim(), used).slice(0, 20_000)}`);
        } catch (err) {
          outputs.push(`$ ${raw.replace(SECRET_RE, '[secret:$1]')}\nERROR: ${redact((err as Error).message, used)}`);
          break;
        }
      }

      const text = outputs.join('\n\n');
      if (lastShot && fs.existsSync(lastShot)) {
        const rel = path.relative(root, lastShot);
        return [
          { type: 'text', text: `${text}\n\n(screenshot saved as ${rel} — send_file it if the owner should see it)` },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(lastShot).toString('base64') } },
        ];
      }
      return text;
    },
  }),
];
