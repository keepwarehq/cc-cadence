export type Item =
  | { kind: 'user'; text: string; profile?: string; attachments?: { name: string; mediaType: string }[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; status: 'running' | 'ok' | 'error'; output?: string }
  | { kind: 'task'; taskId: string; toolUseId?: string; taskType: string; description: string; status: 'running' | 'ok' | 'error'; summary?: string; durationMs?: number; tokens?: number }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string; action?: 'checkTasks' };

/** Incremental ops sent to the webview; the webview replays them into the same items */
export type Op =
  | { op: 'reset'; items: Item[] }
  | { op: 'push'; item: Item }
  | { op: 'set'; index: number; item: Item }
  | { op: 'append'; index: number; text: string };

export class Transcript {
  items: Item[] = [];

  constructor(private readonly emit: (op: Op) => void = () => {}) {}

  reset(items: Item[] = []): void {
    this.items = items;
    this.emit({ op: 'reset', items });
  }

  push(item: Item): number {
    this.items.push(item);
    this.emit({ op: 'push', item });
    return this.items.length - 1;
  }

  set(index: number, item: Item): void {
    if (!this.items[index]) return; // a stale index (chat cleared mid-turn) must not corrupt the new items
    this.items[index] = item;
    this.emit({ op: 'set', index, item });
  }

  append(index: number, text: string): void {
    const it = this.items[index];
    if (!it || !('text' in it)) return;
    it.text += text;
    this.emit({ op: 'append', index, text });
  }
}

interface TaskUsage { total_tokens?: number; duration_ms?: number }

interface TaskEvent {
  subtype?: string;
  task_id?: string;
  tool_use_id?: string;
  task_type?: string;
  description?: string;
  status?: string;
  summary?: string;
  usage?: TaskUsage;
  tasks?: Array<{ task_id?: string }>;
}

export interface TurnHooks {
  init?(e: { sessionId?: string; model?: string; apiKeySource?: string; permissionMode?: string }): void;
  rateLimit?(info: any): void;
  result?(e: any): void;
}

const MAX_OUTPUT = 8000;

/** Translate one `claude -p --output-format stream-json` round into Transcript items */
export class TurnTranslator {
  sessionId?: string;
  gotResult = false;
  /** Count of alive background tasks from the last background_tasks_changed event */
  pendingTasks = 0;
  private detached = false;
  private readonly blockItem = new Map<number, number>(); // content block index within the current message → item index
  private readonly toolItem = new Map<string, number>();  // tool_use_id → item index
  private readonly taskItem = new Map<string, number>();  // task_id → item index
  private readonly streamed = new Set<string>();          // message ids that received stream_events

  constructor(private readonly t: Transcript, private readonly hooks: TurnHooks = {}) {}

  /** Called when the chat is cleared: later events are dropped so they never leak into the new session */
  detach(): void {
    this.detached = true;
  }

  handle(e: any): void {
    if (this.detached || !e || typeof e !== 'object') return;
    // system task events must pass even if they ever carry a parent tool id
    if (e.type === 'system') {
      this.onSystem(e);
      if (e.subtype !== 'init') return;
    } else if (e.parent_tool_use_id) {
      return; // subagent internals stay collapsed
    }
    switch (e.type) {
      case 'system':
        if (e.subtype === 'init') {
          this.sessionId = e.session_id;
          this.hooks.init?.({ sessionId: e.session_id, model: e.model, apiKeySource: e.apiKeySource, permissionMode: e.permissionMode });
        }
        break;
      case 'stream_event':
        this.onStream(e.event);
        break;
      case 'assistant':
        this.onAssistant(e.message);
        break;
      case 'user':
        this.onUser(e.message);
        break;
      case 'rate_limit_event':
        this.hooks.rateLimit?.(e.rate_limit_info);
        break;
      case 'result':
        this.gotResult = true;
        if (e.session_id) this.sessionId = e.session_id;
        this.hooks.result?.(e);
        break;
    }
  }

  /** After the process ends, mark tool cards and task cards still running as failed */
  finish(reason: string): void {
    if (this.detached) return;
    for (const i of this.toolItem.values()) {
      const it = this.t.items[i];
      if (it?.kind === 'tool' && it.status === 'running') this.t.set(i, { ...it, status: 'error', output: it.output ?? reason });
    }
    for (const i of this.taskItem.values()) {
      const it = this.t.items[i];
      if (it?.kind === 'task' && it.status === 'running') this.t.set(i, { ...it, status: 'error', summary: it.summary ?? reason });
    }
  }

  /** Push the user message together with its attachment metadata (names only, never base64) */
  setUserAttachments(text: string, attachments: { name: string; mediaType: string }[]): void {
    this.t.push(attachments.length ? { kind: 'user', text, attachments } : { kind: 'user', text });
  }

  private onSystem(e: TaskEvent): void {
    switch (e.subtype) {
      case 'task_started':
        this.upsertTask(e);
        break;
      case 'task_progress': {
        const i = e.task_id ? this.taskItem.get(e.task_id) : undefined;
        const it = i === undefined ? undefined : this.t.items[i];
        if (it?.kind === 'task') {
          this.t.set(i!, {
            ...it,
            description: e.description ?? it.description,
            durationMs: e.usage?.duration_ms ?? it.durationMs,
            tokens: e.usage?.total_tokens ?? it.tokens,
          });
        }
        break;
      }
      case 'task_notification': {
        const i = e.task_id ? this.taskItem.get(e.task_id) : undefined;
        const it = i === undefined ? undefined : this.t.items[i];
        if (it?.kind === 'task') {
          this.t.set(i!, {
            ...it,
            status: e.status === 'completed' ? 'ok' : 'error',
            summary: e.summary ?? it.summary,
            durationMs: e.usage?.duration_ms ?? it.durationMs,
            tokens: e.usage?.total_tokens ?? it.tokens,
          });
        }
        break;
      }
      case 'background_tasks_changed':
        this.pendingTasks = Array.isArray(e.tasks) ? e.tasks.length : 0;
        break;
    }
  }

  private upsertTask(e: TaskEvent): void {
    if (!e.task_id) return;
    const i = this.taskItem.get(e.task_id);
    const prev = i === undefined ? undefined : this.t.items[i];
    if (prev?.kind === 'task') {
      this.t.set(i!, { ...prev, description: e.description ?? prev.description });
      return;
    }
    this.taskItem.set(e.task_id, this.t.push({
      kind: 'task',
      taskId: e.task_id,
      toolUseId: typeof e.tool_use_id === 'string' ? e.tool_use_id : undefined,
      taskType: String(e.task_type ?? ''),
      description: String(e.description ?? ''),
      status: 'running',
      durationMs: e.usage?.duration_ms,
      tokens: e.usage?.total_tokens,
    }));
  }

  private onStream(ev: any): void {
    switch (ev?.type) {
      case 'message_start':
        this.blockItem.clear();
        if (ev.message?.id) this.streamed.add(ev.message.id);
        break;
      case 'content_block_start': {
        const b = ev.content_block ?? {};
        if (b.type === 'text') this.blockItem.set(ev.index, this.t.push({ kind: 'assistant', text: b.text ?? '' }));
        else if (b.type === 'thinking') this.blockItem.set(ev.index, this.t.push({ kind: 'thinking', text: b.thinking ?? '' }));
        else if (b.type === 'tool_use') this.upsertTool(b);
        break;
      }
      case 'content_block_delta': {
        const i = this.blockItem.get(ev.index);
        const d = ev.delta ?? {};
        if (i === undefined) break;
        if (d.type === 'text_delta' && d.text) this.t.append(i, d.text);
        else if (d.type === 'thinking_delta' && d.thinking) this.t.append(i, d.thinking);
        break;
      }
    }
  }

  private onAssistant(m: any): void {
    // Text already streamed token-by-token is not repeated; the full message is used only when no stream events arrived (fallback)
    const streamed = this.streamed.has(m?.id);
    for (const b of m?.content ?? []) {
      if (b?.type === 'tool_use') this.upsertTool(b);
      else if (streamed) continue;
      else if (b?.type === 'text' && b.text) this.t.push({ kind: 'assistant', text: b.text });
      else if (b?.type === 'thinking' && b.thinking) this.t.push({ kind: 'thinking', text: b.thinking });
    }
  }

  private onUser(m: any): void {
    if (!Array.isArray(m?.content)) return;
    for (const b of m.content) {
      if (b?.type !== 'tool_result') continue;
      const i = this.toolItem.get(b.tool_use_id);
      const it = i === undefined ? undefined : this.t.items[i];
      if (i === undefined || it?.kind !== 'tool') continue;
      this.t.set(i, { ...it, status: b.is_error ? 'error' : 'ok', output: resultText(b.content) });
    }
  }

  private upsertTool(b: any): void {
    const i = this.toolItem.get(b.id);
    const prev = i === undefined ? undefined : this.t.items[i];
    const summary = summarize(b.input);
    if (prev?.kind === 'tool') {
      if (summary && summary !== prev.summary) this.t.set(i!, { ...prev, summary });
      return;
    }
    this.toolItem.set(b.id, this.t.push({ kind: 'tool', id: b.id, name: String(b.name ?? 'tool'), summary, status: 'running' }));
  }
}

function summarize(input: any): string {
  if (!input || typeof input !== 'object' || !Object.keys(input).length) return '';
  const pick = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']
    .map(k => input[k])
    .find(v => typeof v === 'string' && v);
  return clip(pick ?? JSON.stringify(input), 300);
}

function resultText(content: any): string {
  if (typeof content === 'string') return clip(content, MAX_OUTPUT);
  if (!Array.isArray(content)) return '';
  const parts = content.map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : ''));
  return clip(parts.filter(Boolean).join('\n'), MAX_OUTPUT);
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
