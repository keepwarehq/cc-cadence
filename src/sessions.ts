import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { Attachment, Item } from './transcript';

export interface SessionSummary { sessionId: string; title: string; mtimeMs: number; sizeBytes: number }

/** The CLI's own config dir; CLAUDE_CONFIG_DIR relocates it (same rule doctor.ts uses) */
export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** claude slugs a cwd by replacing every non-alphanumeric character with a dash */
export function slugFor(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

/** The CLI's session store for a cwd. claude slugs its process.cwd(), which resolves symlinks (/var → /private/var),
 * so a workspace opened through a symlinked path must be resolved the same way */
export function projectDir(cwd: string): string {
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* gone or virtual: as given */ }
  return path.join(configDir(), 'projects', slugFor(real));
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

/** A main-chain user turn's typed text: a plain string, or the text blocks of an attachment send (tool results have none) */
const userText = (r: SessionRecord): string | undefined => {
  if (r.type !== 'user' || r.isSidechain) return undefined;
  const c = r.message?.content;
  if (typeof c === 'string') return c.trim() ? c : undefined;
  if (!Array.isArray(c)) return undefined;
  const text = (c as Array<Record<string, unknown>>)
    .map(b => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
  return text.trim() ? text : undefined;
};

const aiTitleOf = (r: SessionRecord): string | undefined =>
  r.type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle.trim() ? r.aiTitle.trim() : undefined;

/** A session's JSONL file in the CLI's project store */
export function sessionPath(sessionId: string, cwd: string): string {
  return path.join(projectDir(cwd), `${sessionId}.jsonl`);
}

/** One pass over a session file: its ai-title (the first one; the CLI re-appends the same record) and first user text */
export async function readSessionTitle(sessionId: string, cwd: string): Promise<{ aiTitle?: string; firstText?: string }> {
  let aiTitle: string | undefined;
  let firstText: string | undefined;
  try {
    await firstLineMatching(sessionPath(sessionId, cwd), r => {
      aiTitle ??= aiTitleOf(r);
      firstText ??= userText(r);
      return aiTitle;
    });
  } catch { /* missing or unreadable: no title */ }
  return { aiTitle, firstText };
}

/**
 * Record a generated title the way the CLI does — an ai-title line appended to the session file — so the history
 * list, revived tabs and `claude --resume` all pick it up. Never creates the file: a session that has not been
 * written yet is retried later by the caller. The CLI also only ever appends (O_APPEND), so a one-line write cannot
 * interleave with its own lines.
 */
export async function appendAiTitle(sessionId: string, cwd: string, title: string): Promise<boolean> {
  const file = sessionPath(sessionId, cwd);
  let endsWithNewline: boolean;
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const { size } = await fh.stat();
      if (!size) return false;
      const last = Buffer.alloc(1);
      await fh.read(last, 0, 1, size - 1);
      endsWithNewline = last[0] === 0x0a;
    } finally {
      await fh.close();
    }
    // O_APPEND: lands at the end even if the CLI appended meanwhile
    const line = JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId }) + '\n';
    await fsp.appendFile(file, (endsWithNewline ? '' : '\n') + line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** List the cwd's sessions, newest first; sessions without any user text are skipped */
export async function listSessions(cwd: string): Promise<SessionSummary[]> {
  const dir = projectDir(cwd);
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter(n => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const name of names) {
    const st = await fsp.stat(path.join(dir, name));
    if (!st.isFile()) continue;
    const sessionId = name.slice(0, -'.jsonl'.length);
    // the ai-title, else the first user text clipped; sessions with neither are skipped
    const t = await readSessionTitle(sessionId, cwd);
    const title = t.aiTitle ?? (t.firstText === undefined ? undefined : fallbackTitle(t.firstText));
    if (title === undefined) continue;
    out.push({ sessionId, title, mtimeMs: st.mtimeMs, sizeBytes: st.size });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The title a session shows until (or unless) the fast model names it: its first message, on one line, clipped */
export function fallbackTitle(firstText: string): string {
  return clip(firstText.replace(/\s+/g, ' ').trim(), 60);
}

/**
 * Replay a stored session into display items; sidechain records are skipped.
 * onImage, when given, receives each base64 image block of a user turn and returns its preview-store file name;
 * images it declines (or every image, without it) are noted as "[N images attached]" text instead.
 */
export async function readTranscript(
  sessionId: string,
  cwd: string,
  onImage?: (mediaType: string, base64: string) => string | undefined,
): Promise<Item[]> {
  const file = sessionPath(sessionId, cwd);
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  return parseTranscript(text, { onImage });
}

/** Where the CLI keeps a subagent's own transcript (an agent task's output file is a symlink to it) */
export function subagentTranscriptPath(sessionId: string, cwd: string, agentId: string): string {
  return path.join(projectDir(cwd), sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

/** Replay a subagent's transcript (its prompt, tool calls and replies) for the task detail panel; [] when absent */
export async function readSubagentTranscript(sessionId: string, cwd: string, agentId: string): Promise<Item[]> {
  let text: string;
  try {
    text = await fsp.readFile(subagentTranscriptPath(sessionId, cwd, agentId), 'utf8');
  } catch {
    return [];
  }
  return parseTranscript(text, { sidechain: true });
}

/**
 * Session-format JSONL → display items. Sidechain records (subagent internals inside a main session) are skipped,
 * unless `sidechain` is set: a subagent's own transcript consists of nothing else.
 */
export function parseTranscript(
  text: string,
  opts: { onImage?: (mediaType: string, base64: string) => string | undefined; sidechain?: boolean } = {},
): Item[] {
  const { onImage } = opts;
  const items: Item[] = [];
  const toolAt = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let v: unknown;
    try { v = JSON.parse(line); } catch { continue; }
    if (!isRecord(v) || (v.isSidechain && !opts.sidechain)) continue;
    const content = v.message?.content;
    if (v.type === 'user') {
      if (typeof content === 'string' && content.trim()) {
        items.push({ kind: 'user', text: content });
      } else if (Array.isArray(content)) {
        // block-array user turns (attachment sends, pasted images): join text parts, note images
        const texts: string[] = [];
        const shown: Attachment[] = [];
        let images = 0;
        for (const b of content as Array<Record<string, unknown>>) {
          if (b?.type === 'text' && typeof b.text === 'string' && b.text) texts.push(b.text);
          else if (b?.type === 'image') {
            images++;
            const src = b.source as Record<string, unknown> | undefined;
            const file = onImage && src?.type === 'base64' && typeof src.media_type === 'string' && typeof src.data === 'string'
              ? onImage(src.media_type, src.data)
              : undefined;
            if (file) shown.push({ name: `image-${shown.length + 1}.${file.split('.').pop()}`, mediaType: String(src!.media_type), file });
          }
        }
        const unshown = images - shown.length;
        if (texts.length || images) {
          const text = texts.join('\n') + (unshown ? `${texts.length ? '\n' : ''}[${unshown} image${unshown === 1 ? '' : 's'} attached]` : '');
          items.push(shown.length ? { kind: 'user', text, attachments: shown } : { kind: 'user', text });
        }
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
  const file = sessionPath(sessionId, cwd);
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
