import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { GoogleClient } from '../src/integrations/google';
import { NotionClient } from '../src/integrations/notion';
import { ToolError, type ToolContext, type ToolDef } from '../src/tools/types';
import { saveFile } from '../src/tools/files';
import { FakeClaude, makeApp, text } from './helpers';

function setup(env: Record<string, string> = {}, claude?: FakeClaude) {
  const made = makeApp({ env, claude });
  const ctx: ToolContext = {
    conversationId: 'owner',
    role: 'owner',
    runKind: 'chat',
    replyTarget: { channel: 'whatsapp', to: '15550001111' },
    signal: new AbortController().signal,
    services: made.s,
    sentMessages: [],
  };
  const tool = (name: string): ToolDef => {
    const t = made.s.runner.toolsFor('owner').find(x => x.name === name);
    if (!t) throw new Error(`tool ${name} not loaded`);
    return t;
  };
  const call = async (name: string, input: unknown) => {
    const t = tool(name);
    const parsed = t.input.parse(input);
    return t.run(parsed, ctx);
  };
  return { ...made, ctx, tool, call };
}

describe('browser tool', () => {
  function withFakeBrowser(t: ReturnType<typeof setup>) {
    const calls: [string, string[]][] = [];
    t.s.browser = {
      command: async (cmd: string, args: string[]) => {
        calls.push([cmd, args]);
        if (cmd === 'text') return 'Welcome back ada (password hunter2 is weak)';
        if (cmd === 'screenshot') {
          fs.writeFileSync(args[0], Buffer.from([0x89, 0x50, 0x4e, 0x47]));
          return `Screenshot saved: ${args[0]}`;
        }
        return 'ok';
      },
    } as any;
    return calls;
  }

  test('vault secrets are substituted at run time and redacted from output', async () => {
    const t = setup();
    const calls = withFakeBrowser(t);
    t.s.store.set('vault:site-pass', 'hunter2');
    const out = (await t.call('browser', {
      commands: ['goto example.com', 'fill @e2 "{{secret:site-pass}}"', 'text', 'screenshot'],
      commits: false,
    })) as any[];
    expect(calls[0]).toEqual(['goto', ['https://example.com']]);
    expect(calls[1]).toEqual(['fill', ['@e2', 'hunter2']]);
    expect(calls[3][1][0].startsWith(path.join(t.s.store.filesDir, 'shots'))).toBe(true);
    expect(out[0].text).toContain('password [secret:site-pass] is weak');
    expect(out[0].text).toContain('$ fill @e2 "[secret:site-pass]"');
    expect(out[0].text).not.toContain('hunter2');
    expect(out[1]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
  });

  test('blocked commands, private URLs and missing secrets are refused; commits need approval', async () => {
    const t = setup();
    withFakeBrowser(t);
    await expect(t.call('browser', { commands: ['eval /etc/passwd'], commits: false })).rejects.toThrow(ToolError);
    await expect(t.call('browser', { commands: ['goto http://169.254.169.254/latest/meta-data'], commits: false })).rejects.toThrow('only public');
    await expect(t.call('browser', { commands: ['fill @e1 {{secret:nope}}'], commits: false })).rejects.toThrow('No vault secret "nope"');
    const browser = t.tool('browser');
    expect(await browser.approval!({ commands: ['click @e9'], commits: false }, t.ctx)).toBeNull();
    const summary = await browser.approval!({ commands: ['fill @e1 {{secret:pw}}', 'click @e9'], commits: true, purpose: 'Submit the visa form' }, t.ctx);
    expect(summary).toContain('Submit the visa form');
    expect(summary).toContain('[secret:pw]');
    expect(() => browser.approval!({ commands: ['click @e9'], commits: true }, { ...t.ctx, runKind: 'subagent' })).toThrow(ToolError);
  });
});

describe('files and scheduling tools', () => {
  test('send_file only sends from the files folder', async () => {
    const t = setup();
    t.s.store.touchWindow('whatsapp:15550001111');
    await expect(t.call('send_file', { path: '../../../etc/passwd' })).rejects.toThrow(ToolError);
    const file = saveFile(t.s.store.filesDir, 'out', 'report.csv', 'a,b\n1,2');
    expect(await t.call('send_file', { path: 'out/report.csv', caption: 'Numbers' })).toBe('File sent.');
    expect(t.wa.sent[0]).toMatchObject({ kind: 'media', media: { kind: 'document', mime: 'text/csv', path: file, caption: 'Numbers' } });
  });

  test('make_pdf renders a real PDF', async () => {
    const t = setup();
    try {
      const out = (await t.call('make_pdf', { filename: 'brief', title: 'Brief', html: '<h1>Acme</h1><p>Series B.</p>' })) as string;
      const rel = out.match(/Saved (out\/brief\.pdf)/)![1];
      expect(fs.readFileSync(path.join(t.s.store.filesDir, rel)).subarray(0, 5).toString()).toBe('%PDF-');
    } catch (err) {
      if (/Executable doesn't exist/.test(String(err))) {
        console.warn('skipping make_pdf: no Chromium for this Playwright version (set CHROMIUM_PATH)');
        return;
      }
      throw err;
    }
  }, 60_000);

  test('schedule_task validates and previews', async () => {
    const t = setup();
    const out = (await t.call('schedule_task', { name: 'Weekly review', schedule: '0 18 * * 5', prompt: 'Write the review' })) as string;
    expect(out).toMatch(/Scheduled "Weekly review" \[job_[0-9a-f]+\]\. Runs: Fri, .* 18:00 \(Europe\/London\)/);
    await expect(t.call('schedule_task', { name: 'weekly review', schedule: '0 9 * * *', prompt: 'x' })).rejects.toThrow('already exists');
    await expect(t.call('schedule_task', { name: 'x', schedule: 'every friday', prompt: 'x' })).rejects.toThrow("Couldn't read schedule");
    expect(await t.call('update_task', { ref: 'Weekly review', status: 'paused' })).toBe('Updated "Weekly review": paused.');

    const before = Date.now();
    const reminder = (await t.call('schedule_task', { name: 'Water', schedule: 'in:2', prompt: 'Remind them to drink water' })) as string;
    const job = t.s.store.findJob('owner', 'Water')!;
    expect(job.schedule).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    const due = new Date(job.next_run_at!).getTime();
    expect(due - before).toBeGreaterThanOrEqual(119_000);
    expect(due - before).toBeLessThan(122_000);
    expect(reminder).not.toContain('then');
    await expect(t.call('schedule_task', { name: 'Now', schedule: 'in:0', prompt: 'x' })).rejects.toThrow('in:1');
    expect(await t.call('list_tasks', {})).toContain('Weekly review');
  });
});

describe('Google tools', () => {
  function google(t: ReturnType<typeof setup>, routes: Record<string, unknown>) {
    const hits: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      hits.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at', expires_in: 3600 });
      const key = Object.keys(routes).find(k => url.includes(k));
      if (!key) return Response.json({ error: { message: `no route for ${url}` } }, { status: 404 });
      return Response.json(routes[key]);
    };
    t.s.store.setJson('google:tokens', { refresh_token: 'rt' });
    t.s.google = new GoogleClient({ clientId: 'id', clientSecret: 'sec' }, t.s.store, 'https://agent.example.com/oauth/google/callback', fetchImpl);
    return hits;
  }
  const b64 = (s: string) => Buffer.from(s).toString('base64url');

  test('search flags bulk mail; sending a draft shows what will go out', async () => {
    const t = setup({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' });
    const hits = google(t, {
      '/messages?': { messages: [{ id: 'm1' }] },
      '/messages/m1?format=metadata': {
        id: 'm1',
        threadId: 't1',
        snippet: 'Can you sign off the deck?',
        labelIds: ['INBOX', 'UNREAD'],
        payload: { headers: [{ name: 'From', value: 'Jai <jai@acme.com>' }, { name: 'Subject', value: 'Q4 deck' }, { name: 'List-Unsubscribe', value: '<x>' }] },
      },
      '/drafts/d1': {
        message: {
          payload: {
            headers: [{ name: 'To', value: 'jai@acme.com' }, { name: 'Subject', value: 'Re: Q4 deck' }],
            mimeType: 'text/plain',
            body: { data: b64('Looks good — approved.') },
          },
        },
      },
    });
    const out = (await t.call('gmail_search', { query: 'in:inbox' })) as string;
    expect(out).toContain('thread=t1 msg=m1');
    expect(out).toContain('UNREAD · bulk');
    expect(hits[0]).toBe('POST https://oauth2.googleapis.com/token');
    const summary = await t.tool('gmail_send_draft').approval!({ draft_id: 'd1' }, t.ctx);
    expect(summary).toBe('📧 Send email\nTo: jai@acme.com\nSubject: Re: Q4 deck\n\nLooks good — approved.');
  });

  test("changing someone else's meeting needs approval; your own solo block doesn't", async () => {
    const t = setup({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' });
    google(t, {
      '/events/solo': { id: 'solo', summary: 'Focus', start: { dateTime: '2026-10-29T09:00:00Z' }, end: { dateTime: '2026-10-29T10:00:00Z' }, organizer: { self: true } },
      '/events/theirs': {
        id: 'theirs',
        summary: 'Board sync',
        start: { dateTime: '2026-10-29T15:00:00Z' },
        end: { dateTime: '2026-10-29T16:00:00Z' },
        organizer: { email: 'sam@acme.com' },
        attendees: [{ email: 'sam@acme.com' }, { email: 'ada@me.com', self: true }],
      },
    });
    const update = t.tool('calendar_update_event');
    expect(await update.approval!({ calendar_id: 'primary', event_id: 'solo', start: '2026-10-29T11:00' }, t.ctx)).toBeNull();
    const ask = await update.approval!({ calendar_id: 'primary', event_id: 'theirs', start: '2026-10-29T17:00' }, t.ctx);
    expect(ask).toContain('a meeting organized by sam@acme.com: "Board sync"');
    const invite = await update.approval!({ calendar_id: 'primary', event_id: 'solo', add_attendees: ['jai@acme.com'] }, t.ctx);
    expect(invite).toContain('Invite: jai@acme.com');
    expect(t.tool('calendar_create_event').approval!({ summary: 'Gym', start: '2026-10-29T07:00', end: '2026-10-29T08:00' }, t.ctx)).toBeNull();
  });

  test('without a connection the tools explain how to connect', async () => {
    const t = setup({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' });
    await expect(t.call('gmail_search', { query: 'x' })).rejects.toThrow('/connect google');
  });
});

describe('Notion Hub capture', () => {
  test('maps onto whatever properties The Hub has', async () => {
    const t = setup({ NOTION_TOKEN: 'secret_x', NOTION_HUB_DATABASE_ID: 'hub123' });
    let created: any;
    t.s.notion = new NotionClient({ token: 'secret_x', hubDatabaseId: 'hub123', version: '2022-06-28' }, async (url: string, init?: RequestInit) => {
      if (url.endsWith('/databases/hub123')) {
        return Response.json({
          title: [{ plain_text: 'The Hub' }],
          properties: {
            Name: { id: 'title', type: 'title', title: {} },
            Tags: { id: 't', type: 'multi_select', multi_select: { options: [] } },
            Project: { id: 'p', type: 'select', select: { options: [] } },
            Status: { id: 's', type: 'status', status: { options: [{ name: 'Inbox' }, { name: 'Filed' }] } },
            Link: { id: 'l', type: 'url', url: {} },
          },
        });
      }
      if (url.endsWith('/pages')) {
        created = JSON.parse(String(init!.body));
        return Response.json({ id: 'page1', url: 'https://notion.so/page1' });
      }
      return Response.json({ message: 'nope' }, { status: 404 });
    });
    const out = await t.call('capture_to_hub', {
      title: 'Pricing hook',
      content: 'Charge per seat, not per usage',
      project: 'Atlas',
      tags: ['pricing', 'idea'],
      url: 'https://x.com/post/1',
    });
    expect(out).toBe('Saved to The Hub: https://notion.so/page1');
    expect(created.parent).toEqual({ database_id: 'hub123' });
    expect(created.properties.Name.title[0].text.content).toBe('Pricing hook');
    expect(created.properties.Tags).toEqual({ multi_select: [{ name: 'pricing' }, { name: 'idea' }] });
    expect(created.properties.Project).toEqual({ select: { name: 'Atlas' } });
    expect(created.properties.Status).toEqual({ status: { name: 'Inbox' } });
    expect(created.properties.Link).toEqual({ url: 'https://x.com/post/1' });
    expect(created.children[0].paragraph.rich_text[0].text.content).toBe('Charge per seat, not per usage');
  });
});

describe('code sandbox', () => {
  test('runs in the cloud sandbox, reuses the container and downloads outputs', async () => {
    const claude = new FakeClaude(() => ({
      content: [
        { type: 'server_tool_use', id: 'srv1', name: 'bash_code_execution', input: { command: 'python plot.py' } },
        {
          type: 'bash_code_execution_tool_result',
          tool_use_id: 'srv1',
          content: { type: 'bash_code_execution_result', stdout: '', stderr: '', return_code: 0, content: [{ type: 'bash_code_execution_output', file_id: 'file_chart' }] },
        },
        text('Made chart.png showing revenue by month.'),
      ],
      container: { id: 'cont_1' },
    }));
    const t = setup({}, claude);
    claude.files.retrieveMetadata = async (id: string) => ({ id, filename: 'chart.png' });
    claude.files.download = async () => new Response(new Uint8Array([1, 2, 3]));
    saveFile(t.s.store.filesDir, 'inbox', 'sales.csv', 'month,rev\n1,10');
    const out = (await t.call('run_code', { task: 'Plot revenue', files: ['inbox/sales.csv'] })) as string;
    expect(out).toContain('Made chart.png');
    expect(out).toMatch(/Files saved: out\/chart(-\w+)?\.png/);
    const req = claude.calls[0];
    expect(req.tools).toEqual([{ type: 'code_execution_20260521', name: 'code_execution' }]);
    expect(req.messages[0].content[1]).toEqual({ type: 'container_upload', file_id: 'file_up' });
    expect(t.s.store.get('container:owner')).toBe('cont_1');
    await t.call('run_code', { task: 'again' });
    expect(claude.calls[1].container).toBe('cont_1');
  });
});

describe('team member boundary', () => {
  test("members can't use the vault, reach the owner's files, or see Notion", async () => {
    const t = setup({ NOTION_TOKEN: 'secret_x' });
    const member: ToolContext = { ...t.ctx, conversationId: 'member:15550002222', role: 'member', replyTarget: { channel: 'whatsapp', to: '15550002222' } };
    t.s.store.set('vault:bank', 'hunter2');
    t.s.browser = { command: async () => 'ok' } as any;
    const browser = t.tool('browser');
    await expect(browser.run({ commands: ['fill @e1 {{secret:bank}}'], commits: false }, member)).rejects.toThrow('vault belongs to the owner');

    saveFile(t.s.store.filesDir, 'inbox', 'invoice.pdf', '%PDF-owner');
    t.s.store.touchWindow('whatsapp:15550002222');
    const sendFile = t.tool('send_file');
    await expect(sendFile.run({ path: 'inbox/invoice.pdf' }, member)).rejects.toThrow('No such file');
    await expect(sendFile.run({ path: '../../inbox/invoice.pdf' }, member)).rejects.toThrow(ToolError);

    const memberTools = t.s.runner.toolsFor('member').map(x => x.name);
    expect(memberTools).not.toContain('notion_search');
    expect(memberTools).not.toContain('capture_to_hub');
    expect(t.s.runner.toolsFor('owner').map(x => x.name)).toContain('notion_search');

    await t.tool('remember').run({ kind: 'preference', subject: 'tone', content: 'casual' }, member);
    expect(t.s.store.listMemories(['owner'])).toEqual([]);
    expect(t.s.store.listMemories(['member:15550002222'])[0].subject).toBe('tone');
  });
});
