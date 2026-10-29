/** Wire everything together. Tests call createApp() with a fake Claude client and channels. */

import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import type { Config } from './config';
import type { Services } from './services';
import type { Channel, ChannelName } from './channels/types';
import { Store } from './store';
import { WhatsAppChannel } from './channels/whatsapp';
import { WebChannel } from './channels/web';
import { DiscordChannel } from './channels/discord';
import { Delivery } from './delivery';
import { Approvals } from './approvals';
import { AgentRunner } from './agent/runner';
import { BrowserClient } from './integrations/browser';
import { MediaProviders } from './integrations/media';
import { GoogleAccounts } from './integrations/google';
import { NotionClient } from './integrations/notion';
import { TwilioClient } from './integrations/twilio';
import { SkillLibrary } from './skills';
import { Router } from './router';
import { Commands } from './commands';
import { Scheduler } from './scheduler';
import { buildTools } from './tools';

export interface AppOptions {
  claude?: Anthropic;
  /** Extra or replacement channels (console mode, tests). */
  channels?: Channel[];
  /** Skip the built-in WhatsApp, Discord and web channels. */
  onlyGivenChannels?: boolean;
  storeFile?: string;
  approvalTimeoutMs?: number;
  schedulerIntervalMs?: number;
  fetchPage?: (url: string, render: boolean) => Promise<string>;
}

export interface App {
  services: Services;
  router: Router;
  commands: Commands;
  scheduler: Scheduler;
  web: WebChannel;
  /** Connected by `serve` (it holds a gateway connection open). */
  discord?: DiscordChannel;
}

export const BUILTIN_SKILLS_DIR = path.resolve(import.meta.dir, '..', 'skills');

export function createApp(config: Config, opts: AppOptions = {}): App {
  const store = new Store(config.dataDir, config.timezone, opts.storeFile);
  const services = {} as Services;
  const get = () => services;

  const web = new WebChannel(store, config.publicBaseUrl);
  const channels = new Map<ChannelName, Channel>();
  let discord: DiscordChannel | undefined;
  if (!opts.onlyGivenChannels) {
    if (config.whatsapp) channels.set('whatsapp', new WhatsAppChannel(config.whatsapp));
    if (config.discord) {
      discord = new DiscordChannel(config.discord, store, config.publicBaseUrl, { agentName: config.agentName });
      channels.set('discord', discord);
    }
    channels.set('web', web);
  }
  for (const ch of opts.channels ?? []) channels.set(ch.name, ch);

  const router = new Router(get);
  const commands = new Commands(get, router);
  router.commands = commands;
  const scheduler = new Scheduler(get, { intervalMs: opts.schedulerIntervalMs, fetchPage: opts.fetchPage });
  const runner = new AgentRunner(get);

  Object.assign(services, {
    config,
    store,
    claude: opts.claude ?? new Anthropic({ maxRetries: 3 }),
    channels,
    delivery: new Delivery(get),
    approvals: new Approvals(get, opts.approvalTimeoutMs),
    runner,
    browser: new BrowserClient(config.browseServerScript, config.dataDir),
    media: new MediaProviders(config),
    skills: new SkillLibrary(BUILTIN_SKILLS_DIR, path.join(config.dataDir, 'skills')),
    google: config.google ? new GoogleAccounts(config.google, store, `${config.publicBaseUrl}/oauth/google/callback`) : undefined,
    notion: config.notion ? new NotionClient(config.notion) : undefined,
    twilio: config.twilio ? new TwilioClient(config.twilio, config.publicBaseUrl) : undefined,
    hooks: {
      enqueueTurn: (conversationId: string, text: string) => router.enqueueTurn(conversationId, text),
      appendNote: (conversationId: string, label: string, text: string) => router.appendNote(conversationId, label, text),
    },
    scheduler,
  } satisfies Services);

  const tools = buildTools(services);
  runner.setRegistry({ all: () => tools });

  // Approvals can't survive a restart: the turn waiting on them is gone.
  store.expireAllPendingApprovals();
  return { services, router, commands, scheduler, web, discord };
}
