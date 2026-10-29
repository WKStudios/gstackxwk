import { describe, expect, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { defineTool } from '../src/tools/types';
import { MediaProviders } from '../src/integrations/media';
import { FakeClaude, idle, inbound, makeApp, text, toolUse, until } from './helpers';

const lastUser = (params: any) => [...params.messages].reverse().find((m: any) => m.role === 'user');

describe('chat turns', () => {
  test('a plain message gets a reply and the request is shaped right', async () => {
    const { app, claude, wa, s } = makeApp();
    await app.router.handleInbound(inbound({ text: 'hello' }));
    await idle(app);

    expect(wa.texts()).toEqual(['ok']);
    const req = claude.calls[0];
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.thinking).toEqual({ type: 'adaptive' });
    expect(req.output_config).toEqual({ effort: 'medium' });
    expect(req.fallbacks).toBe('default');
    expect(req.cache_control).toEqual({ type: 'ephemeral' });
    expect(req.betas).toEqual(expect.arrayContaining(['compact-2026-09-04', 'server-side-fallback-2026-07-01', 'mid-conversation-system-clear-at-2026-08-21']));
    expect(req.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(req.system[0].text).toContain("You are Superagent, Ada's personal agent");
    expect(req.tools.find((t: any) => t.type === 'web_search_20260209')).toBeTruthy();
    expect(req.tools.find((t: any) => t.type === 'web_fetch_20260209')).toBeTruthy();
    const clientTools = req.tools.filter((t: any) => t.input_schema);
    expect(clientTools.length).toBeGreaterThan(20);
    expect(clientTools.every((t: any) => t.eager_input_streaming === true && !t.input_schema.$schema)).toBe(true);
    const tail = req.messages.slice(-2);
    expect(tail[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    expect(tail[1].role).toBe('system');
    expect(tail[1].clear_at).toBe('next_user_message');
    expect(tail[1].content).toContain('Now: ');
    expect(s.store.history('owner').map(m => m.role)).toEqual(['user', 'system', 'assistant']);
    expect(wa.reads.length).toBe(1);
  });

  test('tool calls run, results go back in one message, memory persists', async () => {
    const claude = new FakeClaude((params, i) => {
      if (i === 0) {
        return {
          content: [
            toolUse('remember', { kind: 'person', subject: 'Jai Patel', content: 'CFO at Acme' }, 't1'),
            toolUse('recall', { query: 'nobody' }, 't2'),
          ],
        };
      }
      return { content: [text('Noted — Jai is the CFO.')] };
    });
    const { app, s, wa } = makeApp({ claude });
    await app.router.handleInbound(inbound({ text: 'Jai is the CFO at Acme' }));
    await idle(app);

    const results = lastUser(claude.calls[1]).content;
    expect(results.map((r: any) => r.tool_use_id)).toEqual(['t1', 't2']);
    // Tool results clear the turn's context note, so a fresh copy follows them.
    const tail = claude.calls[1].messages.at(-1);
    expect(tail.role).toBe('system');
    expect(tail.clear_at).toBe('next_user_message');
    expect(tail.content).toContain('Now: ');
    expect(results[0].content).toContain('Saved memory');
    expect(s.store.recall(['owner'], 'Jai')[0].content).toBe('CFO at Acme');
    expect(wa.texts()).toEqual(['Noted — Jai is the CFO.']);
    // The next turn's context surfaces the memory.
    await app.router.handleInbound(inbound({ text: 'what about Jai?' }));
    await idle(app);
    expect(claude.calls[2].messages.at(-1).content).toContain('Jai Patel');
  });

  test('invalid tool input and unknown tools come back as errors', async () => {
    const claude = new FakeClaude((_p, i) =>
      i === 0 ? { content: [toolUse('remember', { kind: 'not-a-kind' }, 'bad'), toolUse('no_such_tool', {}, 'nope')] } : { content: [text('fixed')] },
    );
    const { app } = makeApp({ claude });
    await app.router.handleInbound(inbound({ text: 'x' }));
    await idle(app);
    const [bad, nope] = lastUser(claude.calls[1]).content;
    expect(bad.is_error).toBe(true);
    expect(bad.content).toContain('INVALID_INPUT');
    expect(nope).toMatchObject({ is_error: true, content: 'Unknown tool "no_such_tool".' });
  });

  test('pause_turn is resent as is; refusals never run tools', async () => {
    const claude = new FakeClaude((_p, i) =>
      i === 0 ? { content: [text('Looking…')], stop_reason: 'pause_turn' } : { content: [text('Found it.')] },
    );
    const { app, wa } = makeApp({ claude });
    await app.router.handleInbound(inbound({ text: 'search' }));
    await idle(app);
    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[1].messages.at(-1).role).toBe('assistant');
    expect(wa.texts()[0]).toBe('Looking…\n\nFound it.');

    const refusing = new FakeClaude(() => ({
      content: [toolUse('remember', { kind: 'fact', subject: 'x', content: 'y' })],
      stop_reason: 'refusal',
    }));
    const r = makeApp({ claude: refusing });
    await r.app.router.handleInbound(inbound({ text: 'bad idea' }));
    await idle(r.app);
    expect(r.s.store.listMemories(['owner'])).toEqual([]);
    expect(r.wa.texts()).toEqual(["I can't help with that one."]);
  });

  test('a tool input cut off by max_tokens is never executed', async () => {
    const claude = new FakeClaude((_p, i) =>
      i === 0
        ? { content: [toolUse('remember', { kind: 'fact', subject: 'x', content: 'partial' }, 'cut')], stop_reason: 'max_tokens' }
        : { content: [text('retrying smaller')] },
    );
    const { app, s } = makeApp({ claude });
    await app.router.handleInbound(inbound({ text: 'x' }));
    await idle(app);
    expect(s.store.listMemories(['owner'])).toEqual([]);
    expect(lastUser(claude.calls[1]).content[0]).toMatchObject({ tool_use_id: 'cut', is_error: true });
  });

  test('an empty API balance gets a plain-English reply', async () => {
    const { app, wa } = makeApp({
      claude: new FakeClaude(() => {
        throw new Anthropic.BadRequestError(
          400,
          { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
          'Your credit balance is too low to access the Anthropic API.',
          new Headers(),
        );
      }),
    });
    await app.router.handleInbound(inbound({ text: 'hey' }));
    await idle(app);
    expect(wa.texts()[0]).toBe('Your Anthropic account is out of API credits. Add some at console.anthropic.com → Settings → Billing, then send your message again.');
  });

  test('errors become a friendly reply', async () => {
    const { app, wa } = makeApp({
      claude: new FakeClaude(() => {
        throw new Error('boom');
      }),
    });
    await app.router.handleInbound(inbound({ text: 'x' }));
    await idle(app);
    expect(wa.texts()[0]).toBe('Something went wrong on my side: boom');
  });
});

describe('approvals', () => {
  function withRiskyTool(app: ReturnType<typeof makeApp>['app'], ran: string[]) {
    const risky = defineTool({
      name: 'send_thing',
      description: 'Sends a thing',
      input: z.object({ what: z.string() }),
      approval: input => `Send "${input.what}"`,
      run: async input => {
        ran.push(input.what);
        return 'sent';
      },
    });
    app.services.runner.setRegistry({ all: () => [risky] });
  }

  const scripted = () =>
    new FakeClaude((p, i) => (i === 0 ? { content: [toolUse('send_thing', { what: 'invoice' }, 'r1')] } : { content: [text(JSON.stringify(lastUser(p).content[0]))] }));

  test('tapping Approve runs the tool', async () => {
    const ran: string[] = [];
    const { app, wa, s } = makeApp({ claude: scripted() });
    withRiskyTool(app, ran);
    await app.router.handleInbound(inbound({ text: 'send the invoice' }));
    await until(() => wa.sent.some(x => x.kind === 'buttons'));
    const ask = wa.sent.find(x => x.kind === 'buttons') as any;
    expect(ask.body).toContain('Send "invoice"');
    const approveId = ask.buttons[0].id;
    expect(approveId).toMatch(/^apv:apv_[0-9a-f]+:yes$/);
    await app.router.handleInbound(inbound({ type: 'button', buttonId: approveId, text: '✅ Approve' }));
    await idle(app);
    expect(ran).toEqual(['invoice']);
    expect(s.store.getApproval(approveId.split(':')[1])!.status).toBe('approved');
  });

  test('a free-text reply denies with the note passed back', async () => {
    const ran: string[] = [];
    const claude = scripted();
    const { app, wa } = makeApp({ claude });
    withRiskyTool(app, ran);
    await app.router.handleInbound(inbound({ text: 'send the invoice' }));
    await until(() => wa.sent.some(x => x.kind === 'buttons'));
    await app.router.handleInbound(inbound({ text: 'no — send it tomorrow morning instead' }));
    await idle(app);
    expect(ran).toEqual([]);
    const result = lastUser(claude.calls[1]).content[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('send it tomorrow morning instead');
    expect(claude.calls).toHaveLength(2);
  });

  test('a 👍 reaction on the request approves; silence expires', async () => {
    const ran: string[] = [];
    const { app, wa } = makeApp({ claude: scripted() });
    withRiskyTool(app, ran);
    await app.router.handleInbound(inbound({ text: 'go' }));
    await until(() => wa.sent.some(x => x.kind === 'buttons'));
    const askIndex = wa.sent.findIndex(x => x.kind === 'buttons');
    await app.router.handleInbound(inbound({ type: 'reaction', reaction: { messageId: `wamid.out${askIndex + 1}`, emoji: '👍' } }));
    await idle(app);
    expect(ran).toEqual(['invoice']);

    const timed = makeApp({ claude: scripted(), app: { approvalTimeoutMs: 30 } });
    withRiskyTool(timed.app, ran);
    await timed.app.router.handleInbound(inbound({ text: 'go' }));
    await idle(timed.app);
    expect(ran).toEqual(['invoice']);
    expect(JSON.stringify(lastUser(timed.claude.calls[1]).content[0])).toContain('No answer came back in time');
  });
});

describe('routing', () => {
  test('stop aborts the running turn and the next turn still works', async () => {
    const claude = new FakeClaude(async (_p, i) => {
      if (i === 0) await Bun.sleep(150);
      return { content: [text(i === 0 ? 'slow answer' : 'second answer')] };
    });
    const { app, wa, s } = makeApp({ claude });
    await app.router.handleInbound(inbound({ text: 'do something slow' }));
    await Bun.sleep(20);
    await app.router.handleInbound(inbound({ text: 'stop' }));
    await idle(app);
    expect(wa.texts()).toEqual(['🛑 Stopped.']);
    await app.router.handleInbound(inbound({ text: 'try again' }));
    await idle(app);
    expect(wa.texts().at(-1)).toBe('second answer');
    const roles = s.store.history('owner').map(m => m.role);
    // user, system (aborted turn), repaired assistant, then the new turn
    expect(roles).toEqual(['user', 'system', 'assistant', 'user', 'system', 'assistant']);
  });

  test('messages sent while busy are merged into the next turn', async () => {
    const claude = new FakeClaude(async (_p, i) => {
      if (i === 0) await Bun.sleep(80);
      return { content: [text(`reply ${i}`)] };
    });
    const { app } = makeApp({ claude });
    await app.router.handleInbound(inbound({ text: 'first' }));
    await Bun.sleep(10);
    await app.router.handleInbound(inbound({ text: 'second' }));
    await app.router.handleInbound(inbound({ text: 'third' }));
    await idle(app);
    expect(claude.calls).toHaveLength(2);
    expect(lastUser(claude.calls[1]).content.map((b: any) => b.text)).toEqual([
      expect.stringContaining('second'),
      expect.stringContaining('third'),
    ]);
  });

  test('bursts are debounced into one turn', async () => {
    const { app, claude } = makeApp({ env: { DEBOUNCE_MS: '40' } });
    for (const t of ['so', 'about friday', 'can we move it']) await app.router.handleInbound(inbound({ text: t }));
    await Bun.sleep(120);
    await idle(app);
    expect(claude.calls).toHaveLength(1);
    expect(lastUser(claude.calls[0]).content).toHaveLength(3);
  });

  test('strangers are ignored; members get their own thread without owner tools', async () => {
    const { app, claude, wa } = makeApp({ env: { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' } });
    await app.router.handleInbound(inbound({ from: '19998887777', text: 'hi' }));
    await idle(app);
    expect(claude.calls).toHaveLength(0);
    expect(wa.sent).toHaveLength(0);

    await app.router.handleInbound(inbound({ from: '15550002222', text: 'hi' }));
    await idle(app, 'member:15550002222');
    const tools = claude.calls[0].tools.map((t: any) => t.name);
    expect(tools).not.toContain('gmail_search');
    expect(tools).toContain('recall');
    expect(claude.calls[0].system[0].text).toContain("member of Ada's team");
    expect(wa.sent[0].to).toBe('15550002222');

    await app.router.handleInbound(inbound({ text: 'owner here' }));
    await idle(app);
    expect(claude.calls[1].tools.map((t: any) => t.name)).toContain('gmail_search');
  });

  test('the daily budget stops new turns', async () => {
    const { app, claude, wa, s } = makeApp({ env: { DAILY_BUDGET_USD: '1' } });
    s.store.recordUsage({ conversationId: 'owner', kind: 'chat', model: 'm', inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, costUsd: 1.5 });
    await app.router.handleInbound(inbound({ text: 'hi' }));
    await idle(app);
    expect(claude.calls).toHaveLength(0);
    expect(wa.texts()[0]).toContain("today's spending limit");
    await app.router.handleInbound(inbound({ text: '/budget 5' }));
    await app.router.handleInbound(inbound({ text: 'hi again' }));
    await idle(app);
    expect(claude.calls).toHaveLength(1);
  });

  test('long conversations compact between turns', async () => {
    const claude = new FakeClaude(() => ({ content: [text('ok')], usage: { input_tokens: 500 } }));
    const { app, s } = makeApp({ claude, env: { COMPACT_AT_TOKENS: '300' } });
    await app.router.handleInbound(inbound({ text: 'one' }));
    await idle(app);
    await app.router.handleInbound(inbound({ text: 'two' }));
    await idle(app);
    expect(claude.createCalls).toHaveLength(1);
    expect(claude.createCalls[0].compaction.type).toBe('summarize');
    expect(claude.createCalls[0].betas).toContain('compact-2026-09-04');
    expect(claude.createCalls[0].messages.at(-1).role).toBe('assistant');
    expect((s.store.history('owner')[0].content as any[])[0].type).toBe('compaction');
    await app.router.handleInbound(inbound({ text: 'three' }));
    await idle(app);
    expect(claude.calls.at(-1).messages[0].content[0]).toMatchObject({ type: 'compaction', signature: 'sig_abc' });
  });

  test('replies quote context, photos become image blocks', async () => {
    const { app, claude, wa, s } = makeApp();
    await app.router.handleInbound(inbound({ text: 'first' }));
    await idle(app);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    wa.media.set('img1', { data: jpeg, mime: 'image/jpeg' });
    await app.router.handleInbound(inbound({ type: 'image', media: { id: 'img1', mime: 'image/jpeg', caption: 'receipt' }, replyToId: 'wamid.out1' }));
    await idle(app);
    const content = lastUser(claude.calls[1]).content;
    expect(content[0].text).toContain('replying to your message: "ok"');
    expect(content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg' } });
    expect(content[2].text).toMatch(/Photo \(saved as inbox\/photo-\d+\.jpg\): receipt/);
    const saved = content[2].text.match(/inbox\/photo-\d+\.jpg/)[0];
    expect(fs.readFileSync(path.join(s.store.filesDir, saved))).toEqual(jpeg);
  });

  test('voice notes are transcribed and answered with a voice note', async () => {
    const { app, claude, wa, s, config } = makeApp({ env: { OPENAI_API_KEY: 'sk-test' } });
    const calls: string[] = [];
    s.media = new MediaProviders(config, async (url: string) => {
      calls.push(url);
      if (url.endsWith('/audio/transcriptions')) return Response.json({ text: 'remind me to call mum' });
      return new Response('OggS-voice');
    });
    wa.media.set('aud1', { data: Buffer.from('OggS'), mime: 'audio/ogg' });
    await app.router.handleInbound(inbound({ type: 'audio', media: { id: 'aud1', mime: 'audio/ogg; codecs=opus', voice: true } }));
    await idle(app);
    expect(lastUser(claude.calls[0]).content[0].text).toBe('🎤 Voice note (transcribed): remind me to call mum');
    expect(calls).toEqual(['https://api.openai.com/v1/audio/transcriptions', 'https://api.openai.com/v1/audio/speech']);
    expect(wa.sent[0]).toMatchObject({ kind: 'media', media: { kind: 'audio', voice: true, mime: 'audio/ogg' } });
    expect(wa.sent[1]).toMatchObject({ kind: 'text', text: 'ok' });
  });

  test('background hooks: notes join history, automated turns reply proactively', async () => {
    const { app, claude, wa, s } = makeApp();
    s.store.touchWindow('whatsapp:15550001111');
    s.hooks.appendNote('owner', 'Scheduled: Daily brief', 'Three emails need you.');
    s.hooks.enqueueTurn('owner', '<automated_update source="sub-agents">results</automated_update>');
    await idle(app);
    const history = s.store.history('owner');
    expect(history[0]).toEqual({ role: 'assistant', content: [{ type: 'text', text: '[Scheduled: Daily brief] Three emails need you.' }] });
    expect(lastUser(claude.calls[0]).content[0].text).toContain('automated_update');
    expect(wa.texts()).toEqual(['ok']);
  });
});
