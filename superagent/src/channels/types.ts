export type ChannelName = 'whatsapp' | 'discord' | 'web' | 'console';

export type InboundType =
  | 'text'
  | 'image'
  | 'audio'
  | 'document'
  | 'video'
  | 'location'
  | 'contacts'
  | 'button'
  | 'reaction'
  | 'sticker'
  | 'unsupported';

export interface InboundMedia {
  /** Channel media id (WhatsApp) — downloaded lazily. */
  id?: string;
  /** Raw bytes when the channel already has them (web uploads). */
  data?: Buffer;
  mime: string;
  filename?: string;
  caption?: string;
  voice?: boolean;
}

export interface InboundMessage {
  channel: ChannelName;
  from: string;
  profileName?: string;
  id: string;
  timestamp: Date;
  type: InboundType;
  text?: string;
  media?: InboundMedia;
  replyToId?: string;
  buttonId?: string;
  reaction?: { messageId: string; emoji: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
}

export interface OutboundMedia {
  path: string;
  mime: string;
  filename?: string;
  caption?: string;
  kind: 'image' | 'document' | 'audio' | 'video';
  /** Render audio as a voice note (OGG/Opus). */
  voice?: boolean;
}

export interface Button {
  id: string;
  title: string;
}

export interface Channel {
  readonly name: ChannelName;
  /** True when free-form messages are only allowed inside a 24h customer-service window. */
  readonly hasSessionWindow: boolean;
  sendText(to: string, text: string, opts?: { replyTo?: string }): Promise<string | undefined>;
  sendButtons(to: string, body: string, buttons: Button[]): Promise<string | undefined>;
  sendMedia(to: string, media: OutboundMedia): Promise<string | undefined>;
  /** Re-open a closed session window with an approved template (WhatsApp). */
  sendTemplate?(to: string, preview: string): Promise<string | undefined>;
  markRead?(messageId: string, typing?: boolean): Promise<void>;
  downloadMedia?(mediaId: string): Promise<{ data: Buffer; mime: string }>;
}
