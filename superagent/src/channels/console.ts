/** Terminal channel for trying the agent locally: `bun run superagent:console`. */

import type { Button, Channel, OutboundMedia } from './types';

export class ConsoleChannel implements Channel {
  readonly name = 'console' as const;
  readonly hasSessionWindow = false;
  private seq = 0;

  constructor(private readonly write: (line: string) => void = line => process.stdout.write(`${line}\n`)) {}

  async sendText(_to: string, text: string): Promise<string> {
    this.write(`\n\x1b[32m◀ ${text}\x1b[0m\n`);
    return `console_${++this.seq}`;
  }

  async sendButtons(_to: string, body: string, buttons: Button[]): Promise<string> {
    this.write(`\n\x1b[33m◀ ${body}\n   [${buttons.map(b => b.title).join('] [')}] — reply yes or no\x1b[0m\n`);
    return `console_${++this.seq}`;
  }

  async sendMedia(_to: string, media: OutboundMedia): Promise<string> {
    this.write(`\n\x1b[36m◀ 📎 ${media.kind}: ${media.path}${media.caption ? ` — ${media.caption}` : ''}\x1b[0m\n`);
    return `console_${++this.seq}`;
  }
}
