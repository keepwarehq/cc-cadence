import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { expandHome, isThirdParty, loadProfiles } from './profiles';
import { keyName } from './profileUi';

const OVERRIDE = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$)/;
let channel: vscode.OutputChannel | undefined;

function envOverrides(file: string): string[] | 'missing' | 'invalid' {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return 'missing'; }
  try {
    const env = JSON.parse(text)?.env;
    return Object.keys(env && typeof env === 'object' ? env : {}).filter(k => OVERRIDE.test(k));
  } catch {
    return 'invalid';
  }
}

function claudeVersion(bin: string): Promise<{ ok: boolean; text: string }> {
  return new Promise(resolve =>
    execFile(bin, ['--version'], { timeout: 15000 }, (err, out) =>
      resolve(err ? { ok: false, text: err.message } : { ok: true, text: String(out).trim() })));
}

/** 切换不生效时最常见的原因：claude 找不到、settings 文件里的 env 抢了认证、第三方档没 key */
export async function runDoctor(secrets: vscode.SecretStorage): Promise<void> {
  channel ??= vscode.window.createOutputChannel('ccprofile');
  const lines: string[] = [];
  let problems = 0;
  const ok = (s: string) => lines.push(`✓ ${s}`);
  const warn = (s: string) => { problems++; lines.push(`⚠ ${s}`); };
  const info = (s: string) => lines.push(`· ${s}`);

  const cfg = vscode.workspace.getConfiguration('ccprofile');
  const bin = expandHome(cfg.get<string>('claudePath') || '~/.local/bin/claude');
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    const v = await claudeVersion(bin);
    if (v.ok) ok(`claude：${bin}（${v.text}）`);
    else warn(`claude --version 失败（${bin}）：${v.text}`);
  } catch {
    warn(`找不到可执行的 claude：${bin}，在设置 ccprofile.claudePath 里改`);
  }

  const files = [path.join(os.homedir(), '.claude', 'settings.json')];
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f.uri.scheme !== 'file') continue;
    files.push(path.join(f.uri.fsPath, '.claude', 'settings.json'), path.join(f.uri.fsPath, '.claude', 'settings.local.json'));
  }
  for (const f of files) {
    const r = envOverrides(f);
    if (r === 'missing') continue;
    if (r === 'invalid') warn(`${f} 不是合法 JSON`);
    else if (r.length) warn(`${f} 的 env 里有 ${r.join(', ')}：settings 文件里的 env 比进程环境优先，ccprofile 去不掉，所有档位都会受影响`);
    else ok(`${f}：没有覆盖认证的 env`);
  }

  const inherited = Object.keys(process.env).filter(k => OVERRIDE.test(k));
  if (inherited.length) info(`VS Code 进程环境里有 ${inherited.join(', ')}，启动 claude 前会被去掉`);
  if (process.env.CLAUDE_CONFIG_DIR) info(`CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR}：claude 会用这个目录下的登录`);

  const { profiles, problems: profileProblems } = loadProfiles(cfg.get('profiles'));
  for (const p of profileProblems) warn(p);
  for (const p of profiles.filter(isThirdParty)) {
    if (await secrets.get(keyName(p.id))) ok(`「${p.label}」${p.baseUrl}：API Key 已保存`);
    else warn(`「${p.label}」还没有 API Key`);
  }
  info('Claude 档是否走 Max 订阅：看每轮开始后状态行显示的是不是「Max 订阅」');

  channel.clear();
  channel.appendLine(`ccprofile 自检 ${new Date().toLocaleString()}`);
  for (const l of lines) channel.appendLine(l);
  channel.show(true);
  void vscode.window.showInformationMessage(problems ? `ccprofile 自检：${problems} 个问题，详见输出面板` : 'ccprofile 自检：没发现问题');
}
