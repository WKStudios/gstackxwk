process.env.LOG_LEVEL ??= 'silent';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, type Config } from '../src/config';
import { createApp, type AppOptions } from '../src/app';
import type { Button, Channel, InboundMessage, OutboundMedia } from '../src/channels/types';
import { GoogleAccounts } from '../src/integrations/google';
import type { Services } from '../src/services';

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-test-'));
}

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    OWNER_NAME: 'Ada',
    OWNER_PHONES: '15550001111',
    MEMBER_PHONES: '15550002222',
    OWNER_TIMEZONE: 'Europe/London',
    SUPERAGENT_DATA_DIR: tempDir(),
    PUBLIC_BASE_URL: 'https://agent.example.com',
    ADMIN_TOKEN: 'admin-secret',
    DEBOUNCE_MS: '0',
    ...env,
  });
}

export type Sent =
  | { kind: 'text'; to: string; text: string; replyTo?: string }
  | { kind: 'buttons'; to: string; body: string; buttons: Button[] }
  | { kind: 'media'; to: string; media: OutboundMedia }
  | { kind: 'template'; to: string; preview: string };

/** Records everything sent; pretends to be WhatsApp (24h window) by default. */
export class FakeChannel implements Channel {
  readonly name: 'whatsapp' | 'web' | 'console';
  readonly hasSessionWindow: boolean;
  sent: Sent[] = [];
  reads: string[] = [];
  media = new Map<string, { data: Buffer; mime: string }>();
  private seq = 0;

  constructor(name: 'whatsapp' | 'web' | 'console' = 'whatsapp', hasSessionWindow = name === 'whatsapp') {
    this.name = name;
    this.hasSessionWindow = hasSessionWindow;
  }

  private id() {
    return `wamid.out${++this.seq}`;
  }
  async sendText(to: string, text: string, opts?: { replyTo?: string }) {
    this.sent.push({ kind: 'text', to, text, replyTo: opts?.replyTo });
    return this.id();
  }
  async sendButtons(to: string, body: string, buttons: Button[]) {
    this.sent.push({ kind: 'buttons', to, body, buttons });
    return this.id();
  }
  async sendMedia(to: string, media: OutboundMedia) {
    this.sent.push({ kind: 'media', to, media });
    return this.id();
  }
  async sendTemplate(to: string, preview: string) {
    this.sent.push({ kind: 'template', to, preview });
    return this.id();
  }
  async markRead(messageId: string) {
    this.reads.push(messageId);
  }
  async downloadMedia(id: string) {
    const m = this.media.get(id);
    if (!m) throw new Error(`no media ${id}`);
    return m;
  }
  texts(): string[] {
    return this.sent.filter((s): s is Extract<Sent, { kind: 'text' }> => s.kind === 'text').map(s => s.text);
  }
}

type Block = Record<string, unknown>;
export interface FakeResponse {
  content?: Block[];
  stop_reason?: string;
  usage?: Record<string, unknown>;
  container?: { id: string };
}
export type Responder = (params: any, index: number) => FakeResponse | Promise<FakeResponse>;

export const text = (t: string): Block => ({ type: 'text', text: t, citations: null });
export const toolUse = (name: string, input: unknown, id = `toolu_${name}_${Math.random().toString(36).slice(2, 8)}`): Block => ({
  type: 'tool_use',
  id,
  name,
  input,
});

function message(r: FakeResponse): any {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: r.content ?? [],
    stop_reason: r.stop_reason ?? ((r.content ?? []).some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(r.usage ?? {}) },
    container: r.container ?? null,
  };
}

/** Stands in for the Anthropic client: scripted responses, every request recorded. */
export class FakeClaude {
  calls: any[] = [];
  createCalls: any[] = [];
  compactResponse: FakeResponse = {
    content: [{ type: 'compaction', content: 'Summary: Ada likes short replies.', signature: 'sig_abc' }],
    stop_reason: 'compaction',
  };

  constructor(public responder: Responder = () => ({ content: [text('ok')] })) {}

  beta = {
    messages: {
      stream: (params: any, opts?: { signal?: AbortSignal }) => {
        const index = this.calls.length;
        this.calls.push(structuredClone(params));
        const result = (async () => {
          if (opts?.signal?.aborted) throw new Anthropic.APIUserAbortError();
          const r = await this.responder(params, index);
          if (opts?.signal?.aborted) throw new Anthropic.APIUserAbortError();
          return message(r);
        })();
        result.catch(() => {});
        return { finalMessage: () => result };
      },
      create: async (params: any) => {
        this.createCalls.push(structuredClone(params));
        return message(this.compactResponse);
      },
    },
  };

  models = { retrieve: async (id: string) => ({ id }) };
  files = {
    upload: async () => ({ id: 'file_up' }),
    retrieveMetadata: async (id: string) => ({ id, filename: `${id}.txt` }),
    download: async () => new Response('file-bytes'),
  };

  asClient(): Anthropic {
    return this as unknown as Anthropic;
  }
}

export function inbound(partial: Partial<InboundMessage> & { text?: string }): InboundMessage {
  return {
    channel: 'whatsapp',
    from: '15550001111',
    id: `wamid.in${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date(),
    type: 'text',
    ...partial,
  };
}

export function makeApp(opts: { env?: Record<string, string>; claude?: FakeClaude; app?: AppOptions } = {}) {
  const config = testConfig(opts.env);
  const claude = opts.claude ?? new FakeClaude();
  const wa = new FakeChannel('whatsapp');
  const app = createApp(config, {
    claude: claude.asClient(),
    channels: [wa],
    onlyGivenChannels: true,
    storeFile: ':memory:',
    ...opts.app,
  });
  return { app, claude, wa, config, s: app.services };
}

/** Wait until the router has nothing running or queued for a conversation. */
export async function idle(app: ReturnType<typeof makeApp>['app'], conversationId = 'owner', timeoutMs = 3000) {
  const start = Date.now();
  await Bun.sleep(5);
  while (app.router.isBusy(conversationId)) {
    if (Date.now() - start > timeoutMs) throw new Error('router did not go idle');
    await Bun.sleep(5);
  }
}

export async function until(cond: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await Bun.sleep(5);
  }
}

/**
 * A fake Google API with one or more connected accounts. Each account's
 * requests are answered from its own routes (matched by URL substring);
 * accounts in `revoked` fail to refresh their token.
 */
export function fakeGoogle(s: Services, accounts: Record<string, Record<string, unknown>>, opts: { revoked?: string[] } = {}) {
  const hits: string[] = [];
  const calls: { account: string; method: string; url: string }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    hits.push(`${method} ${url}`);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const email = (new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? '').replace(/^rt-/, '');
      if (opts.revoked?.includes(email)) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: `at-${email}`, expires_in: 3600 });
    }
    const account = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '').replace(/^Bearer at-/, '');
    calls.push({ account, method, url });
    const routes = accounts[account] ?? {};
    const key = Object.keys(routes).find(k => url.includes(k));
    if (!key) return Response.json({ error: { message: `no route for ${url}` } }, { status: 404 });
    return Response.json(routes[key]);
  };
  const save = () => s.store.setJson('google:accounts', Object.keys(accounts).map(email => ({ email, refresh_token: `rt-${email}` })));
  save();
  s.google = new GoogleAccounts({ clientId: 'id', clientSecret: 'sec' }, s.store, 'https://agent.example.com/oauth/google/callback', fetchImpl);
  /** Connect another account after the fact, as a later /connect google would. */
  const connect = (email: string, routes: Record<string, unknown>) => {
    accounts[email] = routes;
    save();
  };
  return { hits, calls, connect };
}
