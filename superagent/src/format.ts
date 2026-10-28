/**
 * Claude writes Markdown; WhatsApp has its own lightweight syntax
 * (*bold*, _italic_, ~strike~, ```mono```). Convert, then split into
 * message-sized chunks on natural boundaries.
 */

export const WHATSAPP_TEXT_LIMIT = 4096;

const BOLD_OPEN = '\u0001';
const BOLD_CLOSE = '\u0002';

function convertProse(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let tableBuffer: string[] = [];

  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    // Tables don't render on WhatsApp; monospace keeps the columns aligned.
    const rows = tableBuffer.filter(l => !/^\s*\|?\s*:?-{2,}/.test(l));
    out.push('```', ...rows.map(r => r.trim()), '```');
    tableBuffer = [];
  };

  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      tableBuffer.push(line);
      continue;
    }
    flushTable();
    let l = line;
    // Headings → bold line
    l = l.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/, (_m, h) => `${BOLD_OPEN}${h.replace(/\*\*/g, '')}${BOLD_CLOSE}`);
    // Bullets → •  (before italics so "* item" isn't read as emphasis)
    l = l.replace(/^(\s*)[-*+]\s+/, (_m, indent) => `${indent}• `);
    // Horizontal rules
    if (/^\s*([-*_])\1{2,}\s*$/.test(l)) l = '';
    out.push(l);
  }
  flushTable();

  let result = out.join('\n');
  // Links: [text](url) → text (url)
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) =>
    label.trim() === url ? url : `${label} (${url})`,
  );
  // Bold **x** / __x__ → *x* (placeholders keep the converted markers out of later passes)
  result = result.replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);
  result = result.replace(/__(?!\s)([^_\n]+?)(?<!\s)__/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);
  // Single *x* is left alone: it's already WhatsApp bold, and Claude often means bold by it.
  // Strikethrough
  result = result.replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, '~$1~');
  return result.replaceAll(BOLD_OPEN, '*').replaceAll(BOLD_CLOSE, '*');
}

export function markdownToWhatsApp(markdown: string): string {
  // Leave fenced code untouched; WhatsApp renders ``` as monospace.
  const parts = markdown.split(/(```[\s\S]*?```)/g);
  return parts
    .map(part => (part.startsWith('```') ? part.replace(/^```[\w-]*\n/, '```\n') : convertProse(part)))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Split text into chunks ≤ limit, preferring paragraph, then line, then word boundaries. */
export function chunkText(text: string, limit = 3800): string[] {
  if (text.length <= limit) return text ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.4) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.4) cut = window.lastIndexOf(' ');
    if (cut < limit * 0.4) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** WhatsApp template parameters can't contain newlines, tabs or 4+ spaces. */
export function templateSafe(text: string, max = 900): string {
  const flat = text.replace(/[\t\n\r]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
