/**
 * Gmail, Google Calendar and Google Drive over plain REST with an OAuth
 * refresh token. The owner connects once (/connect google → consent screen →
 * /oauth/google/callback); the refresh token lives in the local database.
 */

import * as crypto from 'crypto';
import type { Store } from '../store';
import { clock } from '../clock';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
  'openid',
  'email',
];

interface Tokens {
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
  email?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class GoogleAuthError extends Error {}

export interface EmailSummary {
  id: string;
  threadId: string;
  date: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  labels: string[];
  unread: boolean;
  bulk: boolean;
}

export interface EmailMessage extends EmailSummary {
  cc: string;
  messageIdHeader: string;
  body: string;
  attachments: { attachmentId: string; filename: string; mimeType: string; size: number }[];
}

export interface CalendarEvent {
  calendarId: string;
  calendarName: string;
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone?: string;
  location?: string;
  description?: string;
  meetLink?: string;
  organizerSelf: boolean;
  organizer?: string;
  attendees: { email: string; responseStatus?: string; self?: boolean }[];
  selfResponse?: string;
  transparent: boolean;
  status?: string;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function b64urlDecode(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function b64urlEncode(data: string | Buffer): string {
  return Buffer.from(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Encode a header value per RFC 2047 when it isn't plain ASCII. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
}

export function buildRawEmail(opts: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const headers = [
    `To: ${opts.to}`,
    opts.cc ? `Cc: ${opts.cc}` : '',
    opts.bcc ? `Bcc: ${opts.bcc}` : '',
    `Subject: ${encodeHeader(opts.subject)}`,
    opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : '',
    opts.references ? `References: ${opts.references}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  const body = Buffer.from(opts.body, 'utf-8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return b64urlEncode(`${headers.join('\r\n')}\r\n\r\n${body}`);
}

function header(headers: { name: string; value: string }[] | undefined, name: string): string {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function extractBody(payload: any): { text: string; attachments: EmailMessage['attachments'] } {
  let plain = '';
  let html = '';
  const attachments: EmailMessage['attachments'] = [];
  const walk = (part: any) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType,
        size: part.body.size ?? 0,
      });
    } else if (part.mimeType === 'text/plain' && part.body?.data && !plain) {
      plain = b64urlDecode(part.body.data).toString('utf-8');
    } else if (part.mimeType === 'text/html' && part.body?.data && !html) {
      html = b64urlDecode(part.body.data).toString('utf-8');
    }
    for (const p of part.parts ?? []) walk(p);
  };
  walk(payload);
  return { text: (plain || htmlToText(html)).trim(), attachments };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export class GoogleClient {
  constructor(
    private readonly cfg: { clientId: string; clientSecret: string },
    private readonly store: Store,
    private readonly redirectUri: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  // ─── OAuth ───────────────────────────────────────────────────

  isConnected(): boolean {
    return !!this.store.getJson<Tokens | null>('google:tokens', null)?.refresh_token;
  }

  connectedEmail(): string | null {
    return this.store.getJson<Tokens | null>('google:tokens', null)?.email ?? null;
  }

  /** A signed, single-use state value ties the callback to a /connect request. */
  authUrl(): string {
    const state = crypto.randomBytes(16).toString('hex');
    this.store.set(`google:oauth_state:${state}`, String(clock.now().getTime()));
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async handleCallback(code: string, state: string): Promise<string> {
    const issued = this.store.get(`google:oauth_state:${state}`);
    this.store.set(`google:oauth_state:${state}`, null);
    if (!issued || clock.now().getTime() - parseInt(issued, 10) > 30 * 60_000) {
      throw new GoogleAuthError('This sign-in link expired. Send /connect google again.');
    }
    const resp = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const json: any = await resp.json();
    if (!resp.ok || !json.refresh_token) {
      throw new GoogleAuthError(`Google sign-in failed: ${json.error_description || json.error || resp.status}`);
    }
    const tokens: Tokens = {
      refresh_token: json.refresh_token,
      access_token: json.access_token,
      expires_at: clock.now().getTime() + (json.expires_in ?? 3600) * 1000,
    };
    this.store.setJson('google:tokens', tokens);
    try {
      const me = await this.api('GET', 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
      tokens.email = me.emailAddress;
      this.store.setJson('google:tokens', tokens);
    } catch {}
    return tokens.email ?? 'your Google account';
  }

  disconnect() {
    this.store.set('google:tokens', null);
  }

  private async accessToken(force = false): Promise<string> {
    const tokens = this.store.getJson<Tokens | null>('google:tokens', null);
    if (!tokens?.refresh_token) throw new GoogleAuthError('Google is not connected. Send /connect google to link your account.');
    if (!force && tokens.access_token && (tokens.expires_at ?? 0) > clock.now().getTime() + 60_000) return tokens.access_token;
    const resp = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const json: any = await resp.json();
    if (!resp.ok) {
      if (json.error === 'invalid_grant') {
        throw new GoogleAuthError('Google access expired or was revoked. Send /connect google to reconnect.');
      }
      throw new Error(`Google token refresh failed: ${json.error_description || json.error || resp.status}`);
    }
    tokens.access_token = json.access_token;
    tokens.expires_at = clock.now().getTime() + (json.expires_in ?? 3600) * 1000;
    this.store.setJson('google:tokens', tokens);
    return tokens.access_token!;
  }

  private async request(method: string, url: string, body?: unknown, retried = false): Promise<Response> {
    const token = await this.accessToken(retried);
    const resp = await this.fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (resp.status === 401 && !retried) return this.request(method, url, body, true);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let message = text;
      try {
        message = JSON.parse(text).error?.message ?? text;
      } catch {}
      throw new Error(`Google API ${resp.status}: ${message.slice(0, 400)}`);
    }
    return resp;
  }

  async api(method: string, url: string, body?: unknown): Promise<any> {
    const resp = await this.request(method, url, body);
    if (resp.status === 204) return {};
    const text = await resp.text();
    return text ? JSON.parse(text) : {};
  }

  // ─── Gmail ───────────────────────────────────────────────────

  private gmail(p: string) {
    return `https://gmail.googleapis.com/gmail/v1/users/me/${p}`;
  }

  private toSummary(m: any): EmailSummary {
    const h = m.payload?.headers;
    return {
      id: m.id,
      threadId: m.threadId,
      date: header(h, 'Date'),
      from: header(h, 'From'),
      to: header(h, 'To'),
      subject: header(h, 'Subject') || '(no subject)',
      snippet: (m.snippet ?? '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
      labels: m.labelIds ?? [],
      unread: (m.labelIds ?? []).includes('UNREAD'),
      bulk: !!header(h, 'List-Unsubscribe') || /no-?reply|newsletter|notifications?@|news@|updates@/i.test(header(h, 'From')),
    };
  }

  async searchEmail(query: string, max = 15): Promise<EmailSummary[]> {
    const list = await this.api('GET', this.gmail(`messages?${new URLSearchParams({ q: query, maxResults: String(Math.min(max, 50)) })}`));
    const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
    const fields = ['From', 'To', 'Subject', 'Date', 'List-Unsubscribe'].map(h => `metadataHeaders=${h}`).join('&');
    return mapLimit(ids, 6, async id => this.toSummary(await this.api('GET', this.gmail(`messages/${id}?format=metadata&${fields}`))));
  }

  async getThread(threadId: string): Promise<EmailMessage[]> {
    const thread = await this.api('GET', this.gmail(`threads/${threadId}?format=full`));
    return (thread.messages ?? []).map((m: any) => {
      const { text, attachments } = extractBody(m.payload);
      return {
        ...this.toSummary(m),
        cc: header(m.payload?.headers, 'Cc'),
        messageIdHeader: header(m.payload?.headers, 'Message-ID'),
        body: text,
        attachments,
      };
    });
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const json = await this.api('GET', this.gmail(`messages/${messageId}/attachments/${attachmentId}`));
    return b64urlDecode(json.data ?? '');
  }

  async createDraft(opts: { to: string; cc?: string; bcc?: string; subject: string; body: string; replyToMessageId?: string }) {
    let threadId: string | undefined;
    let inReplyTo: string | undefined;
    let references: string | undefined;
    let subject = opts.subject;
    if (opts.replyToMessageId) {
      const orig = await this.api(
        'GET',
        this.gmail(`messages/${opts.replyToMessageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`),
      );
      threadId = orig.threadId;
      inReplyTo = header(orig.payload?.headers, 'Message-ID') || undefined;
      references = [header(orig.payload?.headers, 'References'), inReplyTo].filter(Boolean).join(' ') || undefined;
      const origSubject = header(orig.payload?.headers, 'Subject');
      if (!subject && origSubject) subject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
    }
    const raw = buildRawEmail({ ...opts, subject: subject || '(no subject)', inReplyTo, references });
    const draft = await this.api('POST', this.gmail('drafts'), { message: { raw, ...(threadId ? { threadId } : {}) } });
    return { draftId: draft.id as string, messageId: draft.message?.id as string, threadId: draft.message?.threadId as string };
  }

  async getDraft(draftId: string): Promise<{ to: string; cc: string; subject: string; body: string }> {
    const d = await this.api('GET', this.gmail(`drafts/${draftId}?format=full`));
    const h = d.message?.payload?.headers;
    return { to: header(h, 'To'), cc: header(h, 'Cc'), subject: header(h, 'Subject'), body: extractBody(d.message?.payload).text };
  }

  async sendDraft(draftId: string) {
    const sent = await this.api('POST', this.gmail('drafts/send'), { id: draftId });
    return { messageId: sent.id as string, threadId: sent.threadId as string };
  }

  async listLabels(): Promise<{ id: string; name: string; type: string }[]> {
    const json = await this.api('GET', this.gmail('labels'));
    return json.labels ?? [];
  }

  async createLabel(name: string) {
    return this.api('POST', this.gmail('labels'), { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
  }

  private async labelIds(names: string[]): Promise<string[]> {
    if (!names.length) return [];
    const labels = await this.listLabels();
    return names.map(n => {
      const upper = n.toUpperCase();
      const found = labels.find(l => l.name.toLowerCase() === n.toLowerCase() || l.id === upper);
      if (!found) throw new Error(`No Gmail label named "${n}" (create it first)`);
      return found.id;
    });
  }

  async modifyThreads(threadIds: string[], add: string[], remove: string[]) {
    const addLabelIds = await this.labelIds(add);
    const removeLabelIds = await this.labelIds(remove);
    await mapLimit(threadIds, 4, id => this.api('POST', this.gmail(`threads/${id}/modify`), { addLabelIds, removeLabelIds }));
  }

  async trashThread(threadId: string) {
    await this.api('POST', this.gmail(`threads/${threadId}/trash`));
  }

  // ─── Calendar ────────────────────────────────────────────────

  private cal(p: string) {
    return `https://www.googleapis.com/calendar/v3/${p}`;
  }

  async listCalendars(): Promise<{ id: string; summary: string; primary: boolean; timeZone: string; accessRole: string }[]> {
    const json = await this.api('GET', this.cal('users/me/calendarList?maxResults=50'));
    return (json.items ?? [])
      .filter((c: any) => !c.hidden)
      .map((c: any) => ({ id: c.id, summary: c.summaryOverride || c.summary, primary: !!c.primary, timeZone: c.timeZone, accessRole: c.accessRole }));
  }

  private toEvent(calendarId: string, calendarName: string, e: any): CalendarEvent {
    const allDay = !!e.start?.date;
    const self = (e.attendees ?? []).find((a: any) => a.self);
    return {
      calendarId,
      calendarName,
      id: e.id,
      summary: e.summary || '(no title)',
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      allDay,
      timeZone: e.start?.timeZone,
      location: e.location,
      description: e.description ? htmlToText(e.description).slice(0, 500) : undefined,
      meetLink: e.hangoutLink || e.conferenceData?.entryPoints?.find((p: any) => p.entryPointType === 'video')?.uri,
      organizerSelf: !!e.organizer?.self,
      organizer: e.organizer?.email,
      attendees: (e.attendees ?? []).map((a: any) => ({ email: a.email, responseStatus: a.responseStatus, self: a.self })),
      selfResponse: self?.responseStatus,
      transparent: e.transparency === 'transparent',
      status: e.status,
    };
  }

  async listEvents(timeMin: string, timeMax: string, calendarIds?: string[], query?: string): Promise<CalendarEvent[]> {
    const calendars = await this.listCalendars();
    const chosen = calendarIds?.length ? calendars.filter(c => calendarIds.includes(c.id)) : calendars;
    const lists = await mapLimit(chosen.slice(0, 15), 4, async c => {
      const params = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '150' });
      if (query) params.set('q', query);
      try {
        const json = await this.api('GET', this.cal(`calendars/${encodeURIComponent(c.id)}/events?${params}`));
        return (json.items ?? []).filter((e: any) => e.status !== 'cancelled').map((e: any) => this.toEvent(c.id, c.summary, e));
      } catch {
        return [] as CalendarEvent[];
      }
    });
    return lists.flat().sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  }

  async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
    const e = await this.api('GET', this.cal(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`));
    return this.toEvent(calendarId, calendarId, e);
  }

  async createEvent(calendarId: string, body: Record<string, unknown>, opts: { notify: boolean; meet: boolean }) {
    const params = new URLSearchParams({ sendUpdates: opts.notify ? 'all' : 'none' });
    if (opts.meet) params.set('conferenceDataVersion', '1');
    const payload = opts.meet
      ? { ...body, conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } }
      : body;
    const e = await this.api('POST', this.cal(`calendars/${encodeURIComponent(calendarId)}/events?${params}`), payload);
    return this.toEvent(calendarId, calendarId, e);
  }

  async patchEvent(calendarId: string, eventId: string, patch: Record<string, unknown>, notify: boolean) {
    const e = await this.api(
      'PATCH',
      this.cal(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${notify ? 'all' : 'none'}`),
      patch,
    );
    return this.toEvent(calendarId, calendarId, e);
  }

  async deleteEvent(calendarId: string, eventId: string, notify: boolean) {
    await this.api(
      'DELETE',
      this.cal(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${notify ? 'all' : 'none'}`),
    );
  }

  // ─── Drive ───────────────────────────────────────────────────

  async searchDrive(query: string, max = 15) {
    const raw = /[=<>]| in | contains /.test(query);
    const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = raw ? query : `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`;
    const params = new URLSearchParams({
      q,
      pageSize: String(Math.min(max, 50)),
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size,owners(displayName))',
      orderBy: raw ? 'modifiedTime desc' : '',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (!raw) params.delete('orderBy');
    const json = await this.api('GET', `https://www.googleapis.com/drive/v3/files?${params}`);
    return (json.files ?? []) as { id: string; name: string; mimeType: string; modifiedTime: string; webViewLink: string; size?: string }[];
  }

  async driveFile(fileId: string): Promise<{ name: string; mimeType: string; webViewLink?: string; text?: string; data?: Buffer }> {
    const meta = await this.api(
      'GET',
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,webViewLink,size&supportsAllDrives=true`,
    );
    const exports: Record<string, string> = {
      'application/vnd.google-apps.document': 'text/plain',
      'application/vnd.google-apps.spreadsheet': 'text/csv',
      'application/vnd.google-apps.presentation': 'text/plain',
    };
    if (exports[meta.mimeType]) {
      const resp = await this.request(
        'GET',
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exports[meta.mimeType])}`,
      );
      return { name: meta.name, mimeType: meta.mimeType, webViewLink: meta.webViewLink, text: await resp.text() };
    }
    if (meta.mimeType?.startsWith('application/vnd.google-apps')) {
      return { name: meta.name, mimeType: meta.mimeType, webViewLink: meta.webViewLink, text: '(This Google file type cannot be exported as text.)' };
    }
    const resp = await this.request('GET', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
    const data = Buffer.from(await resp.arrayBuffer());
    return { name: meta.name, mimeType: meta.mimeType, webViewLink: meta.webViewLink, data };
  }
}
