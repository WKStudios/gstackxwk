/**
 * gstack superagent — a personal agent that lives on WhatsApp.
 *
 *   bun run superagent           serve: webhook + web chat + scheduler
 *   bun run superagent:console   chat with it in this terminal (no WhatsApp needed)
 *   bun run superagent:check     verify configuration and connections
 */

import * as readline from 'readline';
import { capabilityFlags, ConfigError, loadConfig } from './config';
import { createApp } from './app';
import { startServer } from './server';
import { ConsoleChannel } from './channels/console';
import { logger, errorMessage } from './log';

const log = logger('superagent');

async function check() {
  const config = loadConfig();
  const app = createApp(config);
  const s = app.services;
  const line = (ok: boolean | null, label: string, detail = '') =>
    console.log(`${ok === null ? '·' : ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);

  try {
    const m = await s.claude.models.retrieve(config.model);
    line(true, 'Claude API', `${m.id}`);
  } catch (err) {
    line(false, 'Claude API', errorMessage(err));
  }
  if (config.whatsapp) {
    try {
      const resp = await fetch(`https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, {
        headers: { Authorization: `Bearer ${config.whatsapp.token}` },
      });
      const json: any = await resp.json();
      line(resp.ok, 'WhatsApp Cloud API', resp.ok ? `${json.display_phone_number} (${json.verified_name}, quality ${json.quality_rating})` : json.error?.message);
    } catch (err) {
      line(false, 'WhatsApp Cloud API', errorMessage(err));
    }
    line(!!config.whatsapp.templateName, 'WhatsApp re-engagement template', config.whatsapp.templateName ?? 'not set — proactive messages wait until you write after 24h of silence');
  } else line(null, 'WhatsApp', 'not configured (web chat and console still work)');
  const local = /^http:\/\/(localhost|127\.0\.0\.1)\b/.test(config.publicBaseUrl);
  line(
    local ? null : config.publicBaseUrl.startsWith('https://'),
    'PUBLIC_BASE_URL',
    local ? `${config.publicBaseUrl} (fine for testing on this computer; WhatsApp needs a public https URL)` : config.publicBaseUrl,
  );
  line(!!config.adminToken, 'Web chat', config.adminToken ? `${config.publicBaseUrl}/chat?token=…` : 'set ADMIN_TOKEN to enable');
  if (s.google?.isConnected()) {
    for (const g of s.google.all()) {
      try {
        await g.profile();
        line(true, 'Google', g.email);
      } catch (err) {
        line(false, 'Google', `${g.email}: ${errorMessage(err)}`);
      }
    }
  } else if (s.google) line(false, 'Google', 'configured; send /connect google');
  else line(null, 'Google', 'not configured');
  if (s.notion) {
    try {
      await s.notion.search('', undefined, 1);
      line(true, 'Notion', s.notion.hubDatabaseId ? 'Hub database set' : 'connected (no NOTION_HUB_DATABASE_ID)');
    } catch (err) {
      line(false, 'Notion', errorMessage(err));
    }
  } else line(null, 'Notion', 'not configured');
  const caps = capabilityFlags(config);
  line(caps.voiceIn, 'Voice notes in (STT)');
  line(caps.voiceOut, 'Voice replies (TTS)');
  line(caps.images, 'Image generation');
  line(caps.phoneCalls, 'Phone calls (Twilio)');
  try {
    const out = await s.browser.command('status', []);
    line(true, 'Browser (gstack browse)', out.split('\n')[0]);
  } catch (err) {
    line(false, 'Browser (gstack browse)', errorMessage(err));
  }
  console.log(`\nOwner: ${config.ownerName} · ${config.owners.length} owner number(s), ${config.members.length} member(s) · ${config.timezone}`);
  console.log(`Data: ${config.dataDir}`);
  s.store.close();
  process.exit(0);
}

async function consoleMode() {
  const config = loadConfig({ ...process.env, WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '' });
  const channel = new ConsoleChannel();
  const app = createApp(config, { channels: [channel], onlyGivenChannels: true });
  app.scheduler.start();
  console.log(`\n${config.agentName} — terminal chat. Type /help for commands, Ctrl+C to quit.\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '▶ ' });
  rl.prompt();
  let n = 0;
  rl.on('line', line => {
    const text = line.trim();
    if (text) {
      void app.router.handleInbound({ channel: 'console', from: 'owner', id: `console_in_${++n}`, timestamp: new Date(), type: 'text', text });
    }
    rl.prompt();
  });
  rl.on('close', () => {
    app.scheduler.stop();
    app.services.store.close();
    process.exit(0);
  });
}

async function serve() {
  const config = loadConfig();
  const app = createApp(config);
  const server = startServer(app);
  app.scheduler.start();
  const caps = capabilityFlags(config);
  log.info(`${config.agentName} listening on :${server.port} (${config.model}, ${config.timezone})`);
  if (config.whatsapp) log.info(`WhatsApp webhook: ${config.publicBaseUrl}/webhook/whatsapp`);
  if (config.adminToken) log.info(`Web chat: ${config.publicBaseUrl}/chat?token=<ADMIN_TOKEN>`);
  if (!config.whatsapp && !config.adminToken) {
    log.warn('Neither WhatsApp nor ADMIN_TOKEN (web chat) is configured, so nothing can reach the agent. Try `bun run superagent:console`.');
  }
  log.info(
    `Integrations: google=${caps.google} notion=${caps.notion} voiceIn=${caps.voiceIn} voiceOut=${caps.voiceOut} images=${caps.images} calls=${caps.phoneCalls}${caps.mcp.length ? ` mcp=${caps.mcp.join(',')}` : ''}`,
  );
  const shutdown = () => {
    log.info('shutting down');
    app.scheduler.stop();
    server.stop();
    app.services.store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const mode = process.argv[2] ?? 'serve';
const main = mode === 'console' ? consoleMode : mode === 'check' ? check : serve;
main().catch(err => {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}\nSee superagent/.env.example.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
