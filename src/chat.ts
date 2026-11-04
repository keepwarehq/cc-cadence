import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Attachment, Item, Transcript, TurnTranslator } from './transcript';
import { DEFAULT_MODEL, PERMISSION_MODES, effortChoices, PermissionMode, Profile, buildEnv, expandHome, isThirdParty, loadProfiles, modelChoices, resolveModel } from './profiles';
import { TurnHandle, runTurn } from './runner';
import { addProfile, keyName, manageProfiles, setApiKey } from './profileUi';
import { deleteSession, listSessions, parseTranscript, readSubagentTranscript, readTranscript } from './sessions';
import { SettingsFile, writeSettingsFile } from './settingsFile';
import { MAX_IMAGE_BYTES, buildBlocks, classifyAttachment, imageFileName, isImageType, nextAttachmentId, stagedName } from './attachments';
import { resultNotice } from './turnResult';

const CHAT_KEY = 'ccprofile.chat';
const ACTIVE_KEY = 'ccprofile.activeProfile';
/** Picker model choice per profile id ('default' / an alias) */
const MODEL_KEY = 'ccprofile.modelChoice';
/** Picker effort choice, shared by every profile ('default' / a claude --effort level) */
const EFFORT_KEY = 'ccprofile.effort';
const MAX_SAVED_ITEMS = 300;
/** Task detail panel bounds: the newest items of a subagent transcript, each tool output clipped; a shell's stdout tail */
const DETAIL_MAX_ITEMS = 400;
const DETAIL_MAX_OUTPUT = 8000;
const DETAIL_MAX_BYTES = 64 * 1024;
/** viewType of the editor-tab chats; also named by the onWebviewPanel activation event in package.json */
export const EDITOR_VIEW_TYPE = 'ccprofile.editor';

/** Sent images older than this are pruned from the preview store; their bubbles fall back to a name chip */
const IMAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface Status { model?: string; auth?: string; last?: string; rate?: string }

/** Copies of sent images, served to the webviews as thumbnails / lightbox sources (extension storage, never the workspace) */
function imageDir(ctx: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(ctx.globalStorageUri, 'images');
}

/** Write one image into the preview store; ifMissing skips bytes that are already there (replays). Returns success. */
async function writeImage(dir: vscode.Uri, file: string, base64: string, ifMissing = false): Promise<boolean> {
  const dest = vscode.Uri.joinPath(dir, file);
  try {
    if (ifMissing) {
      try { await vscode.workspace.fs.stat(dest); return true; } catch { /* not there yet */ }
    }
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(dest, Buffer.from(base64, 'base64'));
    return true;
  } catch {
    return false;
  }
}

async function pruneImages(dir: vscode.Uri): Promise<void> {
  let entries: [string, vscode.FileType][];
  try { entries = await vscode.workspace.fs.readDirectory(dir); } catch { return; }
  const cutoff = Date.now() - IMAGE_RETENTION_MS;
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File) continue;
    const uri = vscode.Uri.joinPath(dir, name);
    try {
      if ((await vscode.workspace.fs.stat(uri)).mtime < cutoff) await vscode.workspace.fs.delete(uri);
    } catch { /* best effort */ }
  }
}

/** An attachment waiting to be sent: images keep base64 in memory, files keep a source URI or blob bytes */
interface PendingAttachment {
  id: string;
  name: string;
  kind: 'image' | 'file';
  mediaType?: string;
  base64?: string;
  thumb?: string;
  byteLength?: number;
  uri?: vscode.Uri;
}

interface MentionItem { label: string; path: string; kind: 'file' | 'folder' }

/**
 * One independent chat: its own transcript, session id, running turn and attachments, bound to a single webview
 * (the sidebar view or one editor panel). Model/effort/profile are shared app-wide and read from the manager;
 * the permission mode is per-session so different tabs can run under different modes.
 */
export class ChatSession implements vscode.Disposable {
  private readonly webviews = new Set<vscode.Webview>();
  private readonly transcript = new Transcript(op => this.post({ type: 'op', ...op }));
  private sid?: string;
  private running?: TurnHandle;
  private turn?: TurnTranslator;
  private stopping = false;
  /** Per-turn flag: set when the user stops/interrupts, so the SIGINT'd result is not shown as a red error */
  private turnStop?: { stopped: boolean };
  private settings?: SettingsFile;
  private pending: PendingAttachment[] = [];
  private starting = false;
  private interrupting?: Promise<void>;
  private generation = 0;
  private historyPending = false;
  mode: PermissionMode;
  private status: Status = {};
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly manager: ChatManager,
    /** the sidebar session restores and persists its transcript in workspaceState; editor-panel sessions are
     * restored after a window reload from their webview state instead (see ChatManager.deserializeWebviewPanel) */
    private readonly persistent: boolean,
    /** permission mode of an editor tab being revived after a window reload */
    restoredMode?: unknown,
  ) {
    if (persistent) {
      const saved = ctx.workspaceState.get<{ sessionId?: string; items?: Item[] }>(CHAT_KEY);
      this.sessionId = saved?.sessionId;
      this.transcript.items = saved?.items ?? [];
    }
    // A new chat starts from the setting default; a tab revived after a reload keeps the mode it had
    this.mode = PERMISSION_MODES.includes(restoredMode as PermissionMode)
      ? restoredMode as PermissionMode
      : vscode.workspace.getConfiguration('ccprofile').get<PermissionMode>('defaultPermissionMode') ?? 'bypassPermissions';
  }

  /** Every change is mirrored to the webview, which keeps it in its state so the tab can be revived after a reload */
  private get sessionId(): string | undefined {
    return this.sid;
  }

  private set sessionId(id: string | undefined) {
    this.sid = id;
    this.post({ type: 'session', sessionId: id });
  }

  /** Render the chat into a freshly created webview and start listening to it */
  wire(webview: vscode.Webview, media: vscode.Uri): void {
    webview.html = this.html(webview, media);
    webview.onDidReceiveMessage(m => this.onMessage(m), undefined, this.disposables);
    this.webviews.add(webview);
  }

  unwire(webview: vscode.Webview): void {
    this.webviews.delete(webview);
  }

  get busy(): boolean {
    return !!this.running;
  }

  async send(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text || this.starting) return;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') return this.notice('error', 'Open a local folder first (it never falls back to running in $HOME).');
    this.starting = true;
    try {
      // interrupt-and-replace: whatever is running gets stopped, the new message takes over (latest wins)
      const gen = this.generation;
      while (this.running) {
        if (!this.interrupting) this.interrupting = this.interruptRunning().finally(() => { this.interrupting = undefined; });
        await this.interrupting;
      }
      if (gen !== this.generation) return; // New chat was pressed while we waited

      const profile = this.manager.activeProfile();
      let key: string | undefined;
      if (isThirdParty(profile)) {
        key = await this.ctx.secrets.get(keyName(profile.id));
        if (!key) {
          return this.notice('error', `"${profile.label}" has no API key on this machine. Keys live in this machine's keychain and are not carried over by Settings Sync.`, 'setKey', profile.id);
        }
      }
      const claudePath = expandHome(vscode.workspace.getConfiguration('ccprofile').get<string>('claudePath') || '~/.local/bin/claude');
      const cfg = vscode.workspace.getConfiguration('ccprofile');
      const mode = this.mode;
      const resumed = !!this.sessionId;
      const { images, filePaths, names } = await this.materializePending(folder);
      if (gen !== this.generation) return;
      this.transcript.push({ kind: 'user', text, profile: this.manager.displayLabel(profile), attachments: names.length ? names : undefined });
      this.pending = [];
      void this.sendState();

      const turnStop = { stopped: false };
      this.turnStop = turnStop;
      const turn = new TurnTranslator(this.transcript, {
        init: e => {
          if (e.sessionId) this.post({ type: 'session', sessionId: e.sessionId });
          this.status.model = e.model;
          if (isThirdParty(profile)) {
            this.status.auth = hostOf(profile.baseUrl!);
          } else if (e.apiKeySource === 'none') {
            this.status.auth = 'Max subscription';
          } else {
            this.status.auth = `⚠ ${e.apiKeySource}`;
            this.notice('warn', `This turn of the Claude profile authenticated via ${e.apiKeySource}, not the Max subscription. Run "CC Cadence: Doctor" to find out why.`);
          }
          this.pushStatus();
        },
        rateLimit: info => { this.status.rate = rateText(info); this.pushStatus(); },
        result: e => {
          const n = resultNotice(e, turnStop.stopped);
          if (n) this.notice(n.level, n.text);
          const denied = [...new Set((e.permission_denials ?? []).map((d: any) => d?.tool_name).filter(Boolean))];
          if (denied.length) this.notice('warn', `Denied tool calls: ${denied.join(', ')} (permission mode ${mode})`);
          this.status.last = `${((e.duration_ms ?? 0) / 1000).toFixed(1)}s · ${e.num_turns ?? '?'} turns`;
          this.pushStatus();
        },
      });

      const blocks = buildBlocks(text, images, filePaths);
      this.stopping = false;
      this.turn = turn;
      this.settings = await writeSettingsFile(cfg.get<Record<string, unknown>>('claudeSettings'));
      const handle = runTurn({
        claudePath,
        cwd: folder.uri.fsPath,
        env: buildEnv(process.env, profile, key, cfg.get<Record<string, string>>('claudeEnv')),
        message: { text, blocks },
        permissionMode: mode,
        sessionId: this.sessionId,
        model: resolveModel(profile, this.manager.selectedModel(profile)),
        effort: this.manager.selectedEffort() === DEFAULT_MODEL ? undefined : this.manager.selectedEffort(),
        settingsPath: this.settings?.path,
        onEvent: e => turn.handle(e),
      });
      this.running = handle;
      this.setBusy(true);
      // the send lock is released here; further sends interrupt-and-replace this turn
      void this.awaitTurn(handle, turn, mode, resumed, claudePath);
    } finally {
      this.starting = false;
    }
  }

  /** Post-exit finalization for the turn that is still this session's live turn */
  private async awaitTurn(handle: TurnHandle, turn: TurnTranslator, mode: PermissionMode, resumed: boolean, claudePath: string): Promise<void> {
    const exit = await handle.done;
    if (this.running !== handle || this.turn !== turn) return; // interrupted or reset: the interrupter/newChat finalizes instead
    this.running = undefined;
    this.setBusy(false);
    void this.settings?.dispose();
    this.settings = undefined;
    this.turn = undefined;

    turn.finish(this.stopping ? 'Interrupted' : 'Incomplete');
    if (turn.sessionId) this.sessionId = turn.sessionId;
    if (exit.spawnError) {
      this.notice('error', `Failed to start claude (${claudePath}): ${exit.spawnError.message}\nChange the path in the ccprofile.claudePath setting.`);
    } else if (this.stopping) {
      this.notice('info', 'Stopped by user.');
    } else if (!turn.gotResult) {
      const tail = exit.stderr.trim().slice(-1500);
      const hint = resumed ? '\nIf resuming the session failed, press "New chat" to start over.' : '';
      this.notice('error', `claude exited abnormally (${exit.signal ?? `code ${exit.code}`})${tail ? '\n' + tail : ''}${hint}`);
    }
    if (turn.pendingTasks > 0) {
      this.notice('info', 'Background tasks were still running when claude exited. Check now to collect their results.', 'checkTasks');
    }
    void this.save();
  }

  /** Interrupt-and-replace: stop the running process, finalize its turn as Interrupted, keep the session id */
  private async interruptRunning(): Promise<void> {
    const handle = this.running!;
    const prev = this.turn;
    this.running = undefined;
    this.stopping = false;
    if (this.turnStop) this.turnStop.stopped = true; // suppress the SIGINT'd result's red error
    handle.stop();
    await handle.done;
    void this.settings?.dispose();
    this.settings = undefined;
    prev?.finish('Interrupted');
    this.notice('info', 'Stopped by user.');
    if (prev && prev.pendingTasks > 0) {
      this.notice('info', 'Interrupted while background tasks were still running. Check now to collect their results.', 'checkTasks');
    }
    if (this.turn === prev) this.turn = undefined;
    // busy stays true across interrupt-and-replace: the caller immediately starts the new turn
  }

  /**
   * The task detail panel asks for a task's full output (re-asked while it stays open on a running task):
   * a subagent's own transcript (prompt, tool calls, replies), or the tail of a background shell's stdout
   */
  private async taskDetail(taskId: string): Promise<void> {
    const task = this.transcript.items.find(x => x.kind === 'task' && x.taskId === taskId);
    if (task?.kind !== 'task') return;
    const folder = vscode.workspace.workspaceFolders?.[0];
    let items: Item[] = [];
    let text: string | undefined;
    let truncated = false;
    if (task.taskType === 'local_bash') {
      if (task.outputFile) {
        try {
          const fh = await fsp.open(task.outputFile, 'r');
          try {
            const { size } = await fh.stat();
            const len = Math.min(size, DETAIL_MAX_BYTES);
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, size - len);
            text = buf.toString('utf8');
            truncated = size > len;
          } finally {
            await fh.close();
          }
        } catch { /* gone (tmp cleaned) or not created yet */ }
      }
    } else {
      if (this.sessionId && folder?.uri.scheme === 'file') items = await readSubagentTranscript(this.sessionId, folder.uri.fsPath, taskId);
      if (!items.length && task.outputFile) {
        try { items = parseTranscript(await fsp.readFile(task.outputFile, 'utf8'), { sidechain: true }); } catch { /* not there */ }
      }
      truncated = items.length > DETAIL_MAX_ITEMS;
      items = items.slice(-DETAIL_MAX_ITEMS).map(it =>
        it.kind === 'tool' && it.output && it.output.length > DETAIL_MAX_OUTPUT ? { ...it, output: it.output.slice(0, DETAIL_MAX_OUTPUT) + '…' } : it);
    }
    this.post({ type: 'taskDetail', taskId, items, text, truncated });
  }

  /** Replay a stored session, putting its user images back into the preview store so they render as thumbnails */
  private async replay(id: string, cwd: string): Promise<Item[]> {
    const dir = imageDir(this.ctx);
    const files = new Map<string, Promise<boolean>>();
    const items = await readTranscript(id, cwd, (mediaType, base64) => {
      if (!isImageType(mediaType)) return undefined;
      const file = imageFileName(mediaType, base64);
      if (!files.has(file)) files.set(file, writeImage(dir, file, base64, true));
      return file;
    });
    await Promise.all(files.values());
    return items;
  }

  /** Split pending attachments into image blocks and materialized file paths; clears nothing (send clears) */
  private async materializePending(folder: vscode.WorkspaceFolder): Promise<{
    images: { mediaType: string; base64: string }[];
    filePaths: string[];
    names: Attachment[];
  }> {
    const images: { mediaType: string; base64: string }[] = [];
    const filePaths: string[] = [];
    const names: Attachment[] = [];
    if (this.pending.some(a => a.kind === 'file')) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.ccprofile', 'attachments'));
    }
    for (const a of this.pending) {
      if (a.kind === 'image' && a.base64) {
        const mediaType = a.mediaType ?? 'image/png';
        images.push({ mediaType, base64: a.base64 });
        // a preview copy for the bubble thumbnail; if it can't be written the bubble shows a name chip instead
        const file = imageFileName(mediaType, a.base64);
        const stored = await writeImage(imageDir(this.ctx), file, a.base64);
        names.push(stored ? { name: a.name, mediaType, file } : { name: a.name, mediaType });
        continue;
      }
      const destName = stagedName(a.name, a.id);
      const dest = vscode.Uri.joinPath(folder.uri, '.ccprofile', 'attachments', destName);
      try {
        if (a.uri) await vscode.workspace.fs.copy(a.uri, dest, { overwrite: true });
        else if (a.base64) await vscode.workspace.fs.writeFile(dest, Buffer.from(a.base64, 'base64'));
        else continue;
      } catch (err) {
        this.notice('error', `Could not stage attachment "${a.name}": ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      filePaths.push(path.relative(folder.uri.fsPath, dest.fsPath));
      names.push({ name: a.name, mediaType: a.mediaType ?? 'application/octet-stream' });
    }
    return { images, filePaths, names };
  }

  private async addUriAttachment(uri: vscode.Uri): Promise<void> {
    try {
      const st = await vscode.workspace.fs.stat(uri);
      const name = uri.path.split('/').pop() || 'file';
      const kind = classifyAttachment(name, undefined, st.size);
      if (kind === 'reject') {
        this.notice('error', `"${name}" is over the ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB image limit.`);
        return;
      }
      if (kind === 'image') {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const base64 = Buffer.from(bytes).toString('base64');
        const mt = mediaTypeOf(name);
        this.pending.push({ id: nextAttachmentId(), name, kind: 'image', mediaType: mt, base64, thumb: `data:${mt};base64,${base64}`, byteLength: st.size });
        this.postThumbs();
      } else {
        this.pending.push({ id: nextAttachmentId(), name, kind: 'file', uri, byteLength: st.size });
      }
    } catch (err) {
      this.notice('error', `Could not attach ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** An image pasted or dropped as raw bytes arrives as base64; a non-image OS drop carries the blob bytes.
   * cid is the webview-generated attachment id, which also keys the webview's own thumbnail cache. */
  private addDataAttachment(name: string, mediaType: string | undefined, base64: string, cid?: string): void {
    const byteLength = Math.floor(base64.length * 3 / 4);
    const kind = classifyAttachment(name, mediaType, byteLength);
    if (kind === 'reject') {
      this.notice('error', `"${name}" is over the ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB image limit.`);
      return;
    }
    const id = typeof cid === 'string' && cid.length >= 4 ? cid : nextAttachmentId();
    if (kind === 'image') {
      const mt = mediaType ?? mediaTypeOf(name);
      this.pending.push({ id, name, kind: 'image', mediaType: mt, base64, thumb: `data:${mt};base64,${base64}` });
    } else {
      this.pending.push({ id, name, kind: 'file', base64, byteLength });
    }
    this.sendState();
  }

  /** One-shot thumbnail delivery: base64 never rides the recurring state messages */
  private postThumbs(): void {
    const thumbs = this.pending.filter(a => a.thumb).map(a => ({ id: a.id, thumb: a.thumb! }));
    if (thumbs.length) this.post({ type: 'thumbs', thumbs });
  }

  private async mention(queryId: string, raw: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const q = raw.trim().replace(/^\.\//, '').replace(/\\/g, '/');
    // "src/au" → look inside src/ for names containing "au" (dir keeps its case for labels; matching is case-insensitive)
    const slash = q.lastIndexOf('/');
    const dir = slash >= 0 ? q.slice(0, slash) : '';
    const seg = q.slice(slash + 1).toLowerCase();
    const items: MentionItem[] = [];
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir ? vscode.Uri.joinPath(folder.uri, dir) : folder.uri);
      for (const [name, type] of entries) {
        const rel = (dir ? dir + '/' : '') + name + '/';
        if (type === vscode.FileType.Directory && fuzzy(name, seg)) items.push({ label: rel, path: rel, kind: 'folder' });
      }
    } catch { /* ignore unreadable or missing folders */ }
    const glob = `${dir ? caseInsensitiveGlob(dir) + '/' : ''}**/*${caseInsensitiveGlob(seg)}*`;
    const files = await vscode.workspace.findFiles(glob, '**/.ccprofile/**', 20);
    for (const f of files) {
      const rel = path.relative(folder.uri.fsPath, f.fsPath);
      const relPosix = rel.split(path.sep).join('/');
      if (!rel || rel.startsWith('..') || !fuzzy(path.basename(rel), seg)) continue;
      items.push({ label: relPosix, path: relPosix, kind: 'file' });
      if (items.length >= 20) break;
    }
    this.post({ type: 'mentionResults', queryId, items: items.slice(0, 20) });
  }

  stop(): void {
    if (!this.running) return;
    this.stopping = true;
    if (this.turnStop) this.turnStop.stopped = true;
    this.running.stop();
  }

  newChat(): void {
    this.generation++;
    this.turn?.detach();
    this.turn = undefined;
    this.stop();
    this.sessionId = undefined;
    this.status = {};
    this.transcript.reset([]);
    this.sendState();
    void this.save();
  }

  /** The manager resets this session's continuation id when an incompatible vendor switch makes it unusable */
  resetSessionId(): void {
    this.sessionId = undefined;
    void this.save();
  }

  /** Tell the user (in this session) that the active model changed */
  noticeProfileSwitch(label: string, compatible: boolean): void {
    if (!this.transcript.items.length) return;
    this.notice('info', compatible
      ? `Switched to "${label}"; the next message continues the current session.`
      : `Switched to "${label}"; sessions are not compatible across vendors, so the next message starts a new session.`);
  }

  private setMode(mode: PermissionMode): void {
    if (!PERMISSION_MODES.includes(mode) || mode === this.mode) return;
    this.mode = mode;
    this.sendState();
  }

  /** Title-bar history button: send the session list; the panel shows it as a dropdown at the top right */
  async history(): Promise<void> {
    if (!this.webviews.size) {
      // sidebar not resolved yet: focus it and answer once its webview reports ready
      this.historyPending = true;
      await vscode.commands.executeCommand('ccprofile.chat.focus');
      return;
    }
    await this.postSessions();
  }

  private async postSessions(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') return this.notice('error', 'Open a local folder first (it never falls back to running in $HOME).');
    const sessions = await listSessions(folder.uri.fsPath);
    this.post({
      type: 'sessions',
      current: this.sessionId,
      items: sessions.map(s => ({ id: s.sessionId, title: s.title, ago: relativeTime(s.mtimeMs) })),
    });
  }

  private async deleteSessionById(id: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') return;
    await deleteSession(id, folder.uri.fsPath);
    if (id === this.sessionId) this.sessionId = undefined;
    await this.postSessions();
  }

  async resumeSession(id: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') return this.notice('error', 'Open a local folder first (it never falls back to running in $HOME).');
    const items = await this.replay(id, folder.uri.fsPath);
    if (!items.length) return this.notice('error', 'That session could not be loaded.');
    this.turn?.detach();
    this.turn = undefined;
    this.stop();
    this.sessionId = id;
    this.transcript.reset(items);
    this.sendState();
    void this.save();
  }

  /** Revive a tab after a window reload: replay its stored session quietly; a session that is gone leaves an empty chat */
  async restore(id: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') return;
    const items = await this.replay(id, folder.uri.fsPath);
    if (!items.length) return;
    this.sessionId = id;
    this.transcript.reset(items);
  }

  dispose(): void {
    this.turn?.detach();
    this.running?.stop();
    void this.settings?.dispose();
    this.disposables.forEach(d => d.dispose());
    this.webviews.clear();
  }

  private onMessage(m: any): void {
    switch (m?.type) {
      case 'ready':
        this.sendState();
        if (this.historyPending) { this.historyPending = false; void this.postSessions(); }
        break;
      case 'send': if (typeof m.text === 'string') void this.send(m.text); break;
      case 'stop': this.stop(); break;
      case 'newChat': this.newChat(); break;
      case 'setProfile': if (typeof m.id === 'string') void this.manager.setProfile(this, m.id); break;
      case 'setModel': if (typeof m.model === 'string') void this.manager.setModel(this, m.model); break;
      case 'setEffort': if (typeof m.effort === 'string') void this.manager.setEffort(m.effort); break;
      case 'setMode': if (typeof m.mode === 'string') this.setMode(m.mode); break;
      case 'addProfile': void this.manager.addProfile(this); break;
      case 'manageProfiles': void this.manager.manageProfiles(this); break;
      case 'history': void this.history(); break;
      case 'resumeSession': if (typeof m.id === 'string') void this.resumeSession(m.id); break;
      case 'deleteSession': if (typeof m.id === 'string') void this.deleteSessionById(m.id); break;
      case 'attachData':
        if (typeof m.name === 'string' && typeof m.base64 === 'string') this.addDataAttachment(m.name, typeof m.mediaType === 'string' ? m.mediaType : undefined, m.base64, m.cid);
        break;
      case 'attachFile':
        if (typeof m.name === 'string' && typeof m.base64 === 'string') this.addDataAttachment(m.name, undefined, m.base64, m.cid);
        break;
      case 'taskDetail':
        if (typeof m.taskId === 'string') void this.taskDetail(m.taskId);
        break;
      case 'removeAttachment':
        this.pending = this.pending.filter(a => a.id !== m.id);
        this.sendState();
        break;
      case 'attachUri':
        if (typeof m.uri === 'string') void this.addUriAttachment(vscode.Uri.parse(m.uri)).then(() => this.sendState());
        break;
      case 'pickProfile': void this.manager.pickProfile(this); break;
      case 'mentionQuery': if (typeof m.queryId === 'string' && typeof m.text === 'string') void this.mention(m.queryId, m.text); break;
      case 'checkTasks': void this.send('Check your background tasks and continue.'); break;
      case 'setKey': if (typeof m.profileId === 'string') void this.manager.setKey(m.profileId); break;
    }
  }

  /** Re-send the full state to this session's webview (after a profile/model/effort change) */
  refresh(): void {
    this.sendState();
  }

  private sendState(): void {
    const active = this.manager.activeProfile();
    this.post({
      type: 'state',
      profiles: this.manager.profiles().map(p => ({ id: p.id, label: p.label, description: profileDescription(p) })),
      activeId: active.id,
      model: this.manager.selectedModel(active),
      modelChoices: modelChoices(active).map(c => ({ id: c, label: choiceLabel(c), detail: choiceDetail(active, c) })),
      effort: this.manager.selectedEffort(),
      effortChoices: effortChoices().map(e => ({ id: e, label: e === 'xhigh' ? 'XHigh' : choiceLabel(e), detail: e === DEFAULT_MODEL ? 'ccprofile.claudeSettings effortLevel, else the CLI default' : `--effort ${e}` })),
      mode: this.mode,
      modes: PERMISSION_MODES,
      sessionId: this.sessionId,
      busy: !!this.running,
      items: this.transcript.items,
      attachments: this.pending.map(a => ({ id: a.id, name: a.name, kind: a.kind, mediaType: a.mediaType })),
      status: this.statusText(),
    });
  }

  private setBusy(busy: boolean): void {
    this.post({ type: 'busy', busy });
  }

  private statusText(): string {
    const s = this.status;
    return [s.model, s.auth, s.last, s.rate].filter(Boolean).join(' · ');
  }

  private pushStatus(): void {
    this.post({ type: 'status', text: this.statusText() });
  }

  private notice(level: 'info' | 'warn' | 'error', text: string, action?: 'checkTasks' | 'setKey', profileId?: string): void {
    this.transcript.push({ kind: 'notice', level, text, action, profileId });
  }

  private post(msg: unknown): void {
    for (const wv of this.webviews) void wv.postMessage(msg);
  }

  private save(): Thenable<void> {
    if (!this.persistent) return Promise.resolve();
    return this.ctx.workspaceState.update(CHAT_KEY, { sessionId: this.sessionId, items: this.transcript.items.slice(-MAX_SAVED_ITEMS) });
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...p));
    const nonce = randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('chat.css')}">
</head>
<body data-images="${webview.asWebviewUri(imageDir(this.ctx))}">
<div id="history-popup" hidden></div>
<main id="log"></main>
<footer>
  <div id="mention-popup" hidden></div>
  <div id="agents-popup" hidden></div>
  <div id="mode-popup" hidden></div>
  <div id="profile-popup" hidden></div>
  <div id="status"></div>
  <div id="chips"></div>
  <div class="composer" id="composer">
    <textarea id="input" rows="3" placeholder="Enter to send, Shift+Enter for a new line"></textarea>
    <input type="file" id="file-input" multiple hidden>
    <div class="toolbar">
      <button id="attach" class="ghost" title="Upload from computer">＋</button>
      <button id="mention" class="ghost" title="Mention a file (@)">@</button>
      <button id="agents" class="ghost" title="Background agents" hidden></button>
      <button id="profile" class="pill" title="Switch model"></button>
      <button id="mode" class="pill" title="Permission mode"></button>
      <span class="spacer"></span>
      <button id="stop" class="ghost" title="Stop" hidden>⏹</button>
      <button id="send">Send</button>
    </div>
  </div>
</footer>
<script nonce="${nonce}" src="${uri('vendor', 'marked.min.js')}"></script>
<script nonce="${nonce}" src="${uri('vendor', 'purify.min.js')}"></script>
<script nonce="${nonce}" src="${uri('chat.js')}"></script>
</body>
</html>`;
  }
}

/**
 * Owns the shared model/effort/profile preferences and the set of live chat sessions. It is the sidebar's
 * WebviewViewProvider (binding the one persistent session) and spawns a fresh independent session + editor tab
 * on every `ccprofile.open`.
 */
export class ChatManager implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer, vscode.Disposable {
  private readonly sessions = new Set<ChatSession>();
  /** Editor-panel sessions, keyed by their panel so the active one can answer the editor-title history button */
  private readonly panels = new Map<ChatSession, vscode.WebviewPanel>();
  /** The sidebar session: persists its transcript and is the target of the view-title commands */
  private primary?: ChatSession;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    void pruneImages(imageDir(ctx));
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('ccprofile')) this.refreshAll(); }),
    );
  }

  private get media(): vscode.Uri {
    return vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
  }

  /** What a chat webview may load: its own media plus the sent-image preview store */
  private get roots(): vscode.Uri[] {
    return [this.media, imageDir(this.ctx)];
  }

  // ---- shared preferences (model / effort / profile), read from and written to globalState ----

  profiles(): Profile[] {
    return loadProfiles(vscode.workspace.getConfiguration('ccprofile').get('profiles')).profiles;
  }

  activeProfile(): Profile {
    const profiles = this.profiles();
    const id = this.ctx.globalState.get<string>(ACTIVE_KEY);
    return profiles.find(p => p.id === id) ?? profiles[0];
  }

  /** The picker choice remembered for a profile; falls back to default when the profile no longer offers it */
  selectedModel(p: Profile = this.activeProfile()): string {
    const choice = this.ctx.globalState.get<Record<string, string>>(MODEL_KEY)?.[p.id];
    return choice && modelChoices(p).includes(choice) ? choice : DEFAULT_MODEL;
  }

  selectedEffort(): string {
    const effort = this.ctx.globalState.get<string>(EFFORT_KEY);
    return effort && effortChoices().includes(effort) ? effort : DEFAULT_MODEL;
  }

  displayLabel(p: Profile = this.activeProfile()): string {
    const choice = this.selectedModel(p);
    const effort = this.selectedEffort();
    return [p.label, choice === DEFAULT_MODEL ? '' : choice, effort === DEFAULT_MODEL ? '' : `${effort} effort`].filter(Boolean).join(' · ');
  }

  async setEffort(effort: string): Promise<void> {
    if (!effortChoices().includes(effort) || effort === this.selectedEffort()) return;
    await this.ctx.globalState.update(EFFORT_KEY, effort);
    this.refreshAll();
  }

  /** Switch profile and/or its model choice; the originating session gets the "switched" notice and, on an
   * incompatible vendor change, every session's continuation id is reset so no stale session 400s. */
  async setProfile(session: ChatSession, id: string, choice?: string): Promise<void> {
    const prev = this.activeProfile();
    const prevLabel = this.displayLabel(prev);
    const target = this.profiles().find(p => p.id === id);
    if (!target) return;
    if (choice !== undefined && modelChoices(target).includes(choice)) {
      const saved = this.ctx.globalState.get<Record<string, string>>(MODEL_KEY) ?? {};
      await this.ctx.globalState.update(MODEL_KEY, { ...saved, [id]: choice });
    }
    if (id === prev.id && this.displayLabel(target) === prevLabel) return;
    if (id !== prev.id) await this.ctx.globalState.update(ACTIVE_KEY, id);
    const next = this.activeProfile();
    // Resuming within the same vendor is fine; across vendors the thinking block signature mismatches and 400s
    const compatible = isThirdParty(prev) === isThirdParty(next)
      && (!isThirdParty(prev) || prev.baseUrl === next.baseUrl);
    if (!compatible) for (const s of this.sessions) s.resetSessionId();
    session.noticeProfileSwitch(this.displayLabel(next), compatible);
    this.refreshAll();
  }

  async setModel(session: ChatSession, choice: string): Promise<void> {
    await this.setProfile(session, this.activeProfile().id, choice);
  }

  async pickProfile(session: ChatSession): Promise<void> {
    const current = this.activeProfile().id;
    const currentChoice = this.selectedModel();
    type Pick = vscode.QuickPickItem & { id?: string; choice?: string };
    const picks: Pick[] = this.profiles().flatMap(p => modelChoices(p).map(c => ({
      label: `${p.id === current && c === currentChoice ? '$(check) ' : ''}${c === DEFAULT_MODEL ? p.label : `${p.label} · ${choiceLabel(c)}`}`,
      description: c === DEFAULT_MODEL ? profileDescription(p) : choiceDetail(p, c),
      id: p.id,
      choice: c,
    })));
    picks.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(add) Add model…', id: '__add__' },
      { label: '$(gear) Manage models…', id: '__manage__' },
    );
    const pick = await vscode.window.showQuickPick(picks, { title: 'Switch model' });
    if (pick?.id === '__add__') await this.addProfile(session);
    else if (pick?.id === '__manage__') await this.manageProfiles(session);
    else if (pick?.id) await this.setProfile(session, pick.id, pick.choice);
  }

  async addProfile(session: ChatSession): Promise<void> {
    const id = await addProfile(this.ctx.secrets);
    if (id) await this.setProfile(session, id);
    this.refreshAll();
  }

  async manageProfiles(session: ChatSession): Promise<void> {
    const id = await manageProfiles(this.ctx.secrets);
    if (id) await this.setProfile(session, id);
    this.refreshAll();
  }

  /** The "Set API key" button on a missing-key notice */
  async setKey(profileId: string): Promise<void> {
    const p = this.profiles().find(x => x.id === profileId);
    if (p && isThirdParty(p)) await setApiKey(this.ctx.secrets, p.id, p.label);
  }

  private refreshAll(): void {
    for (const s of this.sessions) s.refresh();
  }

  // ---- webview / session lifecycle ----

  resolveWebviewView(view: vscode.WebviewView): void {
    if (!this.primary) {
      this.primary = new ChatSession(this.ctx, this, true);
      this.sessions.add(this.primary);
    }
    const session = this.primary;
    view.webview.options = { enableScripts: true, localResourceRoots: this.roots };
    session.wire(view.webview, this.media);
    view.onDidDispose(() => session.unwire(view.webview));
  }

  /**
   * Open a brand-new independent chat.
   * - clicked from a file group → a new locked split beside the files (the CC Cadence group)
   * - clicked from a CC Cadence group → another tab appended to that same group, no new split
   * `resource` is what editor/title passes: the clicked group's active file, or a webview-panel: uri (or nothing) for a webview.
   */
  openEditorPanel(resource?: unknown): void {
    const group = cadenceTargetGroup(resource);
    const column = group?.viewColumn ?? vscode.ViewColumn.Beside;
    const panel = vscode.window.createWebviewPanel(EDITOR_VIEW_TYPE, 'CC Cadence', { viewColumn: column, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: this.roots,
    });
    this.adopt(panel, new ChatSession(this.ctx, this, false));
    // a fresh split: lock it so opening files doesn't land in the chat group — it stays its own split (like Claude Code)
    if (!group) void vscode.commands.executeCommand('workbench.action.lockEditorGroup');
  }

  /**
   * VS Code revives the editor tabs that were open before a window reload: the webview state (kept by media/chat.js)
   * carries the tab's session id and permission mode, and the transcript is replayed from the CLI's session file.
   */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const saved = (state && typeof state === 'object' ? state : {}) as { sessionId?: unknown; mode?: unknown };
    const session = new ChatSession(this.ctx, this, false, saved.mode);
    if (typeof saved.sessionId === 'string' && saved.sessionId) {
      try {
        await session.restore(saved.sessionId);
      } catch { /* an unreadable session file leaves an empty chat */ }
    }
    this.adopt(panel, session);
  }

  /** Bind an editor panel (new or revived) to its session */
  private adopt(panel: vscode.WebviewPanel, session: ChatSession): void {
    panel.webview.options = { enableScripts: true, localResourceRoots: this.roots };
    panel.iconPath = vscode.Uri.joinPath(this.media, 'logo.svg');
    this.sessions.add(session);
    this.panels.set(session, panel);
    session.wire(panel.webview, this.media);
    panel.onDidDispose(() => {
      session.dispose();
      this.sessions.delete(session);
      this.panels.delete(session);
    });
  }

  // ---- title-bar commands operate on the sidebar session ----

  newChat(): void { this.primary?.newChat(); }
  stop(): void { this.primary?.stop(); }
  history(): void { void this.primary?.history(); }

  /** Editor-title history button: resolve the CC Cadence panel that is currently active and show its session list */
  openHistory(): void {
    for (const [session, panel] of this.panels) {
      if (panel.active) { void session.history(); return; }
    }
    void this.primary?.history();
  }
  switchProfile(): void { if (this.primary) void this.pickProfile(this.primary); }
  addProfileCmd(): void { if (this.primary) void this.addProfile(this.primary); }
  manageProfilesCmd(): void { if (this.primary) void this.manageProfiles(this.primary); }

  dispose(): void {
    for (const s of this.sessions) s.dispose();
    this.sessions.clear();
    this.disposables.forEach(d => d.dispose());
  }
}

function isCadenceTab(tab: vscode.Tab | undefined): boolean {
  return tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(EDITOR_VIEW_TYPE);
}

/** The CC Cadence editor group the open button was clicked in, or undefined when it was clicked from a file group */
function cadenceTargetGroup(resource: unknown): vscode.TabGroup | undefined {
  const fromFile = resource instanceof vscode.Uri && resource.scheme !== 'webview-panel';
  if (fromFile) return undefined;
  const active = vscode.window.tabGroups.activeTabGroup;
  if (isCadenceTab(active.activeTab)) return active;
  // clicked in a CC Cadence group that isn't the focused one
  return vscode.window.tabGroups.all.find(g => isCadenceTab(g.activeTab));
}

function profileDescription(p: Profile): string {
  return isThirdParty(p) ? p.baseUrl ?? '' : 'local claude -p · Max subscription';
}

function choiceLabel(choice: string): string {
  return choice === DEFAULT_MODEL ? 'Default' : choice.charAt(0).toUpperCase() + choice.slice(1);
}

/** What a picker choice actually runs: the --model value, or where the default comes from */
function choiceDetail(p: Profile, choice: string): string {
  const model = resolveModel(p, choice);
  if (isThirdParty(p)) return model ?? 'endpoint default';
  return model ? `--model ${model}` : 'claude CLI default';
}

function mediaTypeOf(name: string): string {
  const ext = name.toLowerCase();
  if (ext.endsWith('.png')) return 'image/png';
  if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) return 'image/jpeg';
  if (ext.endsWith('.webp')) return 'image/webp';
  return 'image/gif';
}

/** findFiles globs are case-sensitive: turn "readme" into "[rR][eE]..." and neutralize glob metacharacters */
function caseInsensitiveGlob(s: string): string {
  return s.replace(/[{}[\]*?!]/g, '?').replace(/[a-z]/gi, c => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}

function fuzzy(hay: string, needle: string): boolean {
  return !needle || hay.toLowerCase().includes(needle);
}

function relativeTime(mtimeMs: number): string {
  const s = Math.max(1, Math.round((Date.now() - mtimeMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function rateText(info: any): string {
  if (!info || info.status === 'allowed') return '';
  const reset = typeof info.resetsAt === 'number' ? `, resets ${new Date(info.resetsAt * 1000).toLocaleString()}` : '';
  return `quota ${info.status}${reset}`;
}
