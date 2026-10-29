import { describe, expect, test } from 'bun:test';
import { clock } from '../src/clock';
import { FakeClaude, fakeGoogle, idle, inbound, makeApp, text, toolUse, until } from './helpers';

function withClock<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const real = clock.now;
  clock.now = () => new Date(iso);
  return fn().finally(() => (clock.now = real));
}

const lastUser = (params: any) => [...params.messages].reverse().find((m: any) => m.role === 'user');

describe('delivery rules', () => {
  test('quiet hours hold proactive messages until the owner writes', async () => {
    const { app, s, wa } = makeApp({ env: { QUIET_HOURS: '00:00-23:59' } });
    s.store.touchWindow('whatsapp:15550001111');
    expect(await s.delivery.notify('owner', 'Overnight result')).toBe('queued');
    expect(wa.sent).toHaveLength(0);
    expect(await s.delivery.notify('owner', 'Server is down', { urgent: true })).toBe('sent');
    await app.router.handleInbound(inbound({ text: '/usage' }));
    const texts = wa.texts();
    expect(texts[0]).toBe('Server is down');
    expect(texts[1]).toStartWith('🌙 Held during quiet hours');
    expect(texts[1]).toContain('Overnight result');
  });

  test('a closed 24h window sends one template nudge and holds the text', async () => {
    const { app, s, wa } = makeApp({ env: { WHATSAPP_TEMPLATE_NAME: 'agent_update' } });
    // Template nudges need config.whatsapp; fake it on the loaded config.
    (s.config as any).whatsapp = { templateName: 'agent_update', templateLanguage: 'en' };
    await s.delivery.notify('owner', 'Your brief is ready');
    await s.delivery.notify('owner', 'Another update');
    expect(wa.sent.filter(x => x.kind === 'template')).toHaveLength(1);
    expect(wa.sent).toHaveLength(1);
    await app.router.handleInbound(inbound({ text: '/help' }));
    expect(wa.texts().slice(0, 2).map(t => t.split('\n')[1])).toEqual(['Your brief is ready', 'Another update']);
    expect(s.store.pendingOutbox('owner')).toEqual([]);
  });
});

describe('scheduler', () => {
  test('prompt jobs run, deliver, note history and schedule the next run', async () => {
    const claude = new FakeClaude(() => ({ content: [text('☀️ Brief: 2 emails need you.')] }));
    const { app, s, wa } = makeApp({ claude });
    s.store.touchWindow('whatsapp:15550001111');
    const job = s.store.createJob({
      conversation_id: 'owner',
      name: 'Daily brief',
      kind: 'prompt',
      schedule: '30 7 * * 1-5',
      timezone: 'Europe/London',
      prompt: 'Send the brief',
      mode: 'always',
      config: '{}',
      status: 'active',
      next_run_at: new Date(Date.now() - 1000).toISOString(),
    });
    await app.scheduler.tick();
    await until(() => wa.texts().length > 0);
    await idle(app);
    expect(wa.texts()).toEqual(['☀️ Brief: 2 emails need you.']);
    const after = s.store.getJob(job.id)!;
    expect(new Date(after.next_run_at!).getTime()).toBeGreaterThan(Date.now());
    expect(after.last_status).toBe('sent');
    expect(s.store.jobRuns(job.id)[0].status).toBe('sent');
    expect(claude.calls[0].system.at(-1).text).toContain('# Scheduled task: Daily brief');
    expect(claude.calls[0].messages[0].content[0].text).toBe('Send the brief');
    expect((s.store.history('owner')[0].content as any)[0].text).toStartWith('[Scheduled: Daily brief]');
  });

  test('if_noteworthy stays quiet on NO_UPDATE; if_changed only sends changes; one-offs finish', async () => {
    let answer = 'NO_UPDATE';
    const { app, s, wa } = makeApp({ claude: new FakeClaude(() => ({ content: [text(answer)] })) });
    s.store.touchWindow('whatsapp:15550001111');
    const mk = (name: string, mode: any, schedule = '0 9 * * *') =>
      s.store.createJob({ conversation_id: 'owner', name, kind: 'prompt', schedule, timezone: 'UTC', prompt: 'p', mode, config: '{}', status: 'active', next_run_at: new Date().toISOString() });
    const quiet = mk('quiet', 'if_noteworthy');
    expect((await app.scheduler.runJobNow(quiet.id)).status).toBe('silent');
    answer = 'Price is £10';
    const changed = mk('changed', 'if_changed');
    expect((await app.scheduler.runJobNow(changed.id)).status).toBe('sent');
    expect((await app.scheduler.runJobNow(changed.id)).status).toBe('silent');
    answer = 'Price is £9';
    expect((await app.scheduler.runJobNow(changed.id)).status).toBe('sent');
    expect(wa.texts()).toEqual(['Price is £10', 'Price is £9']);

    const once = mk('once', 'always', new Date(Date.now() + 3600_000).toISOString().slice(0, 16));
    s.store.updateJob(once.id, { next_run_at: new Date(Date.now() - 1000).toISOString() });
    await app.scheduler.tick();
    await until(() => s.store.getJob(once.id)!.last_status === 'sent');
    expect(s.store.getJob(once.id)!.status).toBe('done');
  });

  test('failures alert once; /pause stops everything', async () => {
    const { app, s, wa } = makeApp({
      claude: new FakeClaude(() => {
        throw new Error('Google API 401: invalid credentials');
      }),
    });
    s.store.touchWindow('whatsapp:15550001111');
    const job = s.store.createJob({ conversation_id: 'owner', name: 'Brief', kind: 'prompt', schedule: '0 9 * * *', timezone: 'UTC', prompt: 'p', mode: 'always', config: '{}', status: 'active', next_run_at: new Date().toISOString() });
    await app.scheduler.tick();
    await until(() => s.store.getJob(job.id)!.last_status === 'error');
    s.store.updateJob(job.id, { next_run_at: new Date().toISOString() });
    await app.scheduler.tick();
    await until(() => s.store.jobRuns(job.id).filter(r => r.status === 'error').length === 2);
    expect(wa.texts().filter(t => t.includes('"Brief" failed'))).toHaveLength(1);
    expect(s.store.getJob(job.id)!.last_error).toContain('invalid credentials');

    await app.router.handleInbound(inbound({ text: 'pause' }));
    s.store.updateJob(job.id, { next_run_at: new Date().toISOString() });
    await app.scheduler.tick();
    await Bun.sleep(30);
    expect(s.store.jobRuns(job.id)).toHaveLength(2);
  });

  test('page watchers take a baseline, ignore no-ops, and judge real changes', async () => {
    const pages = ['Price: £250\nIn stock', 'Price: £250\nIn stock', 'Price: £199\nIn stock'];
    const claude = new FakeClaude(() => ({ content: [text('📉 Price dropped to £199: https://shop.example/item')] }));
    const { app, s, wa } = makeApp({ claude, app: { fetchPage: async () => pages.shift()! } });
    s.store.touchWindow('whatsapp:15550001111');
    const job = s.store.createJob({
      conversation_id: 'owner',
      name: 'Price watch',
      kind: 'watch_page',
      schedule: 'every:60',
      timezone: 'UTC',
      prompt: 'price below £200',
      mode: 'if_noteworthy',
      config: JSON.stringify({ url: 'https://shop.example/item' }),
      status: 'active',
      next_run_at: new Date().toISOString(),
    });
    expect((await app.scheduler.runJobNow(job.id)).output).toContain('Baseline');
    expect((await app.scheduler.runJobNow(job.id)).output).toBe('No change.');
    expect(claude.calls).toHaveLength(0);
    expect((await app.scheduler.runJobNow(job.id)).status).toBe('sent');
    const prompt = claude.calls[0].messages[0].content[0].text;
    expect(prompt).toContain('<removed>\nPrice: £250\n</removed>');
    expect(prompt).toContain('<added>\nPrice: £199\n</added>');
    expect(claude.calls[0].tools.map((t: any) => t.name)).not.toContain('send_message');
    expect(wa.texts()).toEqual(['📉 Price dropped to £199: https://shop.example/item']);
  });

  test('Gmail watchers cover every account; a newly connected account gets its own baseline', async () => {
    const claude = new FakeClaude(() => ({ content: [text('🧾 New invoice from Acme')] }));
    const { app, s, wa } = makeApp({ claude, env: { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' } });
    s.store.touchWindow('whatsapp:15550001111');
    const inbox = (...ids: string[]) => ({
      '/messages?': { messages: ids.map(id => ({ id })) },
      ...Object.fromEntries(ids.map(id => [`/messages/${id}?`, { id, threadId: `t-${id}`, snippet: 'Invoice attached', payload: { headers: [{ name: 'Subject', value: `Invoice ${id}` }] } }])),
    });
    const accounts: Record<string, Record<string, unknown>> = { 'ada@me.com': inbox('p1'), 'ada@acme.com': inbox('w1') };
    const google = fakeGoogle(s, accounts);
    const job = s.store.createJob({
      conversation_id: 'owner',
      name: 'Invoices',
      kind: 'watch_gmail',
      schedule: 'every:15',
      timezone: 'UTC',
      prompt: 'Tell me about new invoices',
      mode: 'if_noteworthy',
      config: JSON.stringify({ query: 'subject:invoice' }),
      status: 'active',
      next_run_at: new Date().toISOString(),
      state: JSON.stringify({ seen: [], baseline: true }),
    });
    expect((await app.scheduler.runJobNow(job.id)).output).toBe('Baseline: 2 existing match(es) ignored.');
    expect((await app.scheduler.runJobNow(job.id)).output).toBe('No new mail.');

    accounts['ada@acme.com'] = inbox('w2', 'w1');
    google.connect('old@gmail.com', inbox('o1'));
    expect((await app.scheduler.runJobNow(job.id)).status).toBe('sent');
    expect(claude.calls).toHaveLength(1);
    const prompt = claude.calls[0].messages[0].content[0].text;
    expect(prompt).toContain('msg=w2 account=ada@acme.com');
    // old@gmail.com's mail from before it was connected isn't news.
    expect(prompt).not.toContain('o1');
    expect(wa.texts()).toEqual(['🧾 New invoice from Acme']);

    accounts['old@gmail.com'] = inbox('o2', 'o1');
    await app.scheduler.runJobNow(job.id);
    expect(claude.calls[1].messages[0].content[0].text).toContain('msg=o2 account=old@gmail.com');
  });

  test('mission check-ins log progress and missed deadlines fail loudly', async () => {
    let missionId = '';
    const claude = new FakeClaude((_p, i) =>
      i === 0
        ? { content: [toolUse('update_mission', { id: missionId, note: 'Emailed the airline asking for the refund', next_check_in_minutes: 60 })] }
        : { content: [text('Waiting on the airline.')] },
    );
    const { app, s, wa } = makeApp({ claude });
    s.store.touchWindow('whatsapp:15550001111');
    const m = s.store.createMission('owner', 'Get a refund for flight BA123', 240, null);
    missionId = m.id;
    await app.scheduler.tick();
    await until(() => JSON.parse(s.store.getMission(m.id)!.log).length > 0);
    const after = s.store.getMission(m.id)!;
    expect(JSON.parse(after.log)[0].note).toBe('Emailed the airline asking for the refund');
    const nextIn = new Date(after.next_check_at!).getTime() - Date.now();
    expect(nextIn).toBeGreaterThan(55 * 60_000);
    expect(nextIn).toBeLessThan(61 * 60_000);
    expect(claude.calls[0].system.at(-1).text).toContain('Goal: Get a refund for flight BA123');
    expect(wa.sent).toHaveLength(0);

    const late = s.store.createMission('owner', 'Book the venue', 60, new Date(Date.now() - 60_000).toISOString());
    await app.scheduler.tick();
    await until(() => s.store.getMission(late.id)!.status === 'failed');
    await until(() => wa.texts().length > 0);
    expect(wa.texts()[0]).toContain('Mission deadline passed: Book the venue');
  });
});

describe('commands', () => {
  test('help, pause/resume, usage, budget', async () => {
    const { app, wa, s, claude } = makeApp();
    const say = async (t: string) => {
      await app.router.handleInbound(inbound({ text: t }));
      return wa.texts().at(-1)!;
    };
    expect(await say('/help')).toContain('*Commands*');
    expect(await say('Pause')).toContain('paused');
    expect(s.store.get('automations_paused')).toBeTruthy();
    expect(await say('/resume')).toContain('resumed');
    expect(await say('/budget 20')).toBe("Today's limit is now $20.00.");
    expect(await say('/usage')).toContain('of $20.00');
    expect(await say('/nonsense')).toContain("I don't know /nonsense");
    expect(claude.calls).toHaveLength(0);
    expect(s.store.history('owner')).toEqual([]);
  });

  test('vault secrets never reach history or transcript; members are refused', async () => {
    const { app, wa, s } = makeApp();
    await app.router.handleInbound(inbound({ text: '/vault set github-password hunter2!' }));
    expect(wa.texts().at(-1)).toContain('{{secret:github-password}}');
    expect(s.store.get('vault:github-password')).toBe('hunter2!');
    await app.router.handleInbound(inbound({ text: '/vault list' }));
    expect(wa.texts().at(-1)).toBe('Vault: github-password');
    expect(JSON.stringify(s.store.recentTranscript('owner'))).not.toContain('hunter2');
    expect(s.store.history('owner')).toEqual([]);
    await app.router.handleInbound(inbound({ from: '15550002222', text: '/vault list' }));
    expect(wa.texts().at(-1)).toBe('That command is only for the owner.');
  });

  test('/new starts a fresh thread after the current turn; /starter installs automations', async () => {
    const { app, wa, s } = makeApp();
    await app.router.handleInbound(inbound({ text: 'hello' }));
    await idle(app);
    expect(s.store.history('owner').length).toBe(3);
    await app.router.handleInbound(inbound({ text: '/new' }));
    await idle(app);
    expect(s.store.history('owner')).toEqual([]);

    await app.router.handleInbound(inbound({ text: '/starter' }));
    expect(wa.texts().at(-1)).toContain('Weekly review');
    expect(wa.texts().at(-1)).toContain('/connect google');
    await app.router.handleInbound(inbound({ text: '/jobs' }));
    expect(wa.texts().at(-1)).toContain('*Weekly review* (active) — 0 18 * * 5');
    await app.router.handleInbound(inbound({ text: '/starter' }));
    expect(wa.texts().at(-1)).toContain('already set up');
  });

  test('/memory and /forget', async () => {
    const { app, wa, s } = makeApp();
    const m = s.store.remember('owner', 'preference', 'replies', 'Keep it short', [], true);
    await app.router.handleInbound(inbound({ text: '/memory' }));
    expect(wa.texts().at(-1)).toContain(`#${m.id} preference) replies: Keep it short`);
    await app.router.handleInbound(inbound({ text: `/forget ${m.id}` }));
    expect(s.store.listMemories(['owner'])).toEqual([]);
  });

  test('stop all cancels background sub-agents', async () => {
    const claude = new FakeClaude(async (p, i) => {
      if (i === 0) return { content: [toolUse('delegate', { goal: 'research', background: true, tasks: [{ title: 'A', brief: 'look into A' }] })] };
      if (p.system.at(-1)?.text?.includes('# You are a sub-agent')) {
        await Bun.sleep(200);
        return { content: [text('findings')] };
      }
      return { content: [text('Started — I’ll report back.')] };
    });
    const { app, wa } = makeApp({ claude });
    await app.router.handleInbound(inbound({ text: 'research A' }));
    await idle(app);
    expect(wa.texts().at(-1)).toBe('Started — I’ll report back.');
    await app.router.handleInbound(inbound({ text: 'stop all' }));
    expect(wa.texts().at(-1)).toContain('Cancelled 1 background task');
    await Bun.sleep(300);
    await idle(app);
    expect(claude.calls.filter(c => JSON.stringify(c.messages).includes('automated_update'))).toHaveLength(0);
  });
});

describe('sub-agents', () => {
  test('foreground delegate fans out with read-only tools and returns combined findings', async () => {
    const claude = new FakeClaude(async (p, i) => {
      const sys = p.system.at(-1)?.text ?? '';
      if (sys.includes('# You are a sub-agent')) return { content: [text(`report for ${p.messages[0].content[0].text}`)] };
      if (i === 0) {
        return {
          content: [
            toolUse('delegate', {
              goal: 'Compare CRMs',
              tasks: [
                { title: 'HubSpot', brief: 'pricing of HubSpot' },
                { title: 'Attio', brief: 'pricing of Attio' },
              ],
            }),
          ],
        };
      }
      return { content: [text('Go with Attio.')] };
    });
    const { app, wa } = makeApp({ claude });
    await app.router.handleInbound(inbound({ text: 'which CRM?' }));
    await idle(app);
    const subCalls = claude.calls.filter(c => c.system.at(-1)?.text?.includes('# You are a sub-agent'));
    expect(subCalls).toHaveLength(2);
    const subTools = subCalls[0].tools.map((t: any) => t.name);
    expect(subTools).toContain('recall');
    expect(subTools).toContain('browser');
    expect(subTools).not.toContain('delegate');
    expect(subTools).not.toContain('send_message');
    expect(subTools).not.toContain('remember');
    const final = claude.calls.at(-1);
    const result = lastUser(final).content[0].content;
    expect(result).toContain('## HubSpot\nreport for pricing of HubSpot');
    expect(result).toContain('## Attio\nreport for pricing of Attio');
    expect(wa.texts()).toEqual(['Go with Attio.']);
  });

  test('background delegate reports back as an automated turn', async () => {
    const claude = new FakeClaude(async (p, i) => {
      const sys = p.system.at(-1)?.text ?? '';
      if (sys.includes('# You are a sub-agent')) return { content: [text('Acme raised a Series B in 2025.')] };
      if (i === 0) return { content: [toolUse('delegate', { goal: 'Dig into Acme', background: true, tasks: [{ title: 'Funding', brief: 'Acme funding' }] })] };
      const last = lastUser(p).content.map((b: any) => b.text ?? '').join('');
      if (last.includes('automated_update')) return { content: [text('Acme: Series B (2025). Looks solid.')] };
      return { content: [text("On it — I'll message you when it's done.")] };
    });
    const { app, wa, s } = makeApp({ claude });
    s.store.touchWindow('whatsapp:15550001111');
    await app.router.handleInbound(inbound({ text: 'dig into Acme' }));
    await until(() => wa.texts().length === 2);
    await idle(app);
    expect(wa.texts()).toEqual(["On it — I'll message you when it's done.", 'Acme: Series B (2025). Looks solid.']);
  });
});

describe('background approvals', () => {
  test("ordinary chat isn't swallowed by a pending background approval; a bare yes only counts right after the ask", async () => {
    const { app, s, wa } = makeApp();
    s.store.touchWindow('whatsapp:15550001111');
    const decision = s.approvals.request('owner', 'send_thing', 'Send the weekly report to the board', undefined, { freeText: false });
    await until(() => wa.sent.some(x => x.kind === 'buttons'));
    // Something else gets said after the ask…
    await s.delivery.reply('owner', { channel: 'whatsapp', to: '15550001111' }, 'Unrelated update');
    await app.router.handleInbound(inbound({ text: "what's on tomorrow?" }));
    await idle(app);
    expect(s.store.pendingApprovals('owner')).toHaveLength(1);
    // …so a bare "ok" doesn't approve it either.
    await app.router.handleInbound(inbound({ text: 'ok' }));
    await idle(app);
    expect(s.store.pendingApprovals('owner')).toHaveLength(1);
    // Quoting the request (or tapping the button) does.
    const askId = `wamid.out${wa.sent.findIndex(x => x.kind === 'buttons') + 1}`;
    await app.router.handleInbound(inbound({ text: 'yes', replyToId: askId }));
    expect((await decision).status).toBe('approved');
  });

  test('members cannot pause the owner\'s automations', async () => {
    const { app, wa, s } = makeApp();
    await app.router.handleInbound(inbound({ from: '15550002222', text: '/pause' }));
    expect(wa.texts().at(-1)).toBe('That command is only for the owner.');
    expect(s.store.get('automations_paused')).toBeNull();
  });
});

describe('/connect google', () => {
  test('works on https and on localhost for testing, refuses other plain-http URLs', async () => {
    const google = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' };
    for (const [url, ok] of [
      ['https://agent.example.com', true],
      ['http://localhost:8787', true],
      ['http://127.0.0.1:8787', true],
      ['http://agent.example.com', false],
      ['http://localhost.evil.com', false],
    ] as const) {
      const { app, wa } = makeApp({ env: { ...google, PUBLIC_BASE_URL: url } });
      await app.router.handleInbound(inbound({ text: '/connect google' }));
      const reply = wa.texts().at(-1)!;
      if (ok) expect(reply).toContain('https://accounts.google.com/o/oauth2/v2/auth?');
      else expect(reply).toContain('PUBLIC_BASE_URL must be an https URL');
    }
  });
});
