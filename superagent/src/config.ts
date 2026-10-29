/**
 * Superagent configuration — everything comes from environment variables so the
 * same build runs on a laptop, a VPS, or a container. Integrations are optional:
 * leave their variables unset and the matching tools simply don't load.
 */

import * as os from 'os';
import * as path from 'path';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface McpServerConfig {
  name: string;
  url: string;
  authorization_token?: string;
}

export interface OpenAICompatibleProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Config {
  model: string;
  chatEffort: Effort;
  backgroundEffort: Effort;
  agentName: string;
  ownerName: string;
  timezone: string;
  /** Phone numbers (digits only) that get the full agent: email, calendar, everything. */
  owners: string[];
  /** Phone numbers (digits only) that may talk to the agent without owner-only tools. */
  members: string[];
  port: number;
  publicBaseUrl: string;
  dataDir: string;
  adminToken: string;
  whatsapp?: {
    token: string;
    phoneNumberId: string;
    appSecret: string;
    verifyToken: string;
    graphVersion: string;
    templateName?: string;
    templateLanguage: string;
  };
  /** A Discord bot the owner DMs. ownerId pins the owner; otherwise they link with a pairing code. */
  discord?: { token: string; ownerId?: string };
  /** Where proactive messages go when the owner hasn't written recently (default: WhatsApp, then Discord, then web). */
  primaryChannel?: 'whatsapp' | 'discord' | 'web';
  google?: { clientId: string; clientSecret: string };
  notion?: { token: string; hubDatabaseId?: string; version: string };
  stt?: OpenAICompatibleProvider;
  tts?: OpenAICompatibleProvider & { voice: string };
  images?: OpenAICompatibleProvider;
  twilio?: { accountSid: string; authToken: string; fromNumber: string };
  mcpServers: McpServerConfig[];
  /** Minutes after local midnight; proactive messages wait until the window ends. */
  quietHours?: { start: number; end: number };
  dailyBudgetUsd: number;
  debounceMs: number;
  compactAtTokens: number;
  maxSubagents: number;
  browseServerScript: string;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

export function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, '');
}

function list(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map(s => digitsOnly(s.trim()))
    .filter(Boolean);
}

function parseEffort(value: string | undefined, fallback: Effort): Effort {
  const allowed: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
  if (!value) return fallback;
  if (!allowed.includes(value as Effort)) {
    throw new ConfigError(`Invalid effort "${value}" (expected one of ${allowed.join(', ')})`);
  }
  return value as Effort;
}

/** "22:00-07:00" → { start: 1320, end: 420 } */
export function parseQuietHours(value: string | undefined): Config['quietHours'] {
  if (!value) return undefined;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) throw new ConfigError(`QUIET_HOURS must look like 22:00-07:00, got "${value}"`);
  const start = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const end = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
  if (start >= 1440 || end >= 1440) throw new ConfigError(`QUIET_HOURS out of range: "${value}"`);
  return { start, end };
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function provider(env: Env, prefix: string, defaultModel: string): OpenAICompatibleProvider | undefined {
  const apiKey = env[`${prefix}_API_KEY`] || env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  return {
    baseUrl: (env[`${prefix}_BASE_URL`] || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey,
    model: env[`${prefix}_MODEL`] || defaultModel,
  };
}

function parseMcpServers(value: string | undefined): McpServerConfig[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigError('MCP_SERVERS must be a JSON array of {name, url, authorization_token?}');
  }
  if (!Array.isArray(parsed)) throw new ConfigError('MCP_SERVERS must be a JSON array');
  return parsed.map((s: any, i) => {
    if (!s || typeof s.name !== 'string' || typeof s.url !== 'string') {
      throw new ConfigError(`MCP_SERVERS[${i}] needs string "name" and "url"`);
    }
    return { name: s.name, url: s.url, authorization_token: s.authorization_token };
  });
}

export function loadConfig(env: Env = process.env): Config {
  const timezone = env.OWNER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!isValidTimezone(timezone)) throw new ConfigError(`Unknown OWNER_TIMEZONE "${timezone}"`);

  const owners = list(env.OWNER_PHONES);
  const port = parseInt(env.PORT || '8787', 10);
  const publicBaseUrl = (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
  const adminToken = env.ADMIN_TOKEN || '';

  let whatsapp: Config['whatsapp'];
  if (env.WHATSAPP_TOKEN || env.WHATSAPP_PHONE_NUMBER_ID) {
    const missing = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN']
      .filter(k => !env[k]);
    if (missing.length) throw new ConfigError(`WhatsApp is partly configured; missing ${missing.join(', ')}`);
    if (owners.length === 0) {
      throw new ConfigError('OWNER_PHONES is required with WhatsApp, otherwise anyone could command your agent');
    }
    whatsapp = {
      token: env.WHATSAPP_TOKEN!,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!,
      appSecret: env.WHATSAPP_APP_SECRET!,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN!,
      graphVersion: env.WHATSAPP_GRAPH_VERSION || 'v24.0',
      templateName: env.WHATSAPP_TEMPLATE_NAME || undefined,
      templateLanguage: env.WHATSAPP_TEMPLATE_LANGUAGE || 'en',
    };
  }

  const discordOwner = (env.DISCORD_OWNER_ID || '').trim();
  if (discordOwner && !/^\d{5,25}$/.test(discordOwner)) throw new ConfigError('DISCORD_OWNER_ID must be a numeric Discord user id');
  const primaryChannel = (env.PRIMARY_CHANNEL || '').trim().toLowerCase();
  if (primaryChannel && !['whatsapp', 'discord', 'web'].includes(primaryChannel)) {
    throw new ConfigError('PRIMARY_CHANNEL must be whatsapp, discord or web');
  }

  const tts = provider(env, 'TTS', 'gpt-4o-mini-tts');

  const repoRoot = path.resolve(import.meta.dir, '..', '..');

  return {
    model: env.SUPERAGENT_MODEL || 'claude-opus-5-5',
    chatEffort: parseEffort(env.SUPERAGENT_EFFORT, 'medium'),
    backgroundEffort: parseEffort(env.SUPERAGENT_BACKGROUND_EFFORT, 'high'),
    agentName: env.AGENT_NAME || 'Superagent',
    ownerName: env.OWNER_NAME || 'the owner',
    timezone,
    owners,
    members: list(env.MEMBER_PHONES).filter(p => !owners.includes(p)),
    port,
    publicBaseUrl,
    dataDir: path.resolve(env.SUPERAGENT_DATA_DIR || path.join(os.homedir(), '.gstack', 'superagent')),
    adminToken,
    whatsapp,
    discord: env.DISCORD_BOT_TOKEN ? { token: env.DISCORD_BOT_TOKEN.trim(), ownerId: discordOwner || undefined } : undefined,
    primaryChannel: (primaryChannel || undefined) as Config['primaryChannel'],
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
      : undefined,
    notion: env.NOTION_TOKEN
      ? { token: env.NOTION_TOKEN, hubDatabaseId: env.NOTION_HUB_DATABASE_ID, version: env.NOTION_VERSION || '2022-06-28' }
      : undefined,
    stt: provider(env, 'STT', 'gpt-4o-transcribe'),
    tts: tts ? { ...tts, voice: env.TTS_VOICE || 'alloy' } : undefined,
    images: provider(env, 'IMAGE', 'gpt-image-1'),
    twilio: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER
      ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, fromNumber: env.TWILIO_FROM_NUMBER }
      : undefined,
    mcpServers: parseMcpServers(env.MCP_SERVERS),
    quietHours: parseQuietHours(env.QUIET_HOURS),
    dailyBudgetUsd: parseFloat(env.DAILY_BUDGET_USD || '15'),
    debounceMs: parseInt(env.DEBOUNCE_MS || '1500', 10),
    compactAtTokens: parseInt(env.COMPACT_AT_TOKENS || '60000', 10),
    maxSubagents: Math.min(12, Math.max(1, parseInt(env.MAX_SUBAGENTS || '12', 10))),
    browseServerScript: env.BROWSE_SERVER_SCRIPT || path.join(repoRoot, 'browse', 'src', 'server.ts'),
  };
}

/** What the agent can actually do with this config — shown in /status and the system prompt. */
export function capabilityFlags(config: Config) {
  return {
    whatsapp: !!config.whatsapp,
    discord: !!config.discord,
    google: !!config.google,
    notion: !!config.notion,
    voiceIn: !!config.stt,
    voiceOut: !!config.tts,
    images: !!config.images,
    phoneCalls: !!config.twilio,
    mcp: config.mcpServers.map(s => s.name),
  };
}
