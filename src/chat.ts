import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Item, Transcript, TurnTranslator } from './transcript';
import { PERMISSION_MODES, PermissionMode, Profile, buildEnv, expandHome, isThirdParty, loadProfiles } from './profiles';
import { TurnHandle, runTurn } from './runner';
import { addProfile, keyName, manageProfiles } from './profileUi';

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
    // 权限模式不跨窗口记忆：每个窗口都从设置里的默认值（bypassPermissions）开始
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
    if (!folder || folder.uri.scheme !== 'file') return this.notice('error', '先打开一个本地文件夹再对话（不会退回到 $HOME 里跑）。');

    const profile = this.activeProfile();
    let key: string | undefined;
    if (isThirdParty(profile)) {
      key = await this.ctx.secrets.get(keyName(profile.id));
      if (!key) return this.notice('error', `「${profile.label}」还没有 API Key：在档位下拉框里选「管理模型…」设置。`);
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
          this.status.auth = 'Max 订阅';
        } else {
          this.status.auth = `⚠ ${e.apiKeySource}`;
          this.notice('warn', `Claude 档这一轮的认证来源是 ${e.apiKeySource}，不是 Max 订阅。运行「ccprofile: 自检」查原因。`);
        }
        this.pushStatus();
      },
      rateLimit: info => { this.status.rate = rateText(info); this.pushStatus(); },
      result: e => {
        if (e.is_error || e.subtype !== 'success') this.notice('error', resultError(e));
        const denied = [...new Set((e.permission_denials ?? []).map((d: any) => d?.tool_name).filter(Boolean))];
        if (denied.length) this.notice('warn', `被拒绝的工具调用：${denied.join(', ')}（权限模式 ${mode}）`);
        this.status.last = `${((e.duration_ms ?? 0) / 1000).toFixed(1)}s · ${e.num_turns ?? '?'} 轮`;
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
    if (this.turn !== turn) return; // 跑的时候点了「新对话」，这一轮的结果不要了
    this.turn = undefined;

    turn.finish(this.stopping ? '已中断' : '未完成');
    if (turn.sessionId) this.sessionId = turn.sessionId;
    if (exit.spawnError) {
      this.notice('error', `启动 claude 失败（${claudePath}）：${exit.spawnError.message}\n在设置 ccprofile.claudePath 里改路径。`);
    } else if (this.stopping) {
      this.notice('info', '已停止。');
    } else if (!turn.gotResult) {
      const tail = exit.stderr.trim().slice(-1500);
      const hint = resumed ? '\n如果是续接会话失败，点「新对话」重新开始。' : '';
      this.notice('error', `claude 异常退出（${exit.signal ?? `code ${exit.code}`}）${tail ? '\n' + tail : ''}${hint}`);
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
    // 同供应商之间 resume 没问题；跨供应商会因 thinking block signature 不兼容而 400，只能开新会话
    const compatible = isThirdParty(prev) === isThirdParty(next)
      && (!isThirdParty(prev) || prev.baseUrl === next.baseUrl);
    this.sessionId = compatible ? this.sessionId : undefined;
    if (this.transcript.items.length) {
      this.notice('info', compatible
        ? `已切换到「${next.label}」，下一条消息接着当前会话。`
        : `已切换到「${next.label}」，跨供应商会话不兼容，下一条消息将开始新会话。`);
    }
    this.refresh();
  }

  async pickProfile(): Promise<void> {
    const current = this.activeProfile().id;
    type Pick = vscode.QuickPickItem & { id?: string };
    const picks: Pick[] = this.profiles().map(p => ({
      label: `${p.id === current ? '$(check) ' : ''}${p.label}`,
      description: isThirdParty(p) ? p.baseUrl : '本机 claude -p · Max 订阅',
      id: p.id,
    }));
    picks.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(add) 添加模型…', id: '__add__' },
      { label: '$(gear) 管理模型…', id: '__manage__' },
    );
    const pick = await vscode.window.showQuickPick(picks, { title: '切换模型' });
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
    }
  }

  private refresh(): void {
    const p = this.activeProfile();
    const bypass = this.mode === 'bypassPermissions';
    this.statusBar.text = `${this.running ? '$(sync~spin)' : '$(arrow-swap)'} ${p.label}${bypass ? ' $(unlock)' : ''}`;
    this.statusBar.tooltip = `ccprofile · ${p.label}（${isThirdParty(p) ? p.baseUrl : '本机 claude -p，Max 订阅'}）\n权限模式：${this.mode}\n点击切换模型`;
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
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('chat.css')}">
</head>
<body>
<header id="bar">
  <select id="profile" title="模型"></select>
  <select id="mode" title="权限模式"></select>
  <span id="badge" class="badge" title="所有工具调用都不再询问" hidden>bypass</span>
</header>
<main id="log"></main>
<footer>
  <div id="status"></div>
  <div class="composer">
    <textarea id="input" rows="3" placeholder="Enter 发送，Shift+Enter 换行"></textarea>
    <button id="send">发送</button>
  </div>
</footer>
<script nonce="${nonce}" src="${uri('vendor', 'marked.min.js')}"></script>
<script nonce="${nonce}" src="${uri('vendor', 'purify.min.js')}"></script>
<script nonce="${nonce}" src="${uri('chat.js')}"></script>
</body>
</html>`;
  }
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function rateText(info: any): string {
  if (!info || info.status === 'allowed') return '';
  const reset = typeof info.resetsAt === 'number' ? `，${new Date(info.resetsAt * 1000).toLocaleString()} 重置` : '';
  return `额度 ${info.status}${reset}`;
}

function resultError(e: any): string {
  return String(e.result || (Array.isArray(e.errors) && e.errors.join('\n')) || e.subtype || '出错了');
}
