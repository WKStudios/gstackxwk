/**
 * Turn a batch of chat messages (text, photos, voice notes, documents,
 * locations…) into one user turn for Claude. Media is saved to the files
 * folder so the agent can forward, file or re-read it later.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Services } from './services';
import type { InboundMessage } from './channels/types';
import { extFor, filesRoot, relPath, saveFile } from './tools/files';
import { formatShort } from './clock';
import { truncate } from './format';
import { logger, errorMessage } from './log';

const log = logger('inbound');

type Block = Anthropic.Beta.Messages.BetaContentBlockParam;

export interface UserTurn {
  content: Block[];
  /** Plain text for the searchable transcript. */
  transcript: string;
  hadVoice: boolean;
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const TEXT_MIME = /^text\/|json|xml|csv|calendar|vcard|javascript|yaml/;

async function mediaBytes(s: Services, msg: InboundMessage): Promise<Buffer> {
  if (msg.media?.data) return msg.media.data;
  const ch = s.channels.get(msg.channel);
  if (!msg.media?.id || !ch?.downloadMedia) throw new Error('media not available');
  return (await ch.downloadMedia(msg.media.id)).data;
}

export async function buildUserTurn(s: Services, conversationId: string, msgs: InboundMessage[]): Promise<UserTurn> {
  const { store, config, media } = s;
  const root = filesRoot(store, conversationId);
  const content: Block[] = [];
  const transcript: string[] = [];
  let hadVoice = false;
  const multi = msgs.length > 1;

  const text = (t: string) => {
    content.push({ type: 'text', text: t });
    transcript.push(t);
  };

  for (const msg of msgs) {
    const stamp = multi ? `[${formatShort(msg.timestamp, config.timezone, false)}] ` : '';
    if (msg.replyToId) {
      const quoted = store.outboundText(msg.replyToId);
      if (quoted) content.push({ type: 'text', text: `↩️ (replying to your message: "${truncate(quoted, 600)}")` });
    }

    try {
      switch (msg.type) {
        case 'text':
        case 'button':
        case 'contacts':
        case 'unsupported':
          if (msg.text) text(`${stamp}${msg.type === 'button' ? `[tapped "${msg.text}"]` : msg.text}`);
          break;

        case 'location': {
          const l = msg.location!;
          text(
            `${stamp}📍 Shared location: ${[l.name, l.address].filter(Boolean).join(', ') || 'pin'} (${l.latitude}, ${l.longitude}) https://maps.google.com/?q=${l.latitude},${l.longitude}`,
          );
          break;
        }

        case 'image':
        case 'sticker': {
          if (msg.type === 'sticker') {
            text(`${stamp}[sent a sticker]`);
            break;
          }
          const data = await mediaBytes(s, msg);
          const mime = msg.media!.mime.split(';')[0];
          const file = saveFile(root, 'inbox', `photo-${Date.now()}.${extFor(mime)}`, data);
          if (IMAGE_MIMES.has(mime) && data.length <= 5 * 1024 * 1024) {
            content.push({ type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg', data: data.toString('base64') } });
          }
          text(`${stamp}📷 Photo (saved as ${relPath(root, file)})${msg.media?.caption ? `: ${msg.media.caption}` : ''}`);
          break;
        }

        case 'audio': {
          hadVoice = true;
          const data = await mediaBytes(s, msg);
          const ext = extFor(msg.media!.mime.split(';')[0]);
          const file = saveFile(root, 'inbox', `voice-${Date.now()}.${ext === 'bin' ? 'ogg' : ext}`, data);
          if (!media.canTranscribe) {
            text(`${stamp}🎤 Voice note received (saved as ${relPath(root, file)}), but transcription isn't configured. Ask them to type it or set up STT.`);
            break;
          }
          const said = await media.transcribe(data, msg.media!.mime);
          text(`${stamp}🎤 Voice note (transcribed): ${said || '(silence)'}`);
          break;
        }

        case 'document': {
          const data = await mediaBytes(s, msg);
          const mime = msg.media!.mime.split(';')[0];
          const name = msg.media!.filename || `document-${Date.now()}.${extFor(mime)}`;
          const file = saveFile(root, 'inbox', name, data);
          const rel = relPath(root, file);
          const caption = msg.media?.caption ? `: ${msg.media.caption}` : '';
          if (mime === 'application/pdf' && data.length <= 30 * 1024 * 1024) {
            content.push({
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') },
              title: name,
            });
            text(`${stamp}📄 PDF "${name}" (saved as ${rel})${caption}`);
          } else if (IMAGE_MIMES.has(mime) && data.length <= 5 * 1024 * 1024) {
            content.push({ type: 'image', source: { type: 'base64', media_type: mime as 'image/png', data: data.toString('base64') } });
            text(`${stamp}🖼️ Image file "${name}" (saved as ${rel})${caption}`);
          } else if (TEXT_MIME.test(mime) || /\.(txt|md|csv|json|ics|vcf|html?|xml|ya?ml|log)$/i.test(name)) {
            text(`${stamp}📄 File "${name}" (saved as ${rel})${caption}:\n<document name="${name}">\n${truncate(data.toString('utf-8'), 150_000)}\n</document>`);
          } else {
            text(`${stamp}📎 File "${name}" (${mime}, ${Math.ceil(data.length / 1024)} KB, saved as ${rel})${caption}. Use run_code with this file to open it.`);
          }
          break;
        }

        case 'video': {
          const data = await mediaBytes(s, msg);
          const file = saveFile(root, 'inbox', `video-${Date.now()}.mp4`, data);
          text(`${stamp}🎬 Video (saved as ${relPath(root, file)}; you can't watch video directly)${msg.media?.caption ? `: ${msg.media.caption}` : ''}`);
          break;
        }

        case 'reaction':
          break;
      }
    } catch (err) {
      log.warn(`could not process ${msg.type} message`, err);
      text(`${stamp}[${msg.type} received but couldn't be processed: ${errorMessage(err)}]`);
    }
  }

  if (content.length === 0) text('(empty message)');
  return { content, transcript: transcript.join('\n'), hadVoice };
}
