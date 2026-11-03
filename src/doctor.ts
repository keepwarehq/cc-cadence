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

/** Most common reason a switch does not take effect: claude missing, env overrides in settings files stealing auth, third-party profile without a key */
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
    if (v.ok) ok(`claude: ${bin} (${v.text})`);
    else warn(`claude --version failed (${bin}): ${v.text}`);
  } catch {
    warn(`claude executable not found: ${bin} — fix it in the ccprofile.claudePath setting`);
  }

  const files = [path.join(os.homedir(), '.claude', 'settings.json')];
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f.uri.scheme !== 'file') continue;
    files.push(path.join(f.uri.fsPath, '.claude', 'settings.json'), path.join(f.uri.fsPath, '.claude', 'settings.local.json'));
  }
  for (const f of files) {
    const r = envOverrides(f);
    if (r === 'missing') continue;
    if (r === 'invalid') warn(`${f} is not valid JSON`);
    else if (r.length) warn(`${f} has env keys ${r.join(', ')}: env in a settings file outranks the process environment and ccprofile cannot strip it — every profile is affected`);
    else ok(`${f}: no auth-overriding env`);
  }

  const inherited = Object.keys(process.env).filter(k => OVERRIDE.test(k));
  if (inherited.length) info(`VS Code's own environment has ${inherited.join(', ')}; they are removed before spawning claude`);
  if (process.env.CLAUDE_CONFIG_DIR) info(`CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR}: claude uses the login in that directory`);

  const { profiles, problems: profileProblems } = loadProfiles(cfg.get('profiles'));
  for (const p of profileProblems) warn(p);
  for (const p of profiles.filter(isThirdParty)) {
    if (await secrets.get(keyName(p.id))) ok(`"${p.label}" ${p.baseUrl}: API key saved`);
    else warn(`"${p.label}" has no API key yet`);
  }
  info('Whether the Claude profile really uses the Max subscription: check the status line after each turn says "Max subscription"');

  channel.clear();
  channel.appendLine(`CC Cadence doctor ${new Date().toLocaleString()}`);
  for (const l of lines) channel.appendLine(l);
  channel.show(true);
  void vscode.window.showInformationMessage(problems ? `CC Cadence doctor: ${problems} problem(s), see the output panel` : 'CC Cadence doctor: no problems found');
}
