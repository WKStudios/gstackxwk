/**
 * Durable state in one SQLite file (bun:sqlite, WAL). Conversation history is
 * append-only: thinking blocks are bound to the exact history that produced
 * them, so nothing here ever rewrites an earlier message. Compaction moves the
 * start pointer forward instead of editing rows.
 */

import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { nowIso, clock, localDate } from './clock';

export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

export interface MemoryRow {
  id: number;
  scope: string;
  kind: string;
  subject: string;
  content: string;
  tags: string;
  pinned: number;
  created_at: string;
  updated_at: string;
}

export type JobKind = 'prompt' | 'watch_page' | 'watch_gmail';
export type JobMode = 'always' | 'if_noteworthy' | 'if_changed';

export interface JobRow {
  id: string;
  conversation_id: string;
  name: string;
  kind: JobKind;
  schedule: string;
  timezone: string;
  prompt: string;
  mode: JobMode;
  config: string;
  status: 'active' | 'paused' | 'done';
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  state: string;
  created_at: string;
}

export interface JobRunRow {
  id: number;
  job_id: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'sent' | 'silent' | 'error';
  output: string | null;
  error: string | null;
}

export interface MissionRow {
  id: string;
  conversation_id: string;
  goal: string;
  status: 'active' | 'paused' | 'done' | 'failed';
  log: string;
  check_every_minutes: number;
  next_check_at: string | null;
  deadline: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRow {
  id: string;
  conversation_id: string;
  tool: string;
  summary: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  message_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface UsageInput {
  conversationId: string;
  kind: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  webSearches: number;
  costUsd: number;
}

export interface TranscriptRow {
  id: number;
  conversation_id: string;
  speaker: 'user' | 'agent';
  channel: string;
  text: string;
  created_at: string;
}

export interface OutboxRow {
  id: number;
  conversation_id: string;
  text: string;
  reason: string;
  created_at: string;
}

export interface CallRow {
  id: string;
  conversation_id: string;
  to_number: string;
  purpose: string;
  status: string;
  transcript: string;
  created_at: string;
  updated_at: string;
}

/** Which memory scopes a conversation can see. */
export function memoryScopes(conversationId: string): string[] {
  return [conversationId, 'shared'];
}

export function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

/** Turn free text into a safe FTS5 query: every word quoted, OR-ed together. */
export function ftsQuery(text: string): string | null {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) || [])
    .filter(w => w.length > 1)
    .slice(0, 12);
  if (words.length === 0) return null;
  return [...new Set(words)].map(w => `"${w.replace(/"/g, '')}"`).join(' OR ');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  history_start INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS transcript (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  speaker TEXT NOT NULL,
  channel TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(text, content='transcript', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS transcript_ai AFTER INSERT ON transcript BEGIN
  INSERT INTO transcript_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS windows (
  address TEXT PRIMARY KEY,
  last_inbound_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbound (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'owner',
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(subject, content, tags, content='memories', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, subject, content, tags) VALUES (new.id, new.subject, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, subject, content, tags) VALUES ('delete', old.id, old.subject, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, subject, content, tags) VALUES ('delete', old.id, old.subject, old.content, old.tags);
  INSERT INTO memories_fts(rowid, subject, content, tags) VALUES (new.id, new.subject, new.content, new.tags);
END;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL,
  prompt TEXT NOT NULL,
  mode TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  state TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  output TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs(job_id, id);

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  log TEXT NOT NULL DEFAULT '[]',
  check_every_minutes INTEGER NOT NULL,
  next_check_at TEXT,
  deadline TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  message_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  web_searches INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  local_day TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_day ON usage(local_day);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  input TEXT NOT NULL,
  result TEXT NOT NULL,
  is_error INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  token TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  text TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  to_number TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL,
  transcript TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class Store {
  readonly db: Database;
  readonly dataDir: string;
  readonly filesDir: string;
  readonly timezone: string;

  constructor(dataDir: string, timezone: string, filename = 'superagent.db') {
    this.dataDir = dataDir;
    this.timezone = timezone;
    this.filesDir = path.join(dataDir, 'files');
    fs.mkdirSync(this.filesDir, { recursive: true });
    this.db = new Database(filename === ':memory:' ? ':memory:' : path.join(dataDir, filename), { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA busy_timeout = 5000');
    this.db.run(SCHEMA);
  }

  close() {
    this.db.close();
  }

  // ─── Conversation history ────────────────────────────────────

  private ensureConversation(id: string) {
    this.db.run(
      'INSERT OR IGNORE INTO conversations (id, history_start, context_tokens, created_at) VALUES (?, 0, 0, ?)',
      [id, nowIso()],
    );
  }

  appendMessages(conversationId: string, messages: MessageParam[]): number[] {
    this.ensureConversation(conversationId);
    const insert = this.db.prepare(
      'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    );
    const ids: number[] = [];
    const tx = this.db.transaction((msgs: MessageParam[]) => {
      for (const m of msgs) {
        const res = insert.run(conversationId, m.role, JSON.stringify(m), nowIso());
        ids.push(Number(res.lastInsertRowid));
      }
    });
    tx(messages);
    return ids;
  }

  /** The active history: everything from the latest compaction point onward. */
  history(conversationId: string): MessageParam[] {
    this.ensureConversation(conversationId);
    const conv = this.db.query('SELECT history_start FROM conversations WHERE id = ?').get(conversationId) as {
      history_start: number;
    };
    const rows = this.db
      .query('SELECT content FROM messages WHERE conversation_id = ? AND id >= ? ORDER BY id')
      .all(conversationId, conv.history_start) as { content: string }[];
    return rows.map(r => JSON.parse(r.content));
  }

  /**
   * Replace the active history with a compaction message. The compaction block
   * summarizes messages up to and including `lastSummarizedId`; anything that
   * arrived after it is kept and follows the block.
   */
  applyCompaction(conversationId: string, compactionMessage: MessageParam, lastSummarizedId: number) {
    const tx = this.db.transaction(() => {
      const res = this.db.run(
        'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)',
        [conversationId, compactionMessage.role, JSON.stringify(compactionMessage), nowIso()],
      );
      const compactionId = Number(res.lastInsertRowid);
      // Messages after lastSummarizedId but before the compaction row would sit in
      // front of the block; re-append them after it so the block comes first.
      const tail = this.db
        .query('SELECT role, content FROM messages WHERE conversation_id = ? AND id > ? AND id < ? ORDER BY id')
        .all(conversationId, lastSummarizedId, compactionId) as { role: string; content: string }[];
      for (const t of tail) {
        this.db.run('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)', [
          conversationId,
          t.role,
          t.content,
          nowIso(),
        ]);
      }
      this.db.run('UPDATE conversations SET history_start = ?, context_tokens = 0 WHERE id = ?', [
        compactionId,
        conversationId,
      ]);
    });
    tx();
  }

  lastMessageId(conversationId: string): number {
    const row = this.db
      .query('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?')
      .get(conversationId) as { id: number | null };
    return row.id ?? 0;
  }

  /** Start a fresh conversation thread (memories, jobs and missions stay). */
  resetHistory(conversationId: string) {
    this.ensureConversation(conversationId);
    const last = this.lastMessageId(conversationId);
    this.db.run('UPDATE conversations SET history_start = ?, context_tokens = 0 WHERE id = ?', [
      last + 1,
      conversationId,
    ]);
  }

  setContextTokens(conversationId: string, tokens: number) {
    this.ensureConversation(conversationId);
    this.db.run('UPDATE conversations SET context_tokens = ? WHERE id = ?', [tokens, conversationId]);
  }

  contextTokens(conversationId: string): number {
    this.ensureConversation(conversationId);
    const row = this.db.query('SELECT context_tokens FROM conversations WHERE id = ?').get(conversationId) as {
      context_tokens: number;
    };
    return row.context_tokens;
  }

  // ─── Transcript (plain text, searchable) ─────────────────────

  addTranscript(conversationId: string, speaker: 'user' | 'agent', channel: string, text: string) {
    if (!text.trim()) return;
    this.db.run('INSERT INTO transcript (conversation_id, speaker, channel, text, created_at) VALUES (?, ?, ?, ?, ?)', [
      conversationId,
      speaker,
      channel,
      text,
      nowIso(),
    ]);
  }

  searchTranscript(conversationId: string, query: string, limit = 10): TranscriptRow[] {
    const q = ftsQuery(query);
    if (!q) return [];
    return this.db
      .query(
        `SELECT t.* FROM transcript_fts f JOIN transcript t ON t.id = f.rowid
         WHERE transcript_fts MATCH ? AND t.conversation_id = ? ORDER BY rank LIMIT ?`,
      )
      .all(q, conversationId, limit) as TranscriptRow[];
  }

  recentTranscript(conversationId: string, limit = 50): TranscriptRow[] {
    const rows = this.db
      .query('SELECT * FROM transcript WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
      .all(conversationId, limit) as TranscriptRow[];
    return rows.reverse();
  }

  // ─── WhatsApp 24h window + reply context ─────────────────────

  touchWindow(address: string) {
    this.db.run(
      'INSERT INTO windows (address, last_inbound_at) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET last_inbound_at = excluded.last_inbound_at',
      [address, nowIso()],
    );
  }

  windowOpen(address: string, hours = 24): boolean {
    const row = this.db.query('SELECT last_inbound_at FROM windows WHERE address = ?').get(address) as
      | { last_inbound_at: string }
      | null;
    if (!row) return false;
    // Leave a 10-minute margin so a long reply doesn't land just outside the window.
    return clock.now().getTime() - new Date(row.last_inbound_at).getTime() < hours * 3600_000 - 10 * 60_000;
  }

  recordOutbound(messageId: string, conversationId: string, text: string) {
    this.db.run('INSERT OR REPLACE INTO outbound (message_id, conversation_id, text, created_at) VALUES (?, ?, ?, ?)', [
      messageId,
      conversationId,
      text.slice(0, 4000),
      nowIso(),
    ]);
  }

  outboundText(messageId: string): string | null {
    const row = this.db.query('SELECT text FROM outbound WHERE message_id = ?').get(messageId) as { text: string } | null;
    return row?.text ?? null;
  }

  // ─── Memory ──────────────────────────────────────────────────
  // Scopes: 'owner', 'member:<phone>', and 'shared' (visible to everyone).

  remember(scope: string, kind: string, subject: string, content: string, tags: string[] = [], pinned = false): MemoryRow {
    // Same scope + kind + subject → update in place rather than piling up duplicates.
    const existing = this.db
      .query('SELECT * FROM memories WHERE scope = ? AND kind = ? AND lower(subject) = lower(?)')
      .get(scope, kind, subject) as MemoryRow | null;
    const now = nowIso();
    if (existing) {
      this.db.run('UPDATE memories SET content = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ?', [
        content,
        tags.join(', '),
        pinned ? 1 : existing.pinned,
        now,
        existing.id,
      ]);
      return this.getMemory(existing.id)!;
    }
    const res = this.db.run(
      'INSERT INTO memories (scope, kind, subject, content, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [scope, kind, subject, content, tags.join(', '), pinned ? 1 : 0, now, now],
    );
    return this.getMemory(Number(res.lastInsertRowid))!;
  }

  getMemory(id: number): MemoryRow | null {
    return this.db.query('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | null;
  }

  recall(scopes: string[], query: string, limit = 8, kind?: string): MemoryRow[] {
    const q = ftsQuery(query);
    if (!q || !scopes.length) return [];
    const sql = `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
      WHERE memories_fts MATCH ? AND m.scope IN (${scopes.map(() => '?').join(', ')}) ${kind ? 'AND m.kind = ?' : ''}
      ORDER BY rank LIMIT ?`;
    const params: (string | number)[] = [q, ...scopes, ...(kind ? [kind] : []), limit];
    return this.db.query(sql).all(...params) as MemoryRow[];
  }

  listMemories(scopes: string[], kind?: string, limit = 100): MemoryRow[] {
    if (!scopes.length) return [];
    const sql = `SELECT * FROM memories WHERE scope IN (${scopes.map(() => '?').join(', ')}) ${kind ? 'AND kind = ?' : ''}
      ORDER BY updated_at DESC LIMIT ?`;
    return this.db.query(sql).all(...scopes, ...(kind ? [kind] : []), limit) as MemoryRow[];
  }

  pinnedMemories(scopes: string[]): MemoryRow[] {
    if (!scopes.length) return [];
    return this.db
      .query(`SELECT * FROM memories WHERE pinned = 1 AND scope IN (${scopes.map(() => '?').join(', ')}) ORDER BY kind, subject`)
      .all(...scopes) as MemoryRow[];
  }

  forget(scopes: string[], id: number): boolean {
    if (!scopes.length) return false;
    return (
      this.db.run(`DELETE FROM memories WHERE id = ? AND scope IN (${scopes.map(() => '?').join(', ')})`, [id, ...scopes]).changes > 0
    );
  }

  // ─── Jobs (schedules, watchers, triggers) ────────────────────

  createJob(job: Omit<JobRow, 'id' | 'created_at' | 'last_run_at' | 'last_status' | 'last_error' | 'state'> & {
    state?: string;
  }): JobRow {
    const id = shortId('job');
    this.db.run(
      `INSERT INTO jobs (id, conversation_id, name, kind, schedule, timezone, prompt, mode, config, status, next_run_at, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        job.conversation_id,
        job.name,
        job.kind,
        job.schedule,
        job.timezone,
        job.prompt,
        job.mode,
        job.config,
        job.status,
        job.next_run_at,
        job.state ?? '{}',
        nowIso(),
      ],
    );
    return this.getJob(id)!;
  }

  getJob(id: string): JobRow | null {
    return this.db.query('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | null;
  }

  /** Find by id or (case-insensitive) name. */
  findJob(conversationId: string, ref: string): JobRow | null {
    return (this.db
      .query('SELECT * FROM jobs WHERE conversation_id = ? AND (id = ? OR lower(name) = lower(?)) ORDER BY created_at DESC')
      .get(conversationId, ref, ref) as JobRow | null);
  }

  listJobs(conversationId?: string): JobRow[] {
    if (conversationId) {
      return this.db
        .query("SELECT * FROM jobs WHERE conversation_id = ? AND status != 'done' ORDER BY created_at")
        .all(conversationId) as JobRow[];
    }
    return this.db.query("SELECT * FROM jobs WHERE status != 'done' ORDER BY created_at").all() as JobRow[];
  }

  dueJobs(nowIsoStr: string): JobRow[] {
    return this.db
      .query("SELECT * FROM jobs WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at")
      .all(nowIsoStr) as JobRow[];
  }

  updateJob(id: string, fields: Partial<Omit<JobRow, 'id'>>) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const sets = keys.map(k => `${k} = ?`).join(', ');
    this.db.run(`UPDATE jobs SET ${sets} WHERE id = ?`, [...keys.map(k => (fields as any)[k] ?? null), id]);
  }

  deleteJob(id: string) {
    this.db.run('DELETE FROM jobs WHERE id = ?', [id]);
  }

  startJobRun(jobId: string): number {
    const res = this.db.run("INSERT INTO job_runs (job_id, started_at, status) VALUES (?, ?, 'running')", [jobId, nowIso()]);
    return Number(res.lastInsertRowid);
  }

  finishJobRun(runId: number, status: JobRunRow['status'], output: string | null, error: string | null) {
    this.db.run('UPDATE job_runs SET finished_at = ?, status = ?, output = ?, error = ? WHERE id = ?', [
      nowIso(),
      status,
      output?.slice(0, 8000) ?? null,
      error?.slice(0, 4000) ?? null,
      runId,
    ]);
  }

  jobRuns(jobId: string, limit = 10): JobRunRow[] {
    return this.db
      .query('SELECT * FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?')
      .all(jobId, limit) as JobRunRow[];
  }

  // ─── Missions (goals that survive across days) ───────────────

  createMission(conversationId: string, goal: string, checkEveryMinutes: number, deadline: string | null): MissionRow {
    const id = shortId('msn');
    const now = nowIso();
    this.db.run(
      `INSERT INTO missions (id, conversation_id, goal, status, log, check_every_minutes, next_check_at, deadline, created_at, updated_at)
       VALUES (?, ?, ?, 'active', '[]', ?, ?, ?, ?, ?)`,
      [id, conversationId, goal, checkEveryMinutes, now, deadline, now, now],
    );
    return this.getMission(id)!;
  }

  getMission(id: string): MissionRow | null {
    return this.db.query('SELECT * FROM missions WHERE id = ?').get(id) as MissionRow | null;
  }

  listMissions(conversationId?: string, includeFinished = false): MissionRow[] {
    const statusFilter = includeFinished ? '' : "AND status IN ('active', 'paused')";
    if (conversationId) {
      return this.db
        .query(`SELECT * FROM missions WHERE conversation_id = ? ${statusFilter} ORDER BY created_at`)
        .all(conversationId) as MissionRow[];
    }
    return this.db.query(`SELECT * FROM missions WHERE 1=1 ${statusFilter} ORDER BY created_at`).all() as MissionRow[];
  }

  dueMissions(nowIsoStr: string): MissionRow[] {
    return this.db
      .query("SELECT * FROM missions WHERE status = 'active' AND next_check_at IS NOT NULL AND next_check_at <= ?")
      .all(nowIsoStr) as MissionRow[];
  }

  updateMission(id: string, fields: Partial<Pick<MissionRow, 'status' | 'next_check_at' | 'check_every_minutes'>>, note?: string) {
    const mission = this.getMission(id);
    if (!mission) return;
    const log = JSON.parse(mission.log) as { at: string; note: string }[];
    if (note) log.push({ at: nowIso(), note: note.slice(0, 2000) });
    const merged = { ...fields, log: JSON.stringify(log.slice(-50)), updated_at: nowIso() };
    const keys = Object.keys(merged);
    this.db.run(`UPDATE missions SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [
      ...keys.map(k => (merged as any)[k] ?? null),
      id,
    ]);
  }

  // ─── Approvals ───────────────────────────────────────────────

  createApproval(conversationId: string, tool: string, summary: string): ApprovalRow {
    const id = shortId('apv');
    this.db.run(
      "INSERT INTO approvals (id, conversation_id, tool, summary, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
      [id, conversationId, tool, summary, nowIso()],
    );
    return this.getApproval(id)!;
  }

  getApproval(id: string): ApprovalRow | null {
    return this.db.query('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | null;
  }

  setApprovalMessage(id: string, messageId: string) {
    this.db.run('UPDATE approvals SET message_id = ? WHERE id = ?', [messageId, id]);
  }

  approvalByMessage(messageId: string): ApprovalRow | null {
    return this.db.query('SELECT * FROM approvals WHERE message_id = ?').get(messageId) as ApprovalRow | null;
  }

  pendingApprovals(conversationId: string): ApprovalRow[] {
    return this.db
      .query("SELECT * FROM approvals WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at")
      .all(conversationId) as ApprovalRow[];
  }

  resolveApproval(id: string, status: 'approved' | 'denied' | 'expired') {
    this.db.run("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'", [
      status,
      nowIso(),
      id,
    ]);
  }

  expireAllPendingApprovals() {
    this.db.run("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE status = 'pending'", [nowIso()]);
  }

  // ─── Usage + budget ──────────────────────────────────────────

  recordUsage(u: UsageInput) {
    this.db.run(
      `INSERT INTO usage (conversation_id, kind, model, input_tokens, output_tokens, cache_read, cache_write, web_searches, cost_usd, local_day, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        u.conversationId,
        u.kind,
        u.model,
        u.inputTokens,
        u.outputTokens,
        u.cacheRead,
        u.cacheWrite,
        u.webSearches,
        u.costUsd,
        localDate(clock.now(), this.timezone),
        nowIso(),
      ],
    );
  }

  usageForDay(day = localDate(clock.now(), this.timezone)) {
    return this.db
      .query(
        `SELECT COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(input_tokens + cache_read + cache_write), 0) AS input,
                COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(web_searches), 0) AS searches, COUNT(*) AS calls
         FROM usage WHERE local_day = ?`,
      )
      .get(day) as { cost: number; input: number; output: number; searches: number; calls: number };
  }

  // ─── Audit log ───────────────────────────────────────────────

  audit(conversationId: string, tool: string, input: unknown, result: string, isError: boolean) {
    this.db.run('INSERT INTO audit (conversation_id, tool, input, result, is_error, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      conversationId,
      tool,
      JSON.stringify(input ?? {}).slice(0, 2000),
      result.slice(0, 2000),
      isError ? 1 : 0,
      nowIso(),
    ]);
  }

  recentAudit(limit = 20) {
    return (this.db.query('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) as any[]).reverse() as {
      tool: string;
      input: string;
      result: string;
      is_error: number;
      created_at: string;
    }[];
  }

  // ─── Hosted files ────────────────────────────────────────────

  hostFile(filePath: string, filename: string, mime: string, ttlHours = 72): string {
    const token = crypto.randomBytes(16).toString('hex');
    const expires = new Date(clock.now().getTime() + ttlHours * 3600_000).toISOString();
    this.db.run('INSERT INTO files (token, path, filename, mime, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [
      token,
      filePath,
      filename,
      mime,
      nowIso(),
      expires,
    ]);
    return token;
  }

  hostedFile(token: string): { path: string; filename: string; mime: string } | null {
    const row = this.db.query('SELECT * FROM files WHERE token = ? AND expires_at > ?').get(token, nowIso()) as
      | { path: string; filename: string; mime: string }
      | null;
    return row;
  }

  // ─── Outbox (messages held for quiet hours / closed window) ──

  queueOutbox(conversationId: string, text: string, reason: string) {
    this.db.run('INSERT INTO outbox (conversation_id, text, reason, created_at) VALUES (?, ?, ?, ?)', [
      conversationId,
      text,
      reason,
      nowIso(),
    ]);
  }

  pendingOutbox(conversationId: string): OutboxRow[] {
    return this.db
      .query('SELECT * FROM outbox WHERE conversation_id = ? AND delivered_at IS NULL ORDER BY id')
      .all(conversationId) as OutboxRow[];
  }

  outboxConversations(): string[] {
    return (this.db.query('SELECT DISTINCT conversation_id FROM outbox WHERE delivered_at IS NULL').all() as { conversation_id: string }[]).map(
      r => r.conversation_id,
    );
  }

  markOutboxDelivered(id: number) {
    this.db.run('UPDATE outbox SET delivered_at = ? WHERE id = ?', [nowIso(), id]);
  }

  // ─── Phone calls ─────────────────────────────────────────────

  createCall(conversationId: string, to: string, purpose: string): CallRow {
    const id = shortId('call');
    const now = nowIso();
    this.db.run(
      "INSERT INTO calls (id, conversation_id, to_number, purpose, status, transcript, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', '', ?, ?)",
      [id, conversationId, to, purpose, now, now],
    );
    return this.getCall(id)!;
  }

  getCall(id: string): CallRow | null {
    return this.db.query('SELECT * FROM calls WHERE id = ?').get(id) as CallRow | null;
  }

  updateCall(id: string, status: string, transcriptAppend?: string) {
    const call = this.getCall(id);
    if (!call) return;
    const transcript = transcriptAppend ? `${call.transcript}${call.transcript ? '\n' : ''}${transcriptAppend}` : call.transcript;
    this.db.run('UPDATE calls SET status = ?, transcript = ?, updated_at = ? WHERE id = ?', [status, transcript, nowIso(), id]);
  }

  // ─── Key/value settings + secrets (OAuth tokens) ─────────────

  get(key: string): string | null {
    const row = this.db.query('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  set(key: string, value: string | null) {
    if (value === null) {
      this.db.run('DELETE FROM kv WHERE key = ?', [key]);
      return;
    }
    this.db.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      key,
      value,
    ]);
  }

  getJson<T>(key: string, fallback: T): T {
    const raw = this.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  setJson(key: string, value: unknown) {
    this.set(key, JSON.stringify(value));
  }
}
