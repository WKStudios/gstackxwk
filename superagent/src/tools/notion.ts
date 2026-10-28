/** Notion tools: search, read, write, databases, and The Hub capture inbox. */

import { z } from 'zod';
import { defineTool, ToolError, type ToolContext, type ToolDef } from './types';
import type { NotionClient } from '../integrations/notion';
import { truncate } from '../format';

function notion(ctx: ToolContext): NotionClient {
  if (!ctx.services.notion) throw new ToolError('Notion isn\'t connected (set NOTION_TOKEN and share pages with the integration).');
  return ctx.services.notion;
}

const id = z.string().describe('Notion page or database id (from search results or a Notion URL)');

/** Accept a Notion URL or a bare id. */
export function notionId(ref: string): string {
  const m = ref.match(/([0-9a-f]{32})(?:\?|$)/i) || ref.replace(/-/g, '').match(/([0-9a-f]{32})/i);
  return m ? m[1] : ref;
}

export const notionTools: ToolDef[] = [
  defineTool({
    ownerOnly: true,
    name: 'capture_to_hub',
    description:
      'File a capture into The Hub (the owner\'s Notion inbox database): ideas, hooks, links, screenshots/voice notes turned into text, half-formed thoughts. Tag it by project. Use whenever the owner says save/capture/note this, or sends something to keep.',
    input: z.object({
      title: z.string(),
      content: z.string().describe('Markdown body: the capture itself, cleaned up, plus context'),
      project: z.string().optional(),
      tags: z.array(z.string()).optional(),
      kind: z.string().optional().describe('e.g. idea, hook, task, reference, quote'),
      url: z.string().optional(),
    }),
    run: async (input, ctx) => {
      const n = notion(ctx);
      if (!n.hubDatabaseId) throw new ToolError('The Hub isn\'t set up (NOTION_HUB_DATABASE_ID). Use notion_create_page instead, or ask the owner which database to use.');
      const page = await n.captureToHub(input);
      return `Saved to The Hub: ${page.url}`;
    },
  }),
  defineTool({
    ownerOnly: true,
    name: 'notion_search',
    description: 'Search Notion pages and databases the integration can see, by title/text.',
    readOnly: true,
    input: z.object({ query: z.string(), kind: z.enum(['page', 'database']).optional() }),
    run: async (input, ctx) => {
      const rows = await notion(ctx).search(input.query, input.kind);
      return rows.length
        ? rows.map((r: any) => `- [${r.object}] ${r.title || '(untitled)'} · id=${r.id} · ${r.url} · edited ${String(r.lastEdited).slice(0, 10)}`).join('\n')
        : 'Nothing found (is the page shared with the integration?).';
    },
  }),
  defineTool({
    ownerOnly: true,
    name: 'notion_read_page',
    description: 'Read a Notion page: properties and content as Markdown.',
    readOnly: true,
    input: z.object({ page_id: id }),
    run: async (input, ctx) => `<notion_page>\n${truncate(await notion(ctx).readPage(notionId(input.page_id)), 100_000)}\n</notion_page>`,
  }),
  defineTool({
    ownerOnly: true,
    name: 'notion_query_database',
    description:
      'Query a Notion database. `filter` and `sorts` use the Notion API format, e.g. {"property":"Status","status":{"equals":"Inbox"}} or {"property":"Tags","multi_select":{"contains":"pricing"}}. Call notion_database_schema first if unsure of property names.',
    readOnly: true,
    input: z.object({
      database_id: id,
      filter: z.record(z.string(), z.unknown()).optional(),
      sorts: z.array(z.record(z.string(), z.unknown())).optional(),
      max: z.number().int().min(1).max(100).optional(),
    }),
    run: async (input, ctx) => {
      const rows = await notion(ctx).queryDatabase(notionId(input.database_id), input.filter, input.sorts, input.max ?? 25);
      if (!rows.length) return 'No rows.';
      return rows
        .map(
          (r: any) =>
            `- id=${r.id} ${r.url}\n  ${Object.entries(r.properties)
              .filter(([, v]) => v)
              .map(([k, v]) => `${k}: ${truncate(String(v), 120)}`)
              .join(' · ')}`,
        )
        .join('\n');
    },
  }),
  defineTool({
    ownerOnly: true,
    name: 'notion_database_schema',
    description: 'Show a database\'s properties, their types and select options.',
    readOnly: true,
    input: z.object({ database_id: id }),
    run: async (input, ctx) => {
      const s = await notion(ctx).schema(notionId(input.database_id));
      return `${s.title}\n${s.properties.map(p => `- ${p.name}: ${p.type}${p.options?.length ? ` [${p.options.join(', ')}]` : ''}`).join('\n')}`;
    },
  }),
  defineTool({
    ownerOnly: true,
    name: 'notion_create_page',
    description: 'Create a page in a database (with properties) or under a parent page, with Markdown content.',
    input: z.object({
      database_id: z.string().optional(),
      parent_page_id: z.string().optional(),
      title: z.string(),
      properties: z.record(z.string(), z.unknown()).optional().describe('Simple values by property name, e.g. {"Status":"Inbox","Tags":["a","b"],"Due":"2026-11-01"}'),
      content: z.string().optional().describe('Markdown'),
    }),
    run: async (input, ctx) => {
      if (!input.database_id && !input.parent_page_id) throw new ToolError('Give database_id or parent_page_id.');
      const page = await notion(ctx).createPage({
        databaseId: input.database_id ? notionId(input.database_id) : undefined,
        parentPageId: input.parent_page_id ? notionId(input.parent_page_id) : undefined,
        title: input.title,
        properties: input.properties,
        markdown: input.content,
      });
      return `Created ${page.url}`;
    },
  }),
  defineTool({
    ownerOnly: true,
    name: 'notion_update_page',
    description: 'Update a database page\'s properties (e.g. Status → Filed, add Tags) and/or append Markdown content. Archiving (deleting) a page needs approval.',
    input: z.object({
      page_id: id,
      properties: z.record(z.string(), z.unknown()).optional(),
      append: z.string().optional().describe('Markdown to add at the end of the page'),
      archive: z.boolean().optional(),
    }),
    approval: input => (input.archive ? `🗑️ Archive Notion page ${input.page_id}` : null),
    run: async (input, ctx) => {
      const n = notion(ctx);
      const pageId = notionId(input.page_id);
      const out: string[] = [];
      if (input.properties || input.archive !== undefined) {
        const page = await n.updatePage(pageId, input.properties ?? {}, input.archive);
        out.push(`Updated ${page.url}`);
      }
      if (input.append) out.push(`Appended ${await n.appendMarkdown(pageId, input.append)} block(s).`);
      return out.join(' ') || 'Nothing to change.';
    },
  }),
  defineTool({
    ownerOnly: true,
    name: 'notion_create_database',
    description:
      'Create a new database under a page. properties maps names to types: title, rich_text, number, date, checkbox, url, email, select:Opt1,Opt2, multi_select:A,B, status. Use for trackers, CRMs, reading lists, templates.',
    input: z.object({ parent_page_id: id, title: z.string(), properties: z.record(z.string(), z.string()) }),
    run: async (input, ctx) => {
      const db = await notion(ctx).createDatabase(notionId(input.parent_page_id), input.title, input.properties);
      return `Created database ${db.url} (id=${db.id}).`;
    },
  }),
];
