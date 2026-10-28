/**
 * Notion over the public REST API with an internal-integration token.
 * Share the pages/databases you want the agent to see with the integration.
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const API = 'https://api.notion.com/v1';

export interface PropertySchema {
  id: string;
  name: string;
  type: string;
  options?: string[];
}

function richText(text: string): any[] {
  const out: any[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (content: string, url?: string) => {
    for (let i = 0; i < content.length; i += 2000) {
      out.push({ type: 'text', text: { content: content.slice(i, i + 2000), ...(url ? { link: { url } } : {}) } });
    }
  };
  while ((m = re.exec(text))) {
    if (m.index > last) push(text.slice(last, m.index));
    push(m[1], m[2]);
    last = m.index + m[0].length;
  }
  if (last < text.length) push(text.slice(last));
  return out.slice(0, 100);
}

/** Minimal Markdown → Notion blocks (headings, lists, to-dos, quotes, code, dividers). */
export function markdownToBlocks(markdown: string): any[] {
  const blocks: any[] = [];
  const lines = markdown.replace(/\r/g, '').split('\n');
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'paragraph', paragraph: { rich_text: richText(para.join('\n')) } });
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      blocks.push({ type: 'code', code: { rich_text: richText(code.join('\n')), language: fence[1] || 'plain text' } });
      i++;
      continue;
    }
    let m: RegExpMatchArray | null;
    if (!line.trim()) flush();
    else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flush();
      const type = `heading_${m[1].length}`;
      blocks.push({ type, [type]: { rich_text: richText(m[2]) } });
    } else if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))) {
      flush();
      blocks.push({ type: 'to_do', to_do: { rich_text: richText(m[2]), checked: m[1].toLowerCase() === 'x' } });
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flush();
      blocks.push({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(m[1]) } });
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flush();
      blocks.push({ type: 'numbered_list_item', numbered_list_item: { rich_text: richText(m[1]) } });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flush();
      blocks.push({ type: 'quote', quote: { rich_text: richText(m[1]) } });
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: 'divider', divider: {} });
    } else para.push(line);
    i++;
  }
  flush();
  return blocks;
}

function plain(rt: any[] | undefined): string {
  return (rt ?? []).map(t => t.plain_text ?? t.text?.content ?? '').join('');
}

export function propertyToText(p: any): string {
  if (!p) return '';
  switch (p.type) {
    case 'title':
      return plain(p.title);
    case 'rich_text':
      return plain(p.rich_text);
    case 'select':
      return p.select?.name ?? '';
    case 'status':
      return p.status?.name ?? '';
    case 'multi_select':
      return (p.multi_select ?? []).map((o: any) => o.name).join(', ');
    case 'date':
      return p.date ? [p.date.start, p.date.end].filter(Boolean).join(' → ') : '';
    case 'number':
      return p.number == null ? '' : String(p.number);
    case 'checkbox':
      return p.checkbox ? 'yes' : 'no';
    case 'url':
      return p.url ?? '';
    case 'email':
      return p.email ?? '';
    case 'phone_number':
      return p.phone_number ?? '';
    case 'people':
      return (p.people ?? []).map((u: any) => u.name ?? u.id).join(', ');
    case 'relation':
      return (p.relation ?? []).map((r: any) => r.id).join(', ');
    case 'formula':
      return String(p.formula?.[p.formula?.type] ?? '');
    case 'created_time':
      return p.created_time ?? '';
    case 'last_edited_time':
      return p.last_edited_time ?? '';
    default:
      return '';
  }
}

export function blockToText(b: any): string {
  const t = b.type;
  const data = b[t] ?? {};
  const text = plain(data.rich_text);
  switch (t) {
    case 'heading_1':
      return `# ${text}`;
    case 'heading_2':
      return `## ${text}`;
    case 'heading_3':
      return `### ${text}`;
    case 'bulleted_list_item':
      return `- ${text}`;
    case 'numbered_list_item':
      return `1. ${text}`;
    case 'to_do':
      return `- [${data.checked ? 'x' : ' '}] ${text}`;
    case 'quote':
      return `> ${text}`;
    case 'code':
      return '```\n' + text + '\n```';
    case 'divider':
      return '---';
    case 'child_page':
      return `[page] ${data.title} (${b.id})`;
    case 'child_database':
      return `[database] ${data.title} (${b.id})`;
    case 'bookmark':
    case 'embed':
    case 'link_preview':
      return data.url ?? '';
    case 'image':
    case 'file':
    case 'pdf':
      return `[${t}] ${plain(data.caption)} ${data.external?.url ?? ''}`.trim();
    default:
      return text;
  }
}

/** Map simple {name: value} pairs onto a database's property types. */
export function buildProperties(schema: PropertySchema[], values: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const prop = schema.find(p => p.name.toLowerCase() === key.toLowerCase());
    if (!prop) throw new Error(`No property "${key}" (have: ${schema.map(p => p.name).join(', ')})`);
    const str = Array.isArray(value) ? value.map(String) : String(value);
    switch (prop.type) {
      case 'title':
        out[prop.name] = { title: richText(String(value)) };
        break;
      case 'rich_text':
        out[prop.name] = { rich_text: richText(String(value)) };
        break;
      case 'select':
        out[prop.name] = { select: { name: String(value) } };
        break;
      case 'status':
        out[prop.name] = { status: { name: String(value) } };
        break;
      case 'multi_select':
        out[prop.name] = {
          multi_select: (Array.isArray(str) ? str : String(value).split(',')).map(s => ({ name: s.trim() })).filter(o => o.name),
        };
        break;
      case 'date': {
        const [start, end] = String(value).split(/\s*(?:→|\.\.|\/)\s*/);
        out[prop.name] = { date: { start, ...(end ? { end } : {}) } };
        break;
      }
      case 'number':
        out[prop.name] = { number: Number(value) };
        break;
      case 'checkbox':
        out[prop.name] = { checkbox: value === true || /^(true|yes|1|x)$/i.test(String(value)) };
        break;
      case 'url':
        out[prop.name] = { url: String(value) };
        break;
      case 'email':
        out[prop.name] = { email: String(value) };
        break;
      case 'phone_number':
        out[prop.name] = { phone_number: String(value) };
        break;
      default:
        throw new Error(`Property "${prop.name}" has type ${prop.type}, which can't be set from text`);
    }
  }
  return out;
}

export class NotionClient {
  constructor(
    private readonly cfg: { token: string; hubDatabaseId?: string; version: string },
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get hubDatabaseId() {
    return this.cfg.hubDatabaseId;
  }

  private async api(method: string, pathname: string, body?: unknown): Promise<any> {
    const resp = await this.fetchImpl(`${API}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        'Notion-Version': this.cfg.version,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`Notion ${resp.status}: ${json.message ?? 'request failed'}`);
    return json;
  }

  async search(query: string, kind?: 'page' | 'database', max = 15) {
    const json = await this.api('POST', '/search', {
      query,
      page_size: Math.min(max, 50),
      ...(kind ? { filter: { property: 'object', value: kind } } : {}),
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
    });
    return (json.results ?? []).map((r: any) => ({
      id: r.id,
      object: r.object,
      title:
        r.object === 'database'
          ? plain(r.title)
          : propertyToText(Object.values(r.properties ?? {}).find((p: any) => p.type === 'title')),
      url: r.url,
      lastEdited: r.last_edited_time,
    }));
  }

  async schema(databaseId: string): Promise<{ title: string; properties: PropertySchema[] }> {
    const db = await this.api('GET', `/databases/${databaseId}`);
    const properties: PropertySchema[] = Object.entries(db.properties ?? {}).map(([name, p]: [string, any]) => ({
      id: p.id,
      name,
      type: p.type,
      options: (p[p.type]?.options ?? []).map((o: any) => o.name),
    }));
    return { title: plain(db.title), properties };
  }

  private async childrenText(blockId: string, depth: number, budget: { lines: number }): Promise<string[]> {
    const lines: string[] = [];
    let cursor: string | undefined;
    do {
      const json = await this.api('GET', `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`);
      for (const b of json.results ?? []) {
        if (budget.lines-- <= 0) return lines;
        const text = blockToText(b);
        if (text) lines.push(`${'  '.repeat(depth)}${text}`);
        if (b.has_children && depth < 2 && !['child_page', 'child_database'].includes(b.type)) {
          lines.push(...(await this.childrenText(b.id, depth + 1, budget)));
        }
      }
      cursor = json.has_more ? json.next_cursor : undefined;
    } while (cursor && budget.lines > 0);
    return lines;
  }

  async readPage(pageId: string): Promise<string> {
    const page = await this.api('GET', `/pages/${pageId}`);
    const props = Object.entries(page.properties ?? {})
      .map(([name, p]) => `${name}: ${propertyToText(p)}`)
      .filter(l => !l.endsWith(': '));
    const body = await this.childrenText(pageId, 0, { lines: 600 });
    return [`URL: ${page.url}`, ...props, '', ...body].join('\n');
  }

  async queryDatabase(databaseId: string, filter?: unknown, sorts?: unknown, max = 25) {
    const json = await this.api('POST', `/databases/${databaseId}/query`, {
      page_size: Math.min(max, 100),
      ...(filter ? { filter } : {}),
      ...(sorts ? { sorts } : {}),
    });
    return (json.results ?? []).map((r: any) => ({
      id: r.id,
      url: r.url,
      properties: Object.fromEntries(Object.entries(r.properties ?? {}).map(([k, v]) => [k, propertyToText(v)])),
    }));
  }

  async createPage(opts: { databaseId?: string; parentPageId?: string; title: string; properties?: Record<string, unknown>; markdown?: string }) {
    let properties: Record<string, any>;
    let parent: any;
    if (opts.databaseId) {
      const { properties: schema } = await this.schema(opts.databaseId);
      const titleProp = schema.find(p => p.type === 'title');
      if (!titleProp) throw new Error('Database has no title property');
      properties = buildProperties(schema, { ...(opts.properties ?? {}), [titleProp.name]: opts.title });
      parent = { database_id: opts.databaseId };
    } else if (opts.parentPageId) {
      properties = { title: { title: richText(opts.title) } };
      parent = { page_id: opts.parentPageId };
    } else {
      throw new Error('Give a databaseId or parentPageId');
    }
    const children = opts.markdown ? markdownToBlocks(opts.markdown).slice(0, 100) : undefined;
    const page = await this.api('POST', '/pages', { parent, properties, ...(children?.length ? { children } : {}) });
    return { id: page.id as string, url: page.url as string };
  }

  async updatePage(pageId: string, properties: Record<string, unknown>, archived?: boolean) {
    let mapped: Record<string, any> = {};
    if (Object.keys(properties).length) {
      const page = await this.api('GET', `/pages/${pageId}`);
      const parentDb = page.parent?.database_id;
      if (!parentDb) throw new Error('Only pages inside a database have editable properties');
      const { properties: schema } = await this.schema(parentDb);
      mapped = buildProperties(schema, properties);
    }
    const page = await this.api('PATCH', `/pages/${pageId}`, {
      ...(Object.keys(mapped).length ? { properties: mapped } : {}),
      ...(archived !== undefined ? { archived } : {}),
    });
    return { id: page.id as string, url: page.url as string };
  }

  async appendMarkdown(pageId: string, markdown: string) {
    const blocks = markdownToBlocks(markdown);
    for (let i = 0; i < blocks.length; i += 100) {
      await this.api('PATCH', `/blocks/${pageId}/children`, { children: blocks.slice(i, i + 100) });
    }
    return blocks.length;
  }

  async createDatabase(parentPageId: string, title: string, properties: Record<string, string>) {
    const props: Record<string, any> = {};
    let hasTitle = false;
    for (const [name, type] of Object.entries(properties)) {
      const [t, ...opts] = type.split(':');
      if (t === 'title') hasTitle = true;
      props[name] =
        t === 'select' || t === 'multi_select'
          ? { [t]: { options: opts.join(':').split(',').filter(Boolean).map(n => ({ name: n.trim() })) } }
          : { [t]: {} };
    }
    if (!hasTitle) props.Name = { title: {} };
    const db = await this.api('POST', '/databases', {
      parent: { type: 'page_id', page_id: parentPageId },
      title: richText(title),
      properties: props,
    });
    return { id: db.id as string, url: db.url as string };
  }

  /** File a capture into The Hub, mapping onto whatever properties it has. */
  async captureToHub(opts: { title: string; content: string; project?: string; tags?: string[]; kind?: string; url?: string }) {
    if (!this.cfg.hubDatabaseId) throw new Error('NOTION_HUB_DATABASE_ID is not set');
    const { properties: schema } = await this.schema(this.cfg.hubDatabaseId);
    const find = (names: string[], types: string[]) =>
      schema.find(p => names.includes(p.name.toLowerCase()) && types.includes(p.type));
    const values: Record<string, unknown> = {};
    const extra: string[] = [];
    const tagsProp = find(['tags', 'tag', 'labels'], ['multi_select', 'select']);
    if (opts.tags?.length) {
      if (tagsProp) values[tagsProp.name] = tagsProp.type === 'select' ? opts.tags[0] : opts.tags;
      else extra.push(`Tags: ${opts.tags.join(', ')}`);
    }
    const projectProp = find(['project', 'projects', 'area'], ['select', 'multi_select', 'rich_text']);
    if (opts.project) {
      if (projectProp) values[projectProp.name] = projectProp.type === 'multi_select' ? [opts.project] : opts.project;
      else extra.push(`Project: ${opts.project}`);
    }
    const kindProp = find(['type', 'kind'], ['select', 'multi_select']);
    if (opts.kind && kindProp) values[kindProp.name] = kindProp.type === 'multi_select' ? [opts.kind] : opts.kind;
    const urlProp = find(['url', 'link', 'source'], ['url']);
    if (opts.url) {
      if (urlProp) values[urlProp.name] = opts.url;
      else extra.push(`Source: ${opts.url}`);
    }
    const statusProp = find(['status', 'stage'], ['status', 'select']);
    const inboxOption = statusProp?.options?.find(o => o.toLowerCase() === 'inbox');
    if (statusProp && (statusProp.type === 'select' || inboxOption)) values[statusProp.name] = inboxOption ?? 'Inbox';
    const markdown = [opts.content, extra.length ? `\n${extra.join('\n')}` : ''].join('').trim();
    return this.createPage({ databaseId: this.cfg.hubDatabaseId, title: opts.title, properties: values, markdown });
  }
}
