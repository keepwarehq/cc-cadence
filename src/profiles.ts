import * as os from 'node:os';

export interface Profile {
  id: string;
  label: string;
  /** 第三方 Anthropic 兼容地址。不填就是 Claude 档：直接用本机 claude 的 /login 订阅 */
  baseUrl?: string;
  /** 传给 claude --model；第三方档同时映射 opus / sonnet / haiku 三个别名 */
  model?: string;
  authEnv?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  /** 第三方档按别名分别指定模型，优先于 model */
  models?: { opus?: string; sonnet?: string; haiku?: string };
  env?: Record<string, string>;
}

export const CLAUDE: Profile = { id: 'claude', label: 'Claude (Max)' };

export const PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'plan', 'default', 'dontAsk', 'auto'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const isThirdParty = (p: Profile): boolean => !!p.baseUrl;

// 会抢认证优先级或带进 VS Code 进程特性的变量：-p 模式下只要有 ANTHROPIC_API_KEY 就一定会用它，
// ELECTRON_RUN_AS_NODE 会让 claude 里跑的 `code` 命令变成 node
const STRIP = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|ELECTRON_RUN_AS_NODE$)/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildEnv(base: NodeJS.ProcessEnv, p: Profile, key?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!STRIP.test(k)) env[k] = v;
  if (p.baseUrl) {
    env.ANTHROPIC_BASE_URL = p.baseUrl;
    if (key) env[p.authEnv ?? 'ANTHROPIC_AUTH_TOKEN'] = key;
    const set = (name: string, value?: string) => { if (value) env[name] = value; };
    set('ANTHROPIC_MODEL', p.model);
    set('ANTHROPIC_DEFAULT_OPUS_MODEL', p.models?.opus ?? p.model);
    set('ANTHROPIC_DEFAULT_SONNET_MODEL', p.models?.sonnet ?? p.model);
    set('ANTHROPIC_DEFAULT_HAIKU_MODEL', p.models?.haiku ?? p.model);
  }
  for (const [k, v] of Object.entries(p.env ?? {})) if (ENV_NAME.test(k) && typeof v === 'string') env[k] = v;
  return env;
}

/** 内置 Claude 档永远在第一位；设置里 id 为 claude 的条目可以覆盖它（比如指定 model） */
export function loadProfiles(raw: unknown): { profiles: Profile[]; problems: string[] } {
  const problems: string[] = [];
  const profiles: Profile[] = [CLAUDE];
  const list: any[] = Array.isArray(raw) ? raw : [];
  list.forEach((p, i) => {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id.trim()) {
      problems.push(`ccprofile.profiles 第 ${i + 1} 项缺少 id，已忽略`);
      return;
    }
    const profile: Profile = { ...p, label: typeof p.label === 'string' && p.label.trim() ? p.label : p.id };
    const at = profiles.findIndex(x => x.id === profile.id);
    if (at === 0) profiles[0] = profile;
    else if (at > 0) problems.push(`档位 id「${p.id}」重复，已忽略后一个`);
    else profiles.push(profile);
  });
  return { profiles, problems };
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? os.homedir() + p.slice(1) : p;
}
