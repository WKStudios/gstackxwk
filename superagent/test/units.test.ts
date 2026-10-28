import { describe, expect, test } from 'bun:test';
import { chunkText, markdownToWhatsApp, templateSafe } from '../src/format';
import { parseQuietHours, loadConfig, ConfigError } from '../src/config';
import { inQuietHours, parseLocal } from '../src/clock';
import { nextRunFor, previewRuns, validateSchedule } from '../src/schedule';
import { isPublicUrl } from '../src/net';
import { splitArgs } from '../src/integrations/browser';
import { buildRawEmail, htmlToText } from '../src/integrations/google';
import { findConflicts } from '../src/tools/google';
import { buildProperties, markdownToBlocks } from '../src/integrations/notion';
import { callTwiml, twilioSignature } from '../src/integrations/twilio';
import { parseSkill } from '../src/skills';
import { pageChanges } from '../src/scheduler';
import { notionId } from '../src/tools/notion';
import { supportsSystemMessages } from '../src/agent/prompt';
import { summarizeUsage } from '../src/agent/pricing';
import { repairTail } from '../src/agent/runner';

describe('WhatsApp formatting', () => {
  test('converts Markdown emphasis, headings, bullets and links', () => {
    const out = markdownToWhatsApp('## Today\n- **Jai** wants _sign-off_\n- see [the deck](https://x.co/d)\n~~old~~\n* starred *already bold*');
    expect(out).toBe('*Today*\n• *Jai* wants _sign-off_\n• see the deck (https://x.co/d)\n~old~\n• starred *already bold*');
  });

  test('leaves code fences alone and turns tables into monospace', () => {
    const out = markdownToWhatsApp('```js\nconst a = **b**;\n```\n| A | B |\n|---|---|\n| 1 | 2 |');
    expect(out).toContain('```\nconst a = **b**;\n```');
    expect(out).toContain('```\n| A | B |\n| 1 | 2 |\n```');
  });

  test('bare URLs are not rewritten', () => {
    expect(markdownToWhatsApp('[https://a.com](https://a.com)')).toBe('https://a.com');
  });

  test('chunks long text on paragraph boundaries', () => {
    const para = 'x'.repeat(2000);
    const chunks = chunkText(`${para}\n\n${para}\n\n${para}`, 4500);
    expect(chunks.length).toBe(2);
    expect(chunks.every(c => c.length <= 4500)).toBe(true);
    expect(chunks.join('').replace(/\s/g, '').length).toBe(6000);
  });

  test('template parameters are flattened', () => {
    expect(templateSafe('a\nb\t c     d')).toBe('a b c d');
    expect(templateSafe('y'.repeat(2000)).length).toBe(900);
  });
});

describe('config', () => {
  test('quiet hours parse and wrap midnight', () => {
    const q = parseQuietHours('22:00-07:00')!;
    expect(q).toEqual({ start: 1320, end: 420 });
    expect(inQuietHours(new Date('2026-10-28T23:30:00Z'), 'UTC', q)).toBe(true);
    expect(inQuietHours(new Date('2026-10-28T06:59:00Z'), 'UTC', q)).toBe(true);
    expect(inQuietHours(new Date('2026-10-28T07:00:00Z'), 'UTC', q)).toBe(false);
    expect(inQuietHours(new Date('2026-10-28T12:00:00Z'), 'UTC', q)).toBe(false);
  });

  test('WhatsApp requires an owner allowlist', () => {
    expect(() =>
      loadConfig({ WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'v', OWNER_TIMEZONE: 'UTC' }),
    ).toThrow(ConfigError);
  });

  test('phones are normalized and members exclude owners', () => {
    const c = loadConfig({ OWNER_PHONES: '+1 (555) 000-1111', MEMBER_PHONES: '15550001111, +44 7700 900123', OWNER_TIMEZONE: 'UTC' });
    expect(c.owners).toEqual(['15550001111']);
    expect(c.members).toEqual(['447700900123']);
    expect(c.model).toBe('claude-opus-5-5');
  });
});

describe('time and schedules', () => {
  const from = new Date('2026-10-28T12:00:00Z');

  test('local times respect the timezone', () => {
    expect(parseLocal('2026-10-30T09:00', 'America/New_York').toISOString()).toBe('2026-10-30T13:00:00.000Z');
    expect(parseLocal('2026-07-01T10:00:00+02:00', 'Europe/London').toISOString()).toBe('2026-07-01T08:00:00.000Z');
  });

  test('cron, one-off and interval schedules', () => {
    expect(nextRunFor('0 18 * * 5', 'Europe/London', from)!.toISOString()).toBe('2026-10-30T18:00:00.000Z');
    expect(nextRunFor('2026-10-30T09:00', 'America/New_York', from)!.toISOString()).toBe('2026-10-30T13:00:00.000Z');
    expect(nextRunFor('2025-01-01T09:00', 'UTC', from)).toBeNull();
    expect(nextRunFor('every:30', 'UTC', from)!.toISOString()).toBe('2026-10-28T12:30:00.000Z');
  });

  test('rejects schedules that never run or run every minute', () => {
    expect(() => validateSchedule('2020-01-01T00:00', 'UTC', from)).toThrow();
    expect(() => validateSchedule('* * * * *', 'UTC', from)).toThrow();
    expect(() => validateSchedule('nonsense', 'UTC', from)).toThrow();
    expect(previewRuns('30 7 * * 1-5', 'Europe/London', from, 2)).toContain('Thu, 29 Oct 2026, 07:30');
  });
});

describe('safety helpers', () => {
  test('only public URLs pass', () => {
    for (const ok of ['https://example.com', 'http://93.184.216.34/x']) expect(isPublicUrl(ok)).toBe(true);
    for (const bad of ['http://localhost:3000', 'http://127.0.0.1', 'http://169.254.169.254/latest', 'http://10.0.0.5', 'http://192.168.1.1', 'file:///etc/passwd', 'http://[::1]/', 'http://metadata.google.internal']) {
      expect(isPublicUrl(bad)).toBe(false);
    }
  });

  test('browser commands split like a shell', () => {
    expect(splitArgs('fill @e4 "hello world"')).toEqual(['fill', '@e4', 'hello world']);
    expect(splitArgs(`js 'document.title'`)).toEqual(['js', 'document.title']);
    expect(splitArgs('fill @e1 ""')).toEqual(['fill', '@e1', '']);
  });

  test('history repair appends results for dangling tool calls', () => {
    const repaired = repairTail([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] as any },
    ]);
    expect(repaired).toHaveLength(1);
    expect((repaired[0].content as any[])[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: true });
    expect(repairTail([{ role: 'user', content: 'hi' }, { role: 'system', content: 'ctx' }])[0].role).toBe('assistant');
    expect(repairTail([{ role: 'assistant', content: 'done' }])).toEqual([]);
  });

  test('system messages only on models that accept them', () => {
    expect(supportsSystemMessages('claude-opus-5-5')).toBe(true);
    expect(supportsSystemMessages('claude-sonnet-5')).toBe(false);
  });

  test('usage cost includes cache and searches; compaction usage comes from iterations', () => {
    const u = summarizeUsage('claude-opus-5-5', {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_input_tokens: 1_000_000,
      server_tool_use: { web_search_requests: 3 },
    });
    expect(u.costUsd).toBeCloseTo(4 + 2 + 0.2 + 0.03, 5);
    expect(summarizeUsage('claude-opus-5-5', { input_tokens: 0, output_tokens: 0, iterations: [{ input_tokens: 500, output_tokens: 50 }] }).inputTokens).toBe(500);
  });
});

describe('integrations (pure parts)', () => {
  test('raw email is RFC 2822 with UTF-8 subject and threading headers', () => {
    const raw = buildRawEmail({ to: 'jai@x.com', subject: 'Café plans', body: 'Hi Jai', inReplyTo: '<a@b>', references: '<a@b>' });
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    expect(decoded).toContain('To: jai@x.com');
    expect(decoded).toContain('Subject: =?UTF-8?B?');
    expect(decoded).toContain('In-Reply-To: <a@b>');
    const body = decoded.split('\r\n\r\n')[1];
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString()).toBe('Hi Jai');
  });

  test('HTML email bodies become readable text', () => {
    expect(htmlToText('<style>x{}</style><p>Hello&nbsp;<b>there</b></p><ul><li>one</li><li>two</li></ul>')).toBe('Hello there\n• one\n• two');
  });

  test('calendar conflicts across calendars and timezone traps', () => {
    const ev = (id: string, start: string, end: string, extra: object = {}) =>
      ({ calendarId: 'c', calendarName: 'Work', id, summary: id, start, end, allDay: false, organizerSelf: true, attendees: [], transparent: false, ...extra }) as any;
    const { overlaps, tzTraps } = findConflicts(
      [
        ev('a', '2026-10-28T10:00:00Z', '2026-10-28T11:00:00Z'),
        ev('b', '2026-10-28T10:30:00Z', '2026-10-28T11:30:00Z', { timeZone: 'America/New_York' }),
        ev('c', '2026-10-28T11:30:00Z', '2026-10-28T12:00:00Z'),
        ev('d', '2026-10-28T10:15:00Z', '2026-10-28T10:45:00Z', { selfResponse: 'declined' }),
        ev('e', '2026-10-28T10:00:00Z', '2026-10-28T11:00:00Z', { transparent: true }),
      ],
      'Europe/London',
    );
    expect(overlaps.map(([x, y]) => `${x.id}-${y.id}`)).toEqual(['a-b']);
    expect(tzTraps.map(e => e.id)).toEqual(['b']);
  });

  test('Markdown becomes Notion blocks', () => {
    const blocks = markdownToBlocks('# Title\nPara line\n- [ ] todo\n- bullet\n1. first\n> quote\n---\n```ts\ncode\n```');
    expect(blocks.map(b => b.type)).toEqual(['heading_1', 'paragraph', 'to_do', 'bulleted_list_item', 'numbered_list_item', 'quote', 'divider', 'code']);
    expect(markdownToBlocks('see [docs](https://d.co)')[0].paragraph.rich_text[1].text.link.url).toBe('https://d.co');
  });

  test('simple values map onto Notion property types', () => {
    const schema = [
      { id: '1', name: 'Name', type: 'title' },
      { id: '2', name: 'Tags', type: 'multi_select' },
      { id: '3', name: 'Status', type: 'status' },
      { id: '4', name: 'Due', type: 'date' },
      { id: '5', name: 'Done', type: 'checkbox' },
    ];
    const props = buildProperties(schema, { name: 'X', tags: 'a, b', Status: 'Inbox', due: '2026-11-01', done: 'yes' });
    expect(props.Tags.multi_select).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(props.Status).toEqual({ status: { name: 'Inbox' } });
    expect(props.Due).toEqual({ date: { start: '2026-11-01' } });
    expect(props.Done).toEqual({ checkbox: true });
    expect(() => buildProperties(schema, { Nope: 1 })).toThrow('No property');
  });

  test('Notion ids are pulled out of URLs', () => {
    expect(notionId('https://www.notion.so/team/My-Page-0123456789abcdef0123456789abcdef?pvs=4')).toBe('0123456789abcdef0123456789abcdef');
    expect(notionId('01234567-89ab-cdef-0123-456789abcdef')).toBe('0123456789abcdef0123456789abcdef');
  });

  test('Twilio script escapes text and signs requests', () => {
    const xml = callTwiml({ message: 'Hi <Sam> & co', question: 'When?', gatherUrl: 'https://a/b?x=1&y=2' });
    expect(xml).toContain('Hi &lt;Sam&gt; &amp; co');
    expect(xml).toContain('action="https://a/b?x=1&amp;y=2"');
    expect(twilioSignature('token', 'https://a.com/x', { B: '2', A: '1' })).toBe(twilioSignature('token', 'https://a.com/x', { A: '1', B: '2' }));
  });

  test('skills parse frontmatter', () => {
    const s = parseSkill('---\nname: brief\ndescription: Morning brief\n---\n\n# Steps\n1. x', 'file', true);
    expect(s).toMatchObject({ name: 'brief', description: 'Morning brief', builtin: true });
    expect(s.body.startsWith('# Steps')).toBe(true);
  });

  test('page diffs show what was added and removed', () => {
    const { removed, added } = pageChanges('Price: £250\nIn stock\n', 'Price: £199\nIn stock\n');
    expect(removed).toBe('Price: £250');
    expect(added).toBe('Price: £199');
  });
});
