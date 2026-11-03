import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { Item } from './transcript';

export interface SessionSummary { sessionId: string; title: string; mtimeMs: number; sizeBytes: number }

/** The CLI's own config dir; CLAUDE_CONFIG_DIR relocates it (same rule doctor.ts uses) */
export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** claude slugs a cwd by replacing every non-alphanumeric character with a dash */
export function slugFor(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

/** One record of a session JSONL, as far as the panel cares */
interface SessionRecord {
  type?: string;
  subtype?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  aiTitle?: string;
  message?: { role?: string; content?: unknown };
}

const isRecord = (v: unknown): v is SessionRecord =>
  !!v && typeof v === 'object' && !Array.isArray(v);

async function firstLineMatching(file: string, match: (r: SessionRecord) => string | undefined): Promise<string | undefined> {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let v: unknown;
      try { v = JSON.parse(line); } catch { continue; }
      if (!isRecord(v)) continue;
      const t = match(v);
      if (t !== undefined) return t;
    }
  } finally {
    rl.close();
  }
  return undefined;
}

const userText = (r: SessionRecord): string | undefined => {
  if (r.type !== 'user' || r.isSidechain) return undefined;
  const c = r.message?.content;
  return typeof c === 'string' && c.trim() ? c : undefined;
};

/** List the cwd's sessions, newest first; sessions without any user text are skipped */
export async function listSessions(cwd: string): Promise<SessionSummary[]> {
  const dir = path.join(configDir(), 'projects', slugFor(cwd));
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter(n => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const st = await fsp.stat(file);
    if (!st.isFile()) continue;
    const sessionId = name.slice(0, -'.jsonl'.length);
    const title = await firstLineMatching(file, r =>
      r.type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle.trim() ? r.aiTitle : undefined) ?? '';
    out.push({ sessionId, title, mtimeMs: st.mtimeMs, sizeBytes: st.size });
  }
  // second pass for the title fallback: first user text, clipped; sessions without user text are skipped
  const withText: SessionSummary[] = [];
  for (const s of out) {
    if (s.title) { withText.push(s); continue; }
    const file = path.join(dir, s.sessionId + '.jsonl');
    const first = await firstLineMatching(file, userText);
    if (first === undefined) continue;
    s.title = clip(first, 60);
    withText.push(s);
  }
  return withText.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Replay a stored session into display items; sidechain records are skipped */
export async function readTranscript(sessionId: string, cwd: string): Promise<Item[]> {
  const file = path.join(configDir(), 'projects', slugFor(cwd), `${sessionId}.jsonl`);
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const items: Item[] = [];
  const toolAt = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let v: unknown;
    try { v = JSON.parse(line); } catch { continue; }
    if (!isRecord(v) || v.isSidechain) continue;
    const content = v.message?.content;
    if (v.type === 'user') {
      if (typeof content === 'string' && content.trim()) {
        items.push({ kind: 'user', text: content });
      } else if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          const id: string = b.tool_use_id;
          const i = toolAt.get(id);
          if (i === undefined) continue;
          const it = items[i];
          if (it?.kind !== 'tool') continue;
          items[i] = { ...it, status: b.is_error ? 'error' : 'ok', output: resultText(b.content) };
        }
      }
    } else if (v.type === 'assistant' && Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text) {
          items.push({ kind: 'assistant', text: b.text });
        } else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
          items.push({ kind: 'thinking', text: b.thinking });
        } else if (b?.type === 'tool_use' && typeof b.id === 'string') {
          toolAt.set(b.id, items.length);
          items.push({ kind: 'tool', id: b.id, name: String(b.name ?? 'tool'), summary: summarize(b.input), status: 'ok' });
        }
      }
    }
  }
  return items;
}

/** Delete a session's JSONL file */
export async function deleteSession(sessionId: string, cwd: string): Promise<void> {
  const file = path.join(configDir(), 'projects', slugFor(cwd), `${sessionId}.jsonl`);
  await fsp.rm(file, { force: true });
}

function clip(s: string, n: number): string {
  return n > 0 && s.length > n ? s.slice(0, n) + '…' : s;
}

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object' || !Object.keys(input).length) return '';
  const rec = input as Record<string, unknown>;
  const pick = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']
    .map(k => rec[k])
    .find((v): v is string => typeof v === 'string' && !!v);
  return clip(pick ?? JSON.stringify(input), 300);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = (content as Array<Record<string, unknown>>)
    .map(c => (c?.type === 'text' && typeof c.text === 'string' ? c.text : c?.type === 'image' ? '[image]' : ''));
  return parts.filter(Boolean).join('\n');
}
