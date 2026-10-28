/** In-flight background work (sub-agent batches), so "stop all" can cancel it and /status can count it. */

export interface BackgroundTask {
  id: string;
  conversationId: string;
  label: string;
  startedAt: Date;
  controller: AbortController;
}

let seq = 0;
const tasks = new Map<string, BackgroundTask>();

export function startBackground(conversationId: string, label: string): BackgroundTask {
  const task: BackgroundTask = {
    id: `bg${++seq}`,
    conversationId,
    label,
    startedAt: new Date(),
    controller: new AbortController(),
  };
  tasks.set(task.id, task);
  return task;
}

export function finishBackground(id: string) {
  tasks.delete(id);
}

export function listBackground(conversationId?: string): BackgroundTask[] {
  return [...tasks.values()].filter(t => !conversationId || t.conversationId === conversationId);
}

export function stopBackground(conversationId: string): number {
  const mine = listBackground(conversationId);
  for (const t of mine) {
    t.controller.abort();
    tasks.delete(t.id);
  }
  return mine.length;
}
