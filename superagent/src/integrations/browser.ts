/**
 * Drives gstack's own browse server (persistent headless Chromium) over its
 * local HTTP API. The agent gets a dedicated instance via BROWSE_STATE_FILE so
 * it never shares cookies or tabs with your Claude Code sessions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger, errorMessage } from '../log';

const log = logger('browser');

interface ServerState {
  pid: number;
  port: number;
  token: string;
}

/** Shell-style split that respects "double" and 'single' quotes. */
export function splitArgs(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let had = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      had = true;
    } else if (/\s/.test(c)) {
      if (cur || had) out.push(cur);
      cur = '';
      had = false;
    } else {
      cur += c;
    }
  }
  if (cur || had) out.push(cur);
  return out;
}

export class BrowserClient {
  private readonly stateFile: string;
  private starting: Promise<ServerState> | null = null;

  constructor(
    private readonly serverScript: string,
    dataDir: string,
  ) {
    this.stateFile = path.join(dataDir, 'browse-server.json');
  }

  private readState(): ServerState | null {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
    } catch {
      return null;
    }
  }

  private async healthy(state: ServerState): Promise<boolean> {
    try {
      const resp = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(2000) });
      return resp.ok && ((await resp.json()) as any).status === 'healthy';
    } catch {
      return false;
    }
  }

  private async start(): Promise<ServerState> {
    try {
      fs.unlinkSync(this.stateFile);
    } catch {}
    if (!fs.existsSync(this.serverScript)) throw new Error(`gstack browse server not found at ${this.serverScript}`);
    const proc = Bun.spawn(['bun', 'run', this.serverScript], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, BROWSE_STATE_FILE: this.stateFile, BROWSE_PORT_START: process.env.BROWSE_PORT_START || '9500' },
    });
    proc.unref();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const state = this.readState();
      if (state && (await this.healthy(state))) return state;
      await Bun.sleep(150);
    }
    throw new Error('Browser server did not start within 15s (is Playwright Chromium installed? run ./setup)');
  }

  private async ensure(): Promise<ServerState> {
    const state = this.readState();
    if (state && (await this.healthy(state))) return state;
    if (!this.starting) this.starting = this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  async command(command: string, args: string[], retried = false): Promise<string> {
    const state = await this.ensure();
    try {
      const resp = await fetch(`http://127.0.0.1:${state.port}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ command, args }),
        signal: AbortSignal.timeout(45_000),
      });
      const text = await resp.text();
      if (resp.ok) return text;
      let message = text;
      try {
        const err = JSON.parse(text);
        message = [err.error, err.hint].filter(Boolean).join('\n');
      } catch {}
      throw new Error(message || `browse ${command} failed (${resp.status})`);
    } catch (err) {
      const msg = errorMessage(err);
      if (!retried && /ECONNREFUSED|ECONNRESET|fetch failed|Unable to connect/i.test(msg)) {
        log.warn('browser server connection lost; restarting');
        try {
          fs.unlinkSync(this.stateFile);
        } catch {}
        return this.command(command, args, true);
      }
      throw err;
    }
  }
}
