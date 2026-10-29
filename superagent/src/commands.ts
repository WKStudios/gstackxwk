/**
 * Deterministic commands — instant, free, and never sent to the model.
 * "stop" and "/pause" are the kill switches; they work even mid-turn.
 */

import type { Services } from './services';
import type { Router } from './router';
import type { ReplyTarget, Role } from './tools/types';
import { capabilityFlags } from './config';
import { clock, formatLocal, localDate } from './clock';
import { formatMemory } from './agent/prompt';
import { memoryScopes } from './store';
import { listBackground, stopBackground } from './background';
import { vaultNames } from './tools/browser';
import { truncate } from './format';
import { validateSchedule } from './schedule';

export interface CommandInput {
  conversationId: string;
  role: Role;
  target: ReplyTarget;
  text: string;
}

const HELP = `*Commands*
stop — stop what I'm doing now (*stop all* also cancels background work)
/pause · /resume — pause or resume every automation
/jobs — scheduled tasks and watchers · /missions — long-running goals
/memory [search] — what I remember · /forget <id>
/usage — today's spend · /budget <usd> — raise today's limit
/voice on|off|mirror — reply with voice notes
/vault set <name> <value> · /vault list · /vault delete <name>
/connect google (once per account) · /disconnect google
/new — fresh conversation thread (memory stays)
/log — my recent actions · /status — what's connected
/starter — set up a daily brief and weekly reviews

Everything else, just ask in plain words.`;

export class Commands {
  constructor(
    private readonly services: () => Services,
    private readonly router: Router,
  ) {}

  matches(text: string): boolean {
    const t = text.trim();
    return /^\/[a-z]/i.test(t) || /^(stop|stop all|pause|resume)[.!]?$/i.test(t);
  }

  async handle(input: CommandInput): Promise<void> {
    const reply = await this.run(input);
    if (reply) await this.services().delivery.reply(input.conversationId, input.target, reply);
  }

  private async run({ conversationId, role, target, text }: CommandInput): Promise<string | null> {
    const s = this.services();
    const { store, config } = s;
    const [rawCmd, ...rest] = text.trim().replace(/^\//, '').split(/\s+/);
    // "Stop!" and "stop all." are commands too; arguments (vault values) are kept verbatim.
    const cmd = rawCmd.toLowerCase().replace(/[.!]+$/, '');
    const arg = rest.join(' ').trim();
    const word = arg.toLowerCase().replace(/[.!]+$/, '');
    const ownerOnly = () => (role === 'owner' ? null : 'That command is only for the owner.');

    switch (cmd) {
      case 'help':
      case 'commands':
        return HELP;

      case 'stop': {
        const { aborted, dropped } = this.router.stop(conversationId);
        const bg = word === 'all' ? stopBackground(conversationId) : 0;
        if (!aborted && !dropped && !bg) {
          const running = listBackground(conversationId).length;
          return running ? `Nothing running in the foreground. ${running} background task(s) still going — send *stop all* to cancel them.` : 'Nothing is running.';
        }
        return `🛑 Stopped.${dropped ? ` Dropped ${dropped} queued message(s).` : ''}${bg ? ` Cancelled ${bg} background task(s).` : ''}`;
      }

      case 'pause':
        if (ownerOnly()) return ownerOnly();
        store.set('automations_paused', clock.now().toISOString());
        return '⏸️ All automations paused (schedules, watchers, missions). Send /resume to restart them.';

      case 'resume':
        if (ownerOnly()) return ownerOnly();
        store.set('automations_paused', null);
        return '▶️ Automations resumed.';

      case 'jobs':
      case 'tasks': {
        const jobs = store.listJobs(conversationId);
        if (!jobs.length) return 'No scheduled tasks yet. Try "every weekday at 7:30 send me a daily brief", or /starter.';
        const paused = store.get('automations_paused') ? '⏸️ All automations are paused.\n' : '';
        return (
          paused +
          jobs
            .map(
              j =>
                `• *${j.name}* (${j.status}) — ${j.kind === 'prompt' ? j.schedule : `${j.kind.replace('_', ' ')}, ${j.schedule}`}\n  next: ${j.next_run_at ? formatLocal(new Date(j.next_run_at), config.timezone) : '—'}${j.last_status ? ` · last: ${j.last_status}` : ''}${j.last_error ? ` ⚠️ ${truncate(j.last_error, 80)}` : ''}`,
            )
            .join('\n')
        );
      }

      case 'missions': {
        const missions = store.listMissions(conversationId);
        if (!missions.length) return 'No active missions.';
        return missions
          .map(m => {
            const log = JSON.parse(m.log) as { note: string }[];
            return `• *${truncate(m.goal, 100)}* (${m.status}, ${m.id})${log.length ? `\n  latest: ${truncate(log[log.length - 1].note, 140)}` : ''}`;
          })
          .join('\n');
      }

      case 'usage': {
        const u = store.usageForDay();
        const override = parseFloat(store.get(`budget:${localDate(clock.now(), config.timezone)}`) ?? '');
        const budget = Number.isFinite(override) ? override : config.dailyBudgetUsd;
        return `Today: $${u.cost.toFixed(2)} of $${budget.toFixed(2)} · ${u.calls} model calls · ${Math.round(u.input / 1000)}k in / ${Math.round(u.output / 1000)}k out tokens · ${u.searches} web searches`;
      }

      case 'budget': {
        if (ownerOnly()) return ownerOnly();
        const value = parseFloat(arg.replace('$', ''));
        if (!Number.isFinite(value) || value <= 0) return 'Usage: /budget 25 (US dollars, today only)';
        store.set(`budget:${localDate(clock.now(), config.timezone)}`, String(value));
        return `Today's limit is now $${value.toFixed(2)}.`;
      }

      case 'status': {
        const caps = capabilityFlags(config);
        const google = s.google ? (s.google.isConnected() ? s.google.emails().join(', ') : 'not connected — /connect google') : 'not configured';
        const bg = listBackground(conversationId);
        return [
          `*${config.agentName}* · ${config.model} · ${config.timezone}`,
          `WhatsApp: ${caps.whatsapp ? 'on' : 'off'} · Google: ${google} · Notion: ${caps.notion ? 'on' : 'off'}`,
          `Voice in/out: ${caps.voiceIn ? 'on' : 'off'}/${caps.voiceOut ? 'on' : 'off'} · Images: ${caps.images ? 'on' : 'off'} · Calls: ${caps.phoneCalls ? 'on' : 'off'}`,
          caps.mcp.length ? `MCP: ${caps.mcp.join(', ')}` : '',
          `Automations: ${store.listJobs(conversationId).length} task(s), ${store.listMissions(conversationId).length} mission(s)${store.get('automations_paused') ? ' — ⏸️ paused' : ''}`,
          `Working now: ${this.router.isBusy(conversationId) ? 'yes' : 'no'}${bg.length ? ` · background: ${bg.map(b => b.label).join('; ')}` : ''}`,
        ]
          .filter(Boolean)
          .join('\n');
      }

      case 'memory':
      case 'memories': {
        const scopes = memoryScopes(conversationId);
        const rows = arg ? store.recall(scopes, arg, 15) : [...store.pinnedMemories(scopes), ...store.listMemories(scopes, undefined, 15).filter(m => !m.pinned)];
        return rows.length ? rows.map(formatMemory).join('\n') : arg ? `Nothing remembered about "${arg}".` : 'No memories yet — I save them as we talk.';
      }

      case 'forget': {
        const id = parseInt(arg.replace('#', ''), 10);
        if (!Number.isFinite(id)) return 'Usage: /forget 12 (the #id from /memory)';
        return store.forget(memoryScopes(conversationId), id) ? `Forgot #${id}.` : `No memory #${id}.`;
      }

      case 'voice': {
        const mode = word;
        if (!['on', 'off', 'mirror', 'always'].includes(mode)) return `Voice replies: ${store.get('voice_mode') ?? 'mirror'}. Use /voice on, off or mirror (voice back only when you send voice).`;
        if (!s.media.canSpeak && mode !== 'off') return 'Voice replies need TTS configured (TTS_API_KEY or OPENAI_API_KEY).';
        store.set('voice_mode', mode === 'on' ? 'always' : mode);
        return `Voice replies: ${mode === 'on' ? 'always' : mode}.`;
      }

      case 'vault': {
        if (ownerOnly()) return ownerOnly();
        const [sub, name, ...valueParts] = rest;
        const value = valueParts.join(' ');
        if (sub === 'set' && name && value) {
          store.set(`vault:${name.toLowerCase()}`, value);
          return `🔐 Saved "${name.toLowerCase()}". I'll use it as {{secret:${name.toLowerCase()}}} in the browser without ever seeing it. You may want to delete your message above.`;
        }
        if (sub === 'delete' && name) {
          store.set(`vault:${name.toLowerCase()}`, null);
          return `Deleted "${name.toLowerCase()}".`;
        }
        if (sub === 'list' || !sub) {
          const names = vaultNames(store);
          return names.length ? `Vault: ${names.join(', ')}` : 'The vault is empty. Add with /vault set github-password hunter2';
        }
        return 'Usage: /vault set <name> <value> · /vault list · /vault delete <name>';
      }

      case 'connect': {
        if (ownerOnly()) return ownerOnly();
        if (word !== 'google') return 'Usage: /connect google';
        if (!s.google) return 'Google isn\'t configured on the server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see superagent/README.md).';
        // Google accepts plain http only for localhost, which is enough to test on your own computer.
        if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$))/.test(config.publicBaseUrl)) {
          return 'PUBLIC_BASE_URL must be an https URL (or http://localhost while testing) that Google can redirect back to.';
        }
        const connected = s.google.emails();
        if (!connected.length) {
          return `Tap to connect Gmail, Calendar and Drive (link valid 30 minutes):\n${s.google.authUrl()}\n\nGot more than one Google account? Send /connect google again afterwards for each.`;
        }
        return `Connected now: ${connected.join(', ')}.\nTap to add another Google account, or to reconnect one of these (link valid 30 minutes):\n${s.google.authUrl()}`;
      }

      case 'disconnect': {
        if (ownerOnly()) return ownerOnly();
        const [service = '', ...who] = rest;
        if (service.toLowerCase().replace(/[.!]+$/, '') !== 'google' || !s.google) return 'Usage: /disconnect google [account]';
        const connected = s.google.emails();
        const which = who.join(' ').replace(/[.!]+$/, '');
        if (!connected.length) return 'No Google account is connected.';
        let target: string | undefined;
        if (which && which.toLowerCase() !== 'all') {
          const email = s.google.resolve(which);
          if (!email) return `No connected account matches "${which}". Connected: ${connected.join(', ')}.`;
          target = email;
        } else if (!which && connected.length > 1) {
          return `Which one? ${connected.map(e => `/disconnect google ${e}`).join(' · ')} · or /disconnect google all`;
        }
        const removed = s.google.disconnect(target);
        const left = s.google.emails();
        return `Disconnected ${removed.join(', ')}.${left.length ? ` Still connected: ${left.join(', ')}.` : ''} (You can also revoke access at myaccount.google.com/permissions.)`;
      }

      case 'new':
      case 'reset': {
        this.router.stop(conversationId);
        this.router.exclusive(conversationId, async () => store.resetHistory(conversationId));
        return '🧹 Fresh thread. I still remember everything important (/memory), and your automations keep running.';
      }

      case 'log': {
        const rows = store.recentAudit(15);
        if (!rows.length) return 'No actions yet.';
        return rows
          .map(r => `${r.is_error ? '⚠️' : '•'} ${formatLocal(new Date(r.created_at), config.timezone).replace(/ \(.+\)$/, '')} ${r.tool} — ${truncate(r.result.replace(/\s+/g, ' '), 90)}`)
          .join('\n');
      }

      case 'starter':
        if (ownerOnly()) return ownerOnly();
        return this.installStarter(conversationId);

      default:
        return `I don't know /${cmd}. Send /help for commands, or just ask in plain words.`;
    }
  }

  private installStarter(conversationId: string): string {
    const s = this.services();
    const { store, config } = s;
    const google = !!s.google;
    const hub = !!s.notion?.hubDatabaseId;
    const starters = [
      google && {
        name: 'Daily brief',
        schedule: '30 7 * * 1-5',
        mode: 'always' as const,
        prompt: 'Read the daily-brief skill and send the owner their brief for today.',
      },
      google && {
        name: 'Calendar scan',
        schedule: '0 18 * * 0',
        mode: 'if_noteworthy' as const,
        prompt: 'Read the calendar-scan skill and check the next 7 days. Only report problems (conflicts, timezone traps, missing prep, deadlines); answer NO_UPDATE if the week looks clean.',
      },
      google && {
        name: 'Chase quiet threads',
        schedule: '0 16 * * 3',
        mode: 'if_noteworthy' as const,
        prompt: 'Read the inbox-triage skill and do only the "quiet threads" step: find threads where the owner is waiting on a reply, and suggest a one-line nudge for each. NO_UPDATE if none.',
      },
      hub && {
        name: 'Hub inbox sweep',
        schedule: '0 10 * * 6',
        mode: 'always' as const,
        prompt: 'Read the hub-capture skill and run the Saturday Inbox sweep to zero, then report.',
      },
      {
        name: 'Weekly review',
        schedule: '0 18 * * 5',
        mode: 'always' as const,
        prompt: `Write the owner a short weekly review: what got done this week (use search_history and your task/mission lists), what's still open, and the top 3 priorities for next week. Under 12 lines.`,
      },
    ].filter(Boolean) as { name: string; schedule: string; mode: 'always' | 'if_noteworthy'; prompt: string }[];

    const added: string[] = [];
    for (const st of starters) {
      if (store.findJob(conversationId, st.name)) continue;
      const next = validateSchedule(st.schedule, config.timezone, clock.now());
      store.createJob({
        conversation_id: conversationId,
        name: st.name,
        kind: 'prompt',
        schedule: st.schedule,
        timezone: config.timezone,
        prompt: st.prompt,
        mode: st.mode,
        config: '{}',
        status: 'active',
        next_run_at: next.toISOString(),
      });
      added.push(`• ${st.name} — first run ${formatLocal(next, config.timezone)}`);
    }
    if (!added.length) return 'The starter automations are already set up. /jobs to see them.';
    return `Added:\n${added.join('\n')}${google ? '' : '\n\n(Connect Google for the daily brief and calendar checks: /connect google)'}\n\nChange any of them in plain words, e.g. "move the daily brief to 8am".`;
  }
}
