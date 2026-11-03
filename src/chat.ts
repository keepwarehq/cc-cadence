import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Item, Transcript, TurnTranslator } from './transcript';
import { DEFAULT_MODEL, PERMISSION_MODES, effortChoices, PermissionMode, Profile, buildEnv, expandHome, isThirdParty, loadProfiles, modelChoices, resolveModel } from './profiles';
import { TurnHandle, runTurn, InputBlock } from './runner';
import { addProfile, keyName, manageProfiles } from './profileUi';
import { deleteSession, listSessions, readTranscript } from './sessions';
import { SettingsFile, writeSettingsFile } from './settingsFile';
import { MAX_IMAGE_BYTES, buildBlocks, classifyAttachment, nextAttachmentId, stagedName } from './attachments';
import { resultNotice } from './turnResult';

const CHAT_KEY = 'ccprofile.chat';
const ACTIVE_KEY = 'ccprofile.activeProfile';
/** Picker model choice per profile id ('default' / an alias) */
const MODEL_KEY = 'ccprofile.modelChoice';
/** Picker effort choice, shared by every profile ('default' / a claude --effort level) */
const EFFORT_KEY = 'ccprofile.effort';
const MAX_SAVED_ITEMS = 300;

interface Status { model?: string; auth?: string; last?: string; rate?: string }

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

export class ChatController implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private editorPanel?: vscode.WebviewPanel;
  /** Every live webview (sidebar view + editor panel); messages broadcast to all so both stay in sync */
  private readonly webviews = new Set<vscode.Webview>();
  private readonly transcript = new Transcript(op => this.post({ type: 'op', ...op }));
  private sessionId?: string;
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
  private mode: PermissionMode;
  private status: Status = {};
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    const saved = ctx.workspaceState.get<{ sessionId?: string; items?: Item[] }>(CHAT_KEY);
    this.sessionId = saved?.sessionId;
    this.transcript.items = saved?.items ?? [];
    // The permission mode is not remembered across windows: every window starts from the setting default (bypassPermissions)
    this.mode = vscode.workspace.getConfiguration('ccprofile').get<PermissionMode>('defaultPermissionMode') ?? 'bypassPermissions';
    this.statusBar.command = 'ccprofile.switchProfile';
    this.statusBar.show();
    this.disposables.push(
      this.statusBar,
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('ccprofile')) this.refresh(); }),
    );
    this.refresh();
  }

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

  async setEffort(effort: string): Promise<void> {
    if (!effortChoices().includes(effort) || effort === this.selectedEffort()) return;
    await this.ctx.globalState.update(EFFORT_KEY, effort);
    this.refresh();
  }

  private displayLabel(p: Profile = this.activeProfile()): string {
    const choice = this.selectedModel(p);
    const effort = this.selectedEffort();
    return [p.label, choice === DEFAULT_MODEL ? '' : choice, effort === DEFAULT_MODEL ? '' : `${effort} effort`].filter(Boolean).join(' · ');
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage(m => this.onMessage(m), undefined, this.disposables);
    this.webviews.add(view.webview);
    view.onDidDispose(() => {
      this.webviews.delete(view.webview);
      if (this.view === view) this.view = undefined;
    });
  }

  /** Open (or reveal) the chat as a tab in the editor area — its tab shows the colored logo via iconPath */
  openEditorPanel(): void {
    if (this.editorPanel) { this.editorPanel.reveal(); return; }
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('ccprofile.editor', 'CC Cadence', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    panel.iconPath = vscode.Uri.joinPath(media, 'logo.svg');
    panel.webview.html = this.html(panel.webview, media);
    panel.webview.onDidReceiveMessage(m => this.onMessage(m), undefined, this.disposables);
    this.editorPanel = panel;
    this.webviews.add(panel.webview);
    panel.onDidDispose(() => {
      this.webviews.delete(panel.webview);
      if (this.editorPanel === panel) this.editorPanel = undefined;
    });
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

      const profile = this.activeProfile();
      let key: string | undefined;
      if (isThirdParty(profile)) {
        key = await this.ctx.secrets.get(keyName(profile.id));
        if (!key) return this.notice('error', `"${profile.label}" has no API key yet: set one via "Manage models…" in the profile dropdown.`);
      }
      const claudePath = expandHome(vscode.workspace.getConfiguration('ccprofile').get<string>('claudePath') || '~/.local/bin/claude');
      const cfg = vscode.workspace.getConfiguration('ccprofile');
      const mode = this.mode;
      const resumed = !!this.sessionId;
      const { images, filePaths, names } = await this.materializePending(folder);
      if (gen !== this.generation) return;
      this.transcript.push({ kind: 'user', text, profile: this.displayLabel(profile), attachments: names.length ? names : undefined });
      this.pending = [];
      void this.sendState();

      const turnStop = { stopped: false };
      this.turnStop = turnStop;
      const turn = new TurnTranslator(this.transcript, {
        init: e => {
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
        model: resolveModel(profile, this.selectedModel(profile)),
        effort: this.selectedEffort() === DEFAULT_MODEL ? undefined : this.selectedEffort(),
        settingsPath: this.settings?.path,
        onEvent: e => turn.handle(e),
      });
      this.running = handle;
      // the send lock is released here; further sends interrupt-and-replace this turn
      void this.awaitTurn(handle, turn, mode, resumed, claudePath);
    } finally {
      this.starting = false;
    }
  }

  /** Post-exit finalization for the turn that is still the controller's live turn */
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
  }

  /** Split pending attachments into image blocks and materialized file paths; clears nothing (send clears) */
  private async materializePending(folder: vscode.WorkspaceFolder): Promise<{
    images: { mediaType: string; base64: string }[];
    filePaths: string[];
    names: { name: string; mediaType: string }[];
  }> {
    const images: { mediaType: string; base64: string }[] = [];
    const filePaths: string[] = [];
    const names: { name: string; mediaType: string }[] = [];
    if (this.pending.some(a => a.kind === 'file')) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.ccprofile', 'attachments'));
    }
    for (const a of this.pending) {
      if (a.kind === 'image' && a.base64) {
        images.push({ mediaType: a.mediaType ?? 'image/png', base64: a.base64 });
        names.push({ name: a.name, mediaType: a.mediaType ?? 'image/png' });
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
        this.notice('error', `"${name}" is over the 5 MB image limit.`);
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
      this.notice('error', `"${name}" is over the 5 MB image limit.`);
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
    const q = raw.trim().toLowerCase();
    const items: MentionItem[] = [];
    try {
      const entries = await vscode.workspace.fs.readDirectory(folder.uri);
      for (const [name, type] of entries) {
        if (type === vscode.FileType.Directory && fuzzy(name, q)) items.push({ label: name + '/', path: name + '/', kind: 'folder' });
      }
    } catch { /* ignore unreadable folders */ }
    const files = await vscode.workspace.findFiles(q ? `**/*${q.replace(/[/\\]/g, '')}*` : '**/*', '**/.ccprofile/**', 20);
    for (const f of files) {
      const rel = path.relative(folder.uri.fsPath, f.fsPath);
      if (!rel || rel.startsWith('..') || !fuzzy(rel, q)) continue;
      items.push({ label: rel, path: rel, kind: 'file' });
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
    this.pushStatus();
    void this.save();
  }

  /** Switch profile and/or its model choice; choice undefined keeps the one remembered for that profile */
  async setProfile(id: string, choice?: string): Promise<void> {
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
    // Resuming within the same vendor is fine; across vendors the thinking block signature mismatches and 400s — only a new session works
    const compatible = isThirdParty(prev) === isThirdParty(next)
      && (!isThirdParty(prev) || prev.baseUrl === next.baseUrl);
    this.sessionId = compatible ? this.sessionId : undefined;
    if (this.transcript.items.length) {
      this.notice('info', compatible
        ? `Switched to "${this.displayLabel(next)}"; the next message continues the current session.`
        : `Switched to "${this.displayLabel(next)}"; sessions are not compatible across vendors, so the next message starts a new session.`);
    }
    this.refresh();
  }

  async setModel(choice: string): Promise<void> {
    await this.setProfile(this.activeProfile().id, choice);
  }

  async pickProfile(): Promise<void> {
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
    if (pick?.id === '__add__') await this.addProfile();
    else if (pick?.id === '__manage__') await this.manageProfiles();
    else if (pick?.id) await this.setProfile(pick.id, pick.choice);
  }

  async addProfile(): Promise<void> {
    const id = await addProfile(this.ctx.secrets);
    if (id) await this.setProfile(id);
    this.refresh();
  }

  async manageProfiles(): Promise<void> {
    const id = await manageProfiles(this.ctx.secrets);
    if (id) await this.setProfile(id);
    this.refresh();
  }

  /** Title-bar history button: send the session list; the panel shows it as a dropdown at the top right */
  async history(): Promise<void> {
    if (!this.webviews.size) {
      // no panel open in this window yet: open the sidebar and answer once its webview reports ready
      this.historyPending = true;
      await vscode.commands.executeCommand('ccprofile.chat.focus');
      return;
    }
    this.view?.show?.(true);
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
    const items = await readTranscript(id, folder.uri.fsPath);
    if (!items.length) return this.notice('error', 'That session could not be loaded.');
    this.turn?.detach();
    this.turn = undefined;
    this.stop();
    this.sessionId = id;
    this.transcript.reset(items);
    this.pushStatus();
    void this.save();
  }

  dispose(): void {
    this.turn?.detach();
    this.running?.stop();
    void this.settings?.dispose();
    this.editorPanel?.dispose();
    this.disposables.forEach(d => d.dispose());
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
      case 'setProfile': if (typeof m.id === 'string') void this.setProfile(m.id); break;
      case 'setModel': if (typeof m.model === 'string') void this.setModel(m.model); break;
      case 'setEffort': if (typeof m.effort === 'string') void this.setEffort(m.effort); break;
      case 'setMode':
        if (PERMISSION_MODES.includes(m.mode)) { this.mode = m.mode; this.refresh(); }
        break;
      case 'addProfile': void this.addProfile(); break;
      case 'manageProfiles': void this.manageProfiles(); break;
      case 'history': void this.history(); break;
      case 'resumeSession': if (typeof m.id === 'string') void this.resumeSession(m.id); break;
      case 'deleteSession': if (typeof m.id === 'string') void this.deleteSessionById(m.id); break;
      case 'attachData':
        if (typeof m.name === 'string' && typeof m.base64 === 'string') this.addDataAttachment(m.name, typeof m.mediaType === 'string' ? m.mediaType : undefined, m.base64, m.cid);
        break;
      case 'attachFile':
        if (typeof m.name === 'string' && typeof m.base64 === 'string') this.addDataAttachment(m.name, undefined, m.base64, m.cid);
        break;
      case 'removeAttachment':
        this.pending = this.pending.filter(a => a.id !== m.id);
        this.sendState();
        break;
      case 'attachUri':
        if (typeof m.uri === 'string') void this.addUriAttachment(vscode.Uri.parse(m.uri)).then(() => this.sendState());
        break;
      case 'pickProfile': void this.pickProfile(); break;
      case 'mentionQuery': if (typeof m.queryId === 'string' && typeof m.text === 'string') void this.mention(m.queryId, m.text); break;
      case 'checkTasks': void this.send('Check your background tasks and continue.'); break;
    }
  }

  private refresh(): void {
    const p = this.activeProfile();
    const bypass = this.mode === 'bypassPermissions';
    this.statusBar.text = `${this.running ? '$(sync~spin)' : '$(arrow-swap)'} ${this.displayLabel(p)}${bypass ? ' $(unlock)' : ''}`;
    this.statusBar.tooltip = `ccprofile · ${this.displayLabel(p)} (${profileDescription(p)})\nPermission mode: ${this.mode}\nClick to switch model`;
    this.sendState();
  }

  private sendState(): void {
    const active = this.activeProfile();
    this.post({
      type: 'state',
      profiles: this.profiles().map(p => ({ id: p.id, label: p.label, description: profileDescription(p) })),
      activeId: active.id,
      model: this.selectedModel(active),
      modelChoices: modelChoices(active).map(c => ({ id: c, label: choiceLabel(c), detail: choiceDetail(active, c) })),
      effort: this.selectedEffort(),
      effortChoices: effortChoices().map(e => ({ id: e, label: e === 'xhigh' ? 'XHigh' : choiceLabel(e), detail: e === DEFAULT_MODEL ? 'ccprofile.claudeSettings effortLevel, else the CLI default' : `--effort ${e}` })),
      mode: this.mode,
      modes: PERMISSION_MODES,
      busy: !!this.running,
      items: this.transcript.items,
      attachments: this.pending.map(a => ({ id: a.id, name: a.name, kind: a.kind, mediaType: a.mediaType })),
      status: this.statusText(),
    });
  }

  private setBusy(busy: boolean): void {
    this.post({ type: 'busy', busy });
    this.refresh();
  }

  private statusText(): string {
    const s = this.status;
    return [s.model, s.auth, s.last, s.rate].filter(Boolean).join(' · ');
  }

  private pushStatus(): void {
    this.post({ type: 'status', text: this.statusText() });
  }

  private notice(level: 'info' | 'warn' | 'error', text: string, action?: 'checkTasks'): void {
    this.transcript.push({ kind: 'notice', level, text, action });
  }

  private post(msg: unknown): void {
    for (const wv of this.webviews) void wv.postMessage(msg);
  }

  private save(): Thenable<void> {
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
<body>
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

