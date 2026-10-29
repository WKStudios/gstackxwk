import type { Services } from '../services';
import type { ToolDef } from './types';
import { coreTools } from './core';
import { automationTools } from './automation';
import { agentTools } from './agents';
import { browserTools } from './browser';
import { googleTools } from './google';
import { notionTools } from './notion';
import { phoneTools } from './phone';

/** Every tool this deployment can offer; integrations that aren't configured stay out of the list. */
export function buildTools(s: Services): ToolDef[] {
  const tools: ToolDef[] = [...coreTools, ...automationTools, ...agentTools, ...browserTools];
  if (s.google) tools.push(...googleTools);
  if (s.notion) tools.push(...notionTools);
  if (s.twilio) tools.push(...phoneTools);

  const unavailable = new Set<string>();
  if (!s.google) unavailable.add('watch_gmail');
  if (!s.media.canSpeak) unavailable.add('send_voice_note');
  if (!s.media.canImagine) unavailable.add('generate_image');

  const names = new Set<string>();
  for (const t of tools) {
    if (names.has(t.name)) throw new Error(`Duplicate tool name ${t.name}`);
    names.add(t.name);
  }
  return tools.filter(t => !unavailable.has(t.name));
}
