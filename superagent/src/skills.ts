/**
 * Playbooks the agent reads on demand — the gstack idea of "skills are the
 * product", applied to a personal agent. Built-ins ship in superagent/skills/;
 * skills the agent writes for the owner live in <data>/skills/ and win on
 * name clashes.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface Skill {
  name: string;
  description: string;
  body: string;
  builtin: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

export function parseSkill(raw: string, fallbackName: string, builtin: boolean): Skill {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  let body = raw;
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
    body = m[2];
  }
  return {
    name: meta.name || fallbackName,
    description: meta.description || body.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '') || fallbackName,
    body: body.trim(),
    builtin,
  };
}

export class SkillLibrary {
  constructor(
    private readonly builtinDir: string,
    private readonly userDir: string,
  ) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  private readDir(dir: string, builtin: boolean): Skill[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .map(f => parseSkill(fs.readFileSync(path.join(dir, f), 'utf-8'), f.replace(/\.md$/, ''), builtin));
  }

  list(): Skill[] {
    const byName = new Map<string, Skill>();
    for (const s of this.readDir(this.builtinDir, true)) byName.set(s.name, s);
    for (const s of this.readDir(this.userDir, false)) byName.set(s.name, s);
    return [...byName.values()];
  }

  get(name: string): Skill | null {
    return this.list().find(s => s.name === name) ?? null;
  }

  save(name: string, description: string, body: string): Skill {
    if (!NAME_RE.test(name)) throw new Error('Skill names are lowercase letters, digits and dashes (2-49 chars)');
    const oneLine = description.replace(/\s+/g, ' ').trim();
    const content = `---\nname: ${name}\ndescription: ${oneLine}\n---\n\n${body.trim()}\n`;
    fs.writeFileSync(path.join(this.userDir, `${name}.md`), content);
    return parseSkill(content, name, false);
  }
}
