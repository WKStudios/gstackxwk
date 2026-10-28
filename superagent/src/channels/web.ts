/**
 * Web chat — the same brain in a browser tab. Outbound messages fan out to
 * every open tab over Server-Sent Events; nothing here needs a 24h window.
 */

import * as path from 'path';
import type { Store } from '../store';
import type { Button, Channel, OutboundMedia } from './types';

export interface WebEvent {
  type: 'text' | 'buttons' | 'media';
  id: string;
  text?: string;
  buttons?: Button[];
  url?: string;
  mime?: string;
  filename?: string;
  kind?: OutboundMedia['kind'];
  at: string;
}

type Subscriber = (event: WebEvent) => void;

export class WebChannel implements Channel {
  readonly name = 'web' as const;
  readonly hasSessionWindow = false;
  private subscribers = new Map<string, Set<Subscriber>>();
  private seq = 0;

  constructor(
    private readonly store: Store,
    private readonly publicBaseUrl: string,
  ) {}

  subscribe(address: string, fn: Subscriber): () => void {
    let set = this.subscribers.get(address);
    if (!set) {
      set = new Set();
      this.subscribers.set(address, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit(address: string, event: Omit<WebEvent, 'id' | 'at'>): string {
    const id = `web_${Date.now()}_${++this.seq}`;
    const full: WebEvent = { ...event, id, at: new Date().toISOString() };
    for (const fn of this.subscribers.get(address) ?? []) {
      try {
        fn(full);
      } catch {
        // a closed tab; its unsubscribe will follow
      }
    }
    return id;
  }

  async sendText(to: string, text: string): Promise<string | undefined> {
    return this.emit(to, { type: 'text', text });
  }

  async sendButtons(to: string, body: string, buttons: Button[]): Promise<string | undefined> {
    return this.emit(to, { type: 'buttons', text: body, buttons });
  }

  async sendMedia(to: string, media: OutboundMedia): Promise<string | undefined> {
    const filename = media.filename || path.basename(media.path);
    const token = this.store.hostFile(media.path, filename, media.mime);
    return this.emit(to, {
      type: 'media',
      text: media.caption,
      url: `${this.publicBaseUrl}/files/${token}/${encodeURIComponent(filename)}`,
      mime: media.mime,
      filename,
      kind: media.kind,
    });
  }
}
