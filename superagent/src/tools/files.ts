import * as fs from 'fs';
import * as path from 'path';
import type { Store } from '../store';
import { ToolError } from './types';

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  xml: 'application/xml',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function mimeFor(filename: string): string {
  return MIME[path.extname(filename).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

export function extFor(mime: string): string {
  const found = Object.entries(MIME).find(([, m]) => m === mime.split(';')[0].trim());
  return found ? found[0] : 'bin';
}

export function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '-').slice(0, 120);
  return base && base !== '.' && base !== '..' ? base : 'file';
}

/**
 * Each conversation has its own files root. The owner's is the whole files
 * folder; a team member's is files/members/<id>, so their agent can't reach
 * the owner's attachments.
 */
export function filesRoot(store: Store, conversationId: string): string {
  if (conversationId === 'owner') return store.filesDir;
  const dir = path.join(store.filesDir, 'members', conversationId.replace(/[^\w-]+/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write into <root>/<sub>/, never outside it; avoids clobbering existing files. */
export function saveFile(root: string, sub: string, filename: string, data: Buffer | string): string {
  const dir = path.join(root, sub);
  fs.mkdirSync(dir, { recursive: true });
  const clean = safeName(filename);
  let target = path.join(dir, clean);
  if (fs.existsSync(target)) {
    const ext = path.extname(clean);
    target = path.join(dir, `${path.basename(clean, ext)}-${Date.now().toString(36)}${ext}`);
  }
  fs.writeFileSync(target, data);
  return target;
}

/** Resolve a model-supplied path; it must stay inside the conversation's files root. */
export function resolveFile(rootDir: string, p: string): string {
  const root = fs.realpathSync(rootDir);
  const candidate = path.isAbsolute(p) ? p : path.join(root, p);
  if (!fs.existsSync(candidate)) throw new ToolError(`No such file: ${p}`);
  const real = fs.realpathSync(candidate);
  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ToolError('Files must come from the agent files folder');
  return real;
}

export function relPath(root: string, p: string): string {
  return path.relative(root, p);
}
