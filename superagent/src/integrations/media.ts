/**
 * Speech-to-text, text-to-speech and image generation. Claude doesn't do
 * these, so they go to any OpenAI-compatible endpoint (OpenAI, Groq, a local
 * Whisper server, …). Each one is optional.
 */

import type { Config, OpenAICompatibleProvider } from '../config';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function extFor(mime: string): string {
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('amr')) return 'amr';
  return 'ogg';
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class MediaProviders {
  constructor(
    private readonly config: Pick<Config, 'stt' | 'tts' | 'images'>,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get canTranscribe() {
    return !!this.config.stt;
  }
  get canSpeak() {
    return !!this.config.tts;
  }
  get canImagine() {
    return !!this.config.images;
  }

  private async post(p: OpenAICompatibleProvider, pathname: string, body: BodyInit, json: boolean): Promise<Response> {
    const resp = await this.fetchImpl(`${p.baseUrl}${pathname}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${p.apiKey}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`${pathname} failed (${resp.status}): ${text.slice(0, 300)}`);
    }
    return resp;
  }

  async transcribe(data: Buffer, mime: string): Promise<string> {
    const p = this.config.stt;
    if (!p) throw new Error('Voice transcription is not configured (set STT_API_KEY or OPENAI_API_KEY)');
    if (data.length > MAX_AUDIO_BYTES) throw new Error('Audio is larger than 25MB; send a shorter clip');
    const form = new FormData();
    form.append('model', p.model);
    form.append('file', new Blob([new Uint8Array(data)], { type: mime }), `voice.${extFor(mime)}`);
    const resp = await this.post(p, '/audio/transcriptions', form, false);
    const json: any = await resp.json();
    return String(json.text ?? '').trim();
  }

  /** Returns OGG/Opus bytes — the format WhatsApp plays as a voice note. */
  async speak(text: string): Promise<Buffer> {
    const p = this.config.tts;
    if (!p) throw new Error('Voice replies are not configured (set TTS_API_KEY or OPENAI_API_KEY)');
    const resp = await this.post(
      p,
      '/audio/speech',
      JSON.stringify({ model: p.model, voice: p.voice, input: text.slice(0, 4000), response_format: 'opus' }),
      true,
    );
    return Buffer.from(await resp.arrayBuffer());
  }

  async generateImage(prompt: string, size: string): Promise<Buffer> {
    const p = this.config.images;
    if (!p) throw new Error('Image generation is not configured (set IMAGE_API_KEY or OPENAI_API_KEY)');
    const resp = await this.post(p, '/images/generations', JSON.stringify({ model: p.model, prompt, size, n: 1 }), true);
    const json: any = await resp.json();
    const item = json.data?.[0];
    if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
    if (item?.url) {
      const img = await this.fetchImpl(item.url);
      if (!img.ok) throw new Error(`Could not download generated image (${img.status})`);
      return Buffer.from(await img.arrayBuffer());
    }
    throw new Error('Image provider returned no image');
  }
}
