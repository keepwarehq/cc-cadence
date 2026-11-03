import * as vscode from 'vscode';
import { CLAUDE } from './profiles';

export const keyName = (id: string) => `ccprofile.key.${id}`;

type RawProfile = Record<string, any>;

const BASE_URL_PROMPT = 'Anthropic-compatible endpoint from the provider (claude appends /v1/messages)';

// Only read/write user-level settings; profiles must not leak into the project's .vscode/settings.json
function readGlobal(): RawProfile[] {
  const v = vscode.workspace.getConfiguration('ccprofile').inspect<unknown>('profiles')?.globalValue;
  return Array.isArray(v) ? v.map(p => (p && typeof p === 'object' ? { ...p } : p)) : [];
}

function writeGlobal(list: RawProfile[]): Thenable<void> {
  return vscode.workspace.getConfiguration('ccprofile').update('profiles', list, vscode.ConfigurationTarget.Global);
}

const required = (v: string) => (v.trim() ? undefined : 'Cannot be empty');

function urlCheck(v: string): string | undefined {
  try {
    return /^https?:$/.test(new URL(v.trim()).protocol) ? undefined : 'Must start with http:// or https://';
  } catch {
    return 'Not a valid URL';
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

/** Ask for label, base URL, API key and model name in sequence; returns the new profile's id */
export async function addProfile(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const step = (n: number) => `Add model (${n}/4)`;
  const label = await ask(step(1), 'Display name', { placeHolder: 'e.g. GLM, Kimi', validateInput: required });
  if (label === undefined) return;
  const baseUrl = await ask(step(2), BASE_URL_PROMPT, { placeHolder: 'https://…', validateInput: urlCheck });
  if (baseUrl === undefined) return;
  const key = await ask(step(3), 'API Key (stored in the system keychain, never in settings)', { password: true, validateInput: required });
  if (key === undefined) return;
  const model = await ask(step(4), 'Model name (leave empty to use the provider default mapping)');
  if (model === undefined) return;

  const list = readGlobal();
  const id = uniqueId(label, list);
  const profile: RawProfile = { id, label: label.trim(), baseUrl: baseUrl.trim() };
  if (model.trim()) profile.model = model.trim();
  await secrets.store(keyName(id), key.trim());
  await writeGlobal([...list, profile]);
  return id;
}

/** Edit base URL / API key / model name / label, or delete; returns the id of a profile added here */
export async function manageProfiles(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const list = readGlobal();
  type Pick = vscode.QuickPickItem & { id?: string };
  const picks: Pick[] = list
    .filter(p => typeof p?.id === 'string' && p.baseUrl)
    .map(p => ({ label: p.label || p.id, description: p.baseUrl, id: p.id }));
  picks.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(add) Add model…', id: '__add__' },
    { label: '$(json) Edit in settings.json', id: '__json__' },
  );
  const pick = await vscode.window.showQuickPick(picks, { title: 'Manage models', placeHolder: 'Pick a model' });
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
      { label: 'Change base URL', description: p.baseUrl, a: 'url' },
      { label: hasKey ? 'Replace API key' : 'Set API key', description: hasKey ? 'Saved in the keychain' : 'Not set', a: 'key' },
      { label: 'Change model name', description: p.model || '(provider default mapping)', a: 'model' },
      { label: 'Rename', description: name, a: 'label' },
      { label: 'Delete', a: 'delete' },
    ],
    { title: `Manage "${name}"` },
  );
  if (!action) return;

  switch (action.a) {
    case 'url': {
      const v = await ask(`"${name}" base URL`, BASE_URL_PROMPT, { value: p.baseUrl, validateInput: urlCheck });
      if (v === undefined) return;
      p.baseUrl = v.trim();
      break;
    }
    case 'key': {
      const v = await ask(`"${name}" API key`, 'Stored in the system keychain, never in settings', { password: true, validateInput: required });
      if (v !== undefined) await secrets.store(keyName(id), v.trim());
      return;
    }
    case 'model': {
      const v = await ask(`"${name}" model name`, 'Leave empty to use the provider default mapping', { value: p.model ?? '' });
      if (v === undefined) return;
      if (v.trim()) p.model = v.trim();
      else delete p.model;
      break;
    }
    case 'label': {
      const v = await ask('Rename', 'Display name', { value: name, validateInput: required });
      if (v === undefined) return;
      p.label = v.trim();
      break;
    }
    case 'delete': {
      const ok = await vscode.window.showWarningMessage(`Delete "${name}" and its API key?`, { modal: true }, 'Delete');
      if (ok !== 'Delete') return;
      await secrets.delete(keyName(id));
      await writeGlobal(list.filter(x => x !== p));
      return;
    }
  }
  await writeGlobal(list);
}
