/** Schedules, watchers/triggers and missions (goals that survive across days). */

import { z } from 'zod';
import { defineTool, ToolError, type ToolDef } from './types';
import { clock, formatLocal } from '../clock';
import { previewRuns, resolveRelative, ScheduleError, validateSchedule } from '../schedule';
import type { JobRow } from '../store';
import { truncate } from '../format';

const MODE = z
  .enum(['always', 'if_noteworthy', 'if_changed'])
  .describe('always: send every run. if_noteworthy: only when there is something worth saying. if_changed: only when the result differs from last time.');

function describeJob(j: JobRow, tz: string): string {
  const next = j.next_run_at ? formatLocal(new Date(j.next_run_at), tz) : '—';
  const last = j.last_run_at ? `${formatLocal(new Date(j.last_run_at), tz)} (${j.last_status ?? '?'})` : 'never';
  const what = j.kind === 'prompt' ? truncate(j.prompt, 120) : `${j.kind}: ${truncate(j.config, 120)}`;
  return `- ${j.name} [${j.id}] ${j.status} · ${j.schedule} · next ${next} · last ${last}${j.last_error ? ` · error: ${truncate(j.last_error, 160)}` : ''}\n  ${what}`;
}

function checkSchedule(schedule: string, tz: string): Date {
  try {
    return validateSchedule(schedule, tz, clock.now());
  } catch (err) {
    if (err instanceof ScheduleError) throw new ToolError(err.message);
    throw err;
  }
}

function findJob(ctx: { conversationId: string; services: { store: { findJob(c: string, r: string): JobRow | null } } }, ref: string): JobRow {
  const job = ctx.services.store.findJob(ctx.conversationId, ref);
  if (!job) throw new ToolError(`No task named or with id "${ref}". Use list_tasks.`);
  return job;
}

export const automationTools: ToolDef[] = [
  defineTool({
    name: 'schedule_task',
    description:
      'Schedule work to run later or on repeat: "every Friday at 6pm send my weekly review", "remind me tomorrow at 9", "remind me in 20 minutes" (schedule "in:20"), "every weekday 7:30 daily brief". The prompt runs as a fresh background task with all your tools, and its final answer is sent to the owner. Times are in the owner\'s timezone. After creating, confirm the schedule in plain words using the preview.',
    input: z.object({
      name: z.string().describe('Short unique name, e.g. "Daily brief"'),
      schedule: z
        .string()
        .describe('5-field cron ("30 7 * * 1-5"), a one-off local datetime "2026-10-30T09:00", "in:<minutes>" for "in 20 minutes" reminders, or "every:<minutes>"'),
      prompt: z.string().describe('Complete standalone instructions for the future run (it will not see this conversation)'),
      mode: MODE.optional(),
    }),
    run: async (input, ctx) => {
      const { store, config } = ctx.services;
      if (store.findJob(ctx.conversationId, input.name)) throw new ToolError(`A task named "${input.name}" already exists; use update_task.`);
      let schedule: string;
      try {
        schedule = resolveRelative(input.schedule, config.timezone, clock.now());
      } catch (err) {
        if (err instanceof ScheduleError) throw new ToolError(err.message);
        throw err;
      }
      const next = checkSchedule(schedule, config.timezone);
      const job = store.createJob({
        conversation_id: ctx.conversationId,
        name: input.name,
        kind: 'prompt',
        schedule,
        timezone: config.timezone,
        prompt: input.prompt,
        mode: input.mode ?? 'always',
        config: '{}',
        status: 'active',
        next_run_at: next.toISOString(),
      });
      return `Scheduled "${job.name}" [${job.id}]. Runs: ${previewRuns(schedule, config.timezone, clock.now())}.`;
    },
  }),
  defineTool({
    name: 'watch_page',
    description:
      'Watch a web page and message the owner when it changes in a way they care about (price drops, new listings, status pages, "tickets on sale"). Checks are cheap: the page is fetched and compared first, and only real changes are judged.',
    input: z.object({
      name: z.string(),
      url: z.string().url(),
      what: z.string().describe('What change matters, e.g. "price below £200" or "any new job posting mentioning Rust"'),
      every_minutes: z.number().int().min(15).max(10080).optional(),
      render: z.boolean().optional().describe('Use the real browser (for JavaScript-heavy pages)'),
    }),
    run: async (input, ctx) => {
      const { store, config } = ctx.services;
      const schedule = `every:${input.every_minutes ?? 60}`;
      const job = store.createJob({
        conversation_id: ctx.conversationId,
        name: input.name,
        kind: 'watch_page',
        schedule,
        timezone: config.timezone,
        prompt: input.what,
        mode: 'if_noteworthy',
        config: JSON.stringify({ url: input.url, render: !!input.render }),
        status: 'active',
        next_run_at: clock.now().toISOString(),
      });
      return `Watching ${input.url} every ${input.every_minutes ?? 60} min as "${job.name}" [${job.id}]. First check runs now to take a baseline.`;
    },
  }),
  defineTool({
    name: 'watch_gmail',
    description:
      'Trigger on new email matching a Gmail search ("from:bank.com", "subject:invoice has:attachment") and handle each one with instructions (summarize, file, alert, draft a reply).',
    ownerOnly: true,
    input: z.object({
      name: z.string(),
      query: z.string(),
      what: z.string().describe('What to do with each new match'),
      every_minutes: z.number().int().min(5).max(1440).optional(),
    }),
    run: async (input, ctx) => {
      const { store, config, google } = ctx.services;
      if (!google?.isConnected()) throw new ToolError('Google is not connected. The owner can send /connect google.');
      const job = store.createJob({
        conversation_id: ctx.conversationId,
        name: input.name,
        kind: 'watch_gmail',
        schedule: `every:${input.every_minutes ?? 15}`,
        timezone: config.timezone,
        prompt: input.what,
        mode: 'if_noteworthy',
        config: JSON.stringify({ query: input.query }),
        status: 'active',
        next_run_at: clock.now().toISOString(),
        state: JSON.stringify({ seen: [], baseline: true }),
      });
      return `Watching Gmail for "${input.query}" every ${input.every_minutes ?? 15} min as "${job.name}" [${job.id}]. Existing matches are ignored; only new mail triggers it.`;
    },
  }),
  defineTool({
    name: 'list_tasks',
    description: 'List scheduled tasks and watchers with their next run, last result and any error.',
    readOnly: true,
    input: z.object({}),
    run: async (_input, ctx) => {
      const jobs = ctx.services.store.listJobs(ctx.conversationId);
      return jobs.length ? jobs.map(j => describeJob(j, ctx.services.config.timezone)).join('\n') : 'No scheduled tasks.';
    },
  }),
  defineTool({
    name: 'update_task',
    description: 'Pause, resume, reschedule or rewrite a scheduled task or watcher.',
    input: z.object({
      ref: z.string().describe('Task name or id'),
      status: z.enum(['active', 'paused']).optional(),
      schedule: z.string().optional(),
      prompt: z.string().optional(),
      mode: MODE.optional(),
    }),
    run: async (input, ctx) => {
      const { store, config } = ctx.services;
      const job = findJob(ctx, input.ref);
      const fields: Partial<JobRow> = {};
      const schedule = input.schedule ?? job.schedule;
      if (input.schedule) fields.schedule = input.schedule;
      if (input.prompt) fields.prompt = input.prompt;
      if (input.mode) fields.mode = input.mode;
      if (input.status) fields.status = input.status;
      if (input.schedule || input.status === 'active') fields.next_run_at = checkSchedule(schedule, config.timezone).toISOString();
      store.updateJob(job.id, fields);
      const updated = store.getJob(job.id)!;
      return `Updated "${updated.name}": ${updated.status}${updated.status === 'active' ? `, next runs ${previewRuns(updated.schedule, config.timezone, clock.now())}` : ''}.`;
    },
  }),
  defineTool({
    name: 'delete_task',
    description: 'Delete a scheduled task or watcher for good.',
    input: z.object({ ref: z.string() }),
    run: async (input, ctx) => {
      const job = findJob(ctx, input.ref);
      ctx.services.store.deleteJob(job.id);
      return `Deleted "${job.name}".`;
    },
  }),
  defineTool({
    name: 'run_task_now',
    description: 'Run a scheduled task or watcher immediately and return what happened (use to test or debug).',
    input: z.object({ ref: z.string() }),
    run: async (input, ctx) => {
      const job = findJob(ctx, input.ref);
      const result = await ctx.services.scheduler.runJobNow(job.id);
      return `Ran "${job.name}": ${result.status}.${result.output ? `\nOutput:\n${truncate(result.output, 3000)}` : ''}${result.error ? `\nError: ${result.error}` : ''}`;
    },
  }),
  defineTool({
    name: 'task_history',
    description: 'Recent runs of a task with status, output and errors — use to explain why an automation failed.',
    readOnly: true,
    input: z.object({ ref: z.string(), limit: z.number().int().max(20).optional() }),
    run: async (input, ctx) => {
      const { store, config } = ctx.services;
      const job = findJob(ctx, input.ref);
      const runs = store.jobRuns(job.id, input.limit ?? 8);
      if (!runs.length) return `"${job.name}" hasn't run yet. ${describeJob(job, config.timezone)}`;
      return [
        describeJob(job, config.timezone),
        ...runs.map(
          r =>
            `• ${formatLocal(new Date(r.started_at), config.timezone)} ${r.status}${r.error ? ` — ${truncate(r.error, 400)}` : ''}${r.output ? `\n  ${truncate(r.output, 400)}` : ''}`,
        ),
      ].join('\n');
    },
  }),
  defineTool({
    name: 'start_mission',
    description:
      'Start a mission: a goal you keep working on in the background, checking back on a schedule, until it is actually done (e.g. "get a refund from Airline X", "find me 3 flats under £2k near Angel and book viewings", "chase Sam until the contract is signed"). Each check-in you see the goal and your log, act, and record progress.',
    input: z.object({
      goal: z.string().describe('The outcome, plus constraints and what "done" means'),
      check_every_minutes: z.number().int().min(15).max(10080).optional(),
      deadline: z.string().optional().describe('ISO date/time after which the mission should stop and report'),
    }),
    run: async (input, ctx) => {
      const m = ctx.services.store.createMission(ctx.conversationId, input.goal, input.check_every_minutes ?? 240, input.deadline ?? null);
      return `Mission ${m.id} started; first check-in runs within a minute, then every ${m.check_every_minutes} min.`;
    },
  }),
  defineTool({
    name: 'update_mission',
    description:
      'Record progress on a mission, change how often it checks in, or finish it. Always call this during a mission check-in. Set status "done" when the goal is met (and tell the owner), "failed" if it cannot be done, "paused" to wait for the owner.',
    input: z.object({
      id: z.string(),
      note: z.string().describe('What happened since last time / what you did'),
      status: z.enum(['active', 'paused', 'done', 'failed']).optional(),
      next_check_in_minutes: z.number().int().min(5).max(10080).optional(),
    }),
    run: async (input, ctx) => {
      const { store } = ctx.services;
      const m = store.getMission(input.id);
      if (!m || m.conversation_id !== ctx.conversationId) throw new ToolError(`No mission ${input.id}`);
      const fields: Parameters<typeof store.updateMission>[1] = {};
      if (input.status) fields.status = input.status;
      if (input.next_check_in_minutes) {
        fields.next_check_at = new Date(clock.now().getTime() + input.next_check_in_minutes * 60_000).toISOString();
      }
      if (input.status === 'done' || input.status === 'failed') fields.next_check_at = null;
      store.updateMission(input.id, fields, input.note);
      return `Mission ${input.id} updated${input.status ? ` (${input.status})` : ''}.`;
    },
  }),
  defineTool({
    name: 'list_missions',
    description: 'List missions with their status and latest progress notes.',
    readOnly: true,
    input: z.object({ include_finished: z.boolean().optional() }),
    run: async (input, ctx) => {
      const { store, config } = ctx.services;
      const missions = store.listMissions(ctx.conversationId, input.include_finished);
      if (!missions.length) return 'No missions.';
      return missions
        .map(m => {
          const log = JSON.parse(m.log) as { at: string; note: string }[];
          const last = log[log.length - 1];
          return `- ${m.id} [${m.status}] ${truncate(m.goal, 200)}\n  next check: ${m.next_check_at ? formatLocal(new Date(m.next_check_at), config.timezone) : '—'}${last ? `\n  latest: ${truncate(last.note, 300)}` : ''}`;
        })
        .join('\n');
    },
  }),
];

