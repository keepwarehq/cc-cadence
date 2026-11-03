import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Item, Transcript, TurnTranslator } from './transcript';
import { PERMISSION_MODES, PermissionMode, Profile, buildEnv, expandHome, isThirdParty, loadProfiles } from './profiles';
import { TurnHandle, runTurn } from './runner';
import { addProfile, keyName, manageProfiles } from './profileUi';
import { SessionSummary, deleteSession, listSessions, readTranscript } from './sessions';

const CHAT_KEY = 'ccprofile.chat';
const ACTIVE_KEY = 'ccprofile.activeProfile';
const MAX_SAVED_ITEMS = 300;

interface Status { model?: string; auth?: string; last?: string; rate?: string }

export class ChatController implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly transcript = new Transcript(op => this.post({ type: 'op', ...op }));
  private sessionId?: string;
  private running?: TurnHandle;
  private turn?: TurnTranslator;
  private stopping = false;
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

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage(m => this.onMessage(m), undefined, this.disposables);
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
  }

  async send(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text || this.running) return;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') return this.notice('error', 'Open a local folder first (it never falls back to running in $HOME).');

    const profile = this.activeProfile();
    let key: string | undefined;
    if (isThirdParty(profile)) {
      key = await this.ctx.secrets.get(keyName(profile.id));
      if (!key) return this.notice('error', `"${profile.label}" has no API key yet: set one via "Manage models…" in the profile dropdown.`);
    }
    const claudePath = expandHome(vscode.workspace.getConfiguration('ccprofile').get<string>('claudePath') || '~/.local/bin/claude');
    const mode = this.mode;
    const resumed = !!this.sessionId;
    this.transcript.push({ kind: 'user', text, profile: profile.label });

    const turn = new TurnTranslator(this.transcript, {
      init: e => {
        this.status.model = e.model;
        if (isThirdParty(profile)) {
          this.status.auth = hostOf(profile.baseUrl!);
        } else if (e.apiKeySource === 'none') {
          this.status.auth = 'Max subscription';
        } else {
          this.status.auth = `⚠ ${e.apiKeySource}`;
          this.notice('warn', `This turn of the Claude profile authenticated via ${e.apiKeySource}, not the Max subscription. Run "ccprofile: Doctor" to find out why.`);
        }
        this.pushStatus();
      },
      rateLimit: info => { this.status.rate = rateText(info); this.pushStatus(); },
      result: e => {
        if (e.is_error || e.subtype !== 'success') this.notice('error', resultError(e));
        const denied = [...new Set((e.permission_denials ?? []).map((d: any) => d?.tool_name).filter(Boolean))];
        if (denied.length) this.notice('warn', `Denied tool calls: ${denied.join(', ')} (permission mode ${mode})`);
        this.status.last = `${((e.duration_ms ?? 0) / 1000).toFixed(1)}s · ${e.num_turns ?? '?'} turns`;
        this.pushStatus();
      },
    });

    this.stopping = false;
    this.turn = turn;
    this.running = runTurn({
      claudePath,
      cwd: folder.uri.fsPath,
      env: buildEnv(process.env, profile, key),
      prompt: text,
      permissionMode: mode,
      sessionId: this.sessionId,
      model: profile.model,
      onEvent: e => turn.handle(e),
    });
    this.setBusy(true);
    const exit = await this.running.done;
    this.running = undefined;
    this.setBusy(false);
    if (this.turn !== turn) return; // "New chat" was pressed while running; drop this turn's results
    this.turn = undefined;

    turn.finish(this.stopping ? 'Interrupted' : 'Incomplete');
    if (turn.sessionId) this.sessionId = turn.sessionId;
    if (exit.spawnError) {
      this.notice('error', `Failed to start claude (${claudePath}): ${exit.spawnError.message}\nChange the path in the ccprofile.claudePath setting.`);
    } else if (this.stopping) {
      this.notice('info', 'Stopped.');
    } else if (!turn.gotResult) {
      const tail = exit.stderr.trim().slice(-1500);
      const hint = resumed ? '\nIf resuming the session failed, press "New chat" to start over.' : '';
      this.notice('error', `claude exited abnormally (${exit.signal ?? `code ${exit.code}`})${tail ? '\n' + tail : ''}${hint}`);
    }
    void this.save();
  }

  stop(): void {
    if (!this.running) return;
    this.stopping = true;
    this.running.stop();
  }

  newChat(): void {
    this.turn?.detach();
    this.turn = undefined;
    this.stop();
    this.sessionId = undefined;
    this.status = {};
    this.transcript.reset([]);
    this.pushStatus();
    void this.save();
  }

  async setProfile(id: string): Promise<void> {
    const prev = this.activeProfile();
    if (id === prev.id || !this.profiles().some(p => p.id === id)) return;
    await this.ctx.globalState.update(ACTIVE_KEY, id);
    const next = this.activeProfile();
    // Resuming within the same vendor is fine; across vendors the thinking block signature mismatches and 400s — only a new session works
    const compatible = isThirdParty(prev) === isThirdParty(next)
      && (!isThirdParty(prev) || prev.baseUrl === next.baseUrl);
    this.sessionId = compatible ? this.sessionId : undefined;
    if (this.transcript.items.length) {
      this.notice('info', compatible
        ? `Switched to "${next.label}"; the next message continues the current session.`
        : `Switched to "${next.label}"; sessions are not compatible across vendors, so the next message starts a new session.`);
    }
    this.refresh();
  }

  async pickProfile(): Promise<void> {
    const current = this.activeProfile().id;
    type Pick = vscode.QuickPickItem & { id?: string };
    const picks: Pick[] = this.profiles().map(p => ({
      label: `${p.id === current ? '$(check) ' : ''}${p.label}`,
      description: isThirdParty(p) ? p.baseUrl : 'local claude -p · Max subscription',
      id: p.id,
    }));
    picks.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(add) Add model…', id: '__add__' },
      { label: '$(gear) Manage models…', id: '__manage__' },
    );
    const pick = await vscode.window.showQuickPick(picks, { title: 'Switch model' });
    if (pick?.id === '__add__') await this.addProfile();
    else if (pick?.id === '__manage__') await this.manageProfiles();
    else if (pick?.id) await this.setProfile(pick.id);
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

  async history(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') return this.notice('error', 'Open a local folder first (it never falls back to running in $HOME).');
    const sessions = await listSessions(folder.uri.fsPath);
    if (!sessions.length) return this.notice('info', 'No saved sessions for this folder yet.');
    type Pick = vscode.QuickPickItem & { id?: string };
    const picks: Pick[] = sessions.map(s => ({
      label: s.title,
      description: relativeTime(s.mtimeMs),
      detail: `${Math.max(1, Math.round(s.sizeBytes / 1024))} KB`,
      id: s.sessionId,
    }));
    picks.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(trash) Delete…', id: '__delete__' },
    );
    const pick = await vscode.window.showQuickPick(picks, { title: 'History' });
    if (!pick) return;
    if (pick.id === '__delete__') return this.pickDelete(folder.uri.fsPath, sessions);
    if (pick.id) await this.resumeSession(pick.id);
  }

  private async pickDelete(cwd: string, sessions: SessionSummary[]): Promise<void> {
    type Pick = vscode.QuickPickItem & { id: string };
    const picks: Pick[] = sessions.map(s => ({ label: s.title, description: relativeTime(s.mtimeMs), id: s.sessionId }));
    const doomed = await vscode.window.showQuickPick(picks, { title: 'Delete sessions', canPickMany: true });
    if (!doomed?.length) return;
    for (const d of doomed) {
      await deleteSession(d.id, cwd);
      if (d.id === this.sessionId) this.sessionId = undefined;
    }
    this.notice('info', `Deleted ${doomed.length} session${doomed.length === 1 ? '' : 's'}.`);
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
    this.disposables.forEach(d => d.dispose());
  }

  private onMessage(m: any): void {
    switch (m?.type) {
      case 'ready': this.sendState(); break;
      case 'send': if (typeof m.text === 'string') void this.send(m.text); break;
      case 'stop': this.stop(); break;
      case 'newChat': this.newChat(); break;
      case 'setProfile': if (typeof m.id === 'string') void this.setProfile(m.id); break;
      case 'setMode':
        if (PERMISSION_MODES.includes(m.mode)) { this.mode = m.mode; this.refresh(); }
        break;
      case 'addProfile': void this.addProfile(); break;
      case 'manageProfiles': void this.manageProfiles(); break;
      case 'history': void this.history(); break;
      case 'resumeSession': if (typeof m.id === 'string') void this.resumeSession(m.id); break;
      case 'deleteSession': if (typeof m.id === 'string') void this.history(); break;
    }
  }

  private refresh(): void {
    const p = this.activeProfile();
    const bypass = this.mode === 'bypassPermissions';
    this.statusBar.text = `${this.running ? '$(sync~spin)' : '$(arrow-swap)'} ${p.label}${bypass ? ' $(unlock)' : ''}`;
    this.statusBar.tooltip = `ccprofile · ${p.label} (${isThirdParty(p) ? p.baseUrl : 'local claude -p, Max subscription'})\nPermission mode: ${this.mode}\nClick to switch model`;
    this.sendState();
  }

  private sendState(): void {
    this.post({
      type: 'state',
      profiles: this.profiles().map(p => ({ id: p.id, label: p.label })),
      activeId: this.activeProfile().id,
      mode: this.mode,
      modes: PERMISSION_MODES,
      busy: !!this.running,
      items: this.transcript.items,
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

  private notice(level: 'info' | 'warn' | 'error', text: string): void {
    this.transcript.push({ kind: 'notice', level, text });
  }

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
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
<header id="bar">
  <select id="profile" title="Model"></select>
  <select id="mode" title="Permission mode"></select>
  <span id="badge" class="badge" title="Tool calls never ask for permission" hidden>bypass</span>
  <button id="history" class="ghost" title="History">🕘</button>
</header>
<main id="log"></main>
<footer>
  <div id="status"></div>
  <div class="composer">
    <textarea id="input" rows="3" placeholder="Enter to send, Shift+Enter for a new line"></textarea>
    <button id="send">Send</button>
  </div>
</footer>
<script nonce="${nonce}" src="${uri('vendor', 'marked.min.js')}"></script>
<script nonce="${nonce}" src="${uri('vendor', 'purify.min.js')}"></script>
<script nonce="${nonce}" src="${uri('chat.js')}"></script>
</body>
</html>`;
  }
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

function resultError(e: any): string {
  return String(e.result || (Array.isArray(e.errors) && e.errors.join('\n')) || e.subtype || 'Something went wrong');
}
