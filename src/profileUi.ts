import * as vscode from 'vscode';
import { CLAUDE } from './profiles';

export const keyName = (id: string) => `ccprofile.key.${id}`;

type RawProfile = Record<string, any>;

const BASE_URL_PROMPT = '服务商提供的 Anthropic 兼容地址（claude 会在后面拼 /v1/messages）';

// 只读写用户级设置，避免把档位写进项目的 .vscode/settings.json
function readGlobal(): RawProfile[] {
  const v = vscode.workspace.getConfiguration('ccprofile').inspect<unknown>('profiles')?.globalValue;
  return Array.isArray(v) ? v.map(p => (p && typeof p === 'object' ? { ...p } : p)) : [];
}

function writeGlobal(list: RawProfile[]): Thenable<void> {
  return vscode.workspace.getConfiguration('ccprofile').update('profiles', list, vscode.ConfigurationTarget.Global);
}

const required = (v: string) => (v.trim() ? undefined : '不能为空');

function urlCheck(v: string): string | undefined {
  try {
    return /^https?:$/.test(new URL(v.trim()).protocol) ? undefined : '要以 http:// 或 https:// 开头';
  } catch {
    return '不是有效的 URL';
  }
}

function ask(title: string, prompt: string, opts: vscode.InputBoxOptions = {}): Thenable<string | undefined> {
  return vscode.window.showInputBox({ title, prompt, ignoreFocusOut: true, ...opts });
}

function uniqueId(label: string, list: RawProfile[]): string {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
  const taken = new Set([CLAUDE.id, ...list.map(p => p?.id)]);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** 依次问名称、Base URL、API Key、模型名；返回新档位的 id */
export async function addProfile(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const step = (n: number) => `添加模型（${n}/4）`;
  const label = await ask(step(1), '显示名称', { placeHolder: '例如 GLM、Kimi', validateInput: required });
  if (label === undefined) return;
  const baseUrl = await ask(step(2), BASE_URL_PROMPT, { placeHolder: 'https://…', validateInput: urlCheck });
  if (baseUrl === undefined) return;
  const key = await ask(step(3), 'API Key（存进系统钥匙串，不写进设置文件）', { password: true, validateInput: required });
  if (key === undefined) return;
  const model = await ask(step(4), '模型名（可留空：留空则用服务商的默认映射）');
  if (model === undefined) return;

  const list = readGlobal();
  const id = uniqueId(label, list);
  const profile: RawProfile = { id, label: label.trim(), baseUrl: baseUrl.trim() };
  if (model.trim()) profile.model = model.trim();
  await secrets.store(keyName(id), key.trim());
  await writeGlobal([...list, profile]);
  return id;
}

/** 改 Base URL / API Key / 模型名 / 名称，或删除；从这里新加的档位返回它的 id */
export async function manageProfiles(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const list = readGlobal();
  type Pick = vscode.QuickPickItem & { id?: string };
  const picks: Pick[] = list
    .filter(p => typeof p?.id === 'string' && p.baseUrl)
    .map(p => ({ label: p.label || p.id, description: p.baseUrl, id: p.id }));
  picks.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(add) 添加模型…', id: '__add__' },
    { label: '$(json) 在 settings.json 里编辑', id: '__json__' },
  );
  const pick = await vscode.window.showQuickPick(picks, { title: '管理模型', placeHolder: '选一个模型' });
  if (!pick?.id) return;
  if (pick.id === '__add__') return addProfile(secrets);
  if (pick.id === '__json__') {
    await vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: 'ccprofile.profiles', edit: true } });
    return;
  }

  const id = pick.id;
  const p = list.find(x => x?.id === id);
  if (!p) return;
  const name = p.label || id;
  const hasKey = !!(await secrets.get(keyName(id)));
  const action = await vscode.window.showQuickPick(
    [
      { label: '修改 Base URL', description: p.baseUrl, a: 'url' },
      { label: hasKey ? '更换 API Key' : '设置 API Key', description: hasKey ? '已保存在钥匙串' : '未设置', a: 'key' },
      { label: '修改模型名', description: p.model || '（服务商默认映射）', a: 'model' },
      { label: '重命名', description: name, a: 'label' },
      { label: '删除', a: 'delete' },
    ],
    { title: `管理「${name}」` },
  );
  if (!action) return;

  switch (action.a) {
    case 'url': {
      const v = await ask(`「${name}」Base URL`, BASE_URL_PROMPT, { value: p.baseUrl, validateInput: urlCheck });
      if (v === undefined) return;
      p.baseUrl = v.trim();
      break;
    }
    case 'key': {
      const v = await ask(`「${name}」API Key`, '存进系统钥匙串，不写进设置文件', { password: true, validateInput: required });
      if (v !== undefined) await secrets.store(keyName(id), v.trim());
      return;
    }
    case 'model': {
      const v = await ask(`「${name}」模型名`, '留空则用服务商的默认映射', { value: p.model ?? '' });
      if (v === undefined) return;
      if (v.trim()) p.model = v.trim();
      else delete p.model;
      break;
    }
    case 'label': {
      const v = await ask('重命名', '显示名称', { value: name, validateInput: required });
      if (v === undefined) return;
      p.label = v.trim();
      break;
    }
    case 'delete': {
      const ok = await vscode.window.showWarningMessage(`删除「${name}」和它的 API Key？`, { modal: true }, '删除');
      if (ok !== '删除') return;
      await secrets.delete(keyName(id));
      await writeGlobal(list.filter(x => x !== p));
      return;
    }
  }
  await writeGlobal(list);
}
