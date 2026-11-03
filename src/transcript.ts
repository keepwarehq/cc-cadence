export type Item =
  | { kind: 'user'; text: string; profile?: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; status: 'running' | 'ok' | 'error'; output?: string }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

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
  private detached = false;
  private readonly blockItem = new Map<number, number>(); // content block index within the current message → item index
  private readonly toolItem = new Map<string, number>();  // tool_use_id → item index
  private readonly streamed = new Set<string>();          // message ids that received stream_events

  constructor(private readonly t: Transcript, private readonly hooks: TurnHooks = {}) {}

  /** Called when the chat is cleared: later events are dropped so they never leak into the new session */
  detach(): void {
    this.detached = true;
  }

  handle(e: any): void {
    if (this.detached || !e || typeof e !== 'object') return;
    if (e.parent_tool_use_id) return; // subagent internals stay collapsed
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

  /** After the process ends, mark tool cards still running as failed */
  finish(reason: string): void {
    if (this.detached) return;
    for (const i of this.toolItem.values()) {
      const it = this.t.items[i];
      if (it?.kind === 'tool' && it.status === 'running') this.t.set(i, { ...it, status: 'error', output: it.output ?? reason });
    }
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
