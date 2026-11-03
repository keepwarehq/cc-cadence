import * as os from 'node:os';

export interface Profile {
  id: string;
  label: string;
  /** Anthropic-compatible endpoint of a third party. Leave empty for the Claude profile: uses the local claude /login subscription */
  baseUrl?: string;
  /** Passed to claude --model; third-party profiles also map the opus / sonnet / haiku aliases to it */
  model?: string;
  authEnv?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  /** Per-alias models for third-party profiles; take priority over model */
  models?: { opus?: string; sonnet?: string; haiku?: string };
  env?: Record<string, string>;
}

export const CLAUDE: Profile = { id: 'claude', label: 'Claude (Max)' };

export const PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'plan', 'default', 'dontAsk', 'auto'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const isThirdParty = (p: Profile): boolean => !!p.baseUrl;

/** The picker's "no override" choice: the profile's own model (or the claude CLI default) */
export const DEFAULT_MODEL = 'default';
/** Aliases the claude CLI resolves against the Max subscription */
export const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** Levels claude --effort accepts; one setting for every profile, each vendor maps it to its own levels */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export function effortChoices(): string[] {
  return [DEFAULT_MODEL, ...EFFORT_LEVELS];
}

type Alias = keyof NonNullable<Profile['models']>;
const ALIASES: Alias[] = ['opus', 'sonnet', 'haiku'];

/** Choices the model picker offers for a profile: default first, then every alias the profile can serve */
export function modelChoices(p: Profile): string[] {
  if (!isThirdParty(p)) return [DEFAULT_MODEL, ...CLAUDE_MODELS];
  const models = p.models ?? {};
  const set = (Object.keys(models) as Alias[]).filter(k => ALIASES.includes(k) && models[k]);
  return [DEFAULT_MODEL, ...set];
}

/** What goes to claude --model for a picker choice: default keeps the profile's model; third-party aliases map through models */
export function resolveModel(p: Profile, choice?: string): string | undefined {
  if (!choice || choice === DEFAULT_MODEL) return p.model;
  if (!isThirdParty(p)) return choice;
  return (ALIASES as string[]).includes(choice) ? p.models?.[choice as Alias] ?? p.model : p.model;
}

// Variables that would steal auth priority or drag VS Code process quirks into claude: in -p mode any ANTHROPIC_API_KEY always wins,
// and ELECTRON_RUN_AS_NODE turns the `code` command run inside claude into plain node
const STRIP = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|ELECTRON_RUN_AS_NODE$)/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildEnv(base: NodeJS.ProcessEnv, p: Profile, key?: string, globalEnv?: Record<string, string>): NodeJS.ProcessEnv {
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
  // precedence: profile env > global claudeEnv > built-ins > ambient
  for (const [k, v] of Object.entries(globalEnv ?? {})) if (ENV_NAME.test(k) && typeof v === 'string') env[k] = v;
  for (const [k, v] of Object.entries(p.env ?? {})) if (ENV_NAME.test(k) && typeof v === 'string') env[k] = v;
  return env;
}

/** The built-in Claude profile always comes first; an entry with id claude in settings overrides it (e.g. to pin a model) */
export function loadProfiles(raw: unknown): { profiles: Profile[]; problems: string[] } {
  const problems: string[] = [];
  const profiles: Profile[] = [CLAUDE];
  const list: any[] = Array.isArray(raw) ? raw : [];
  list.forEach((p, i) => {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id.trim()) {
      problems.push(`ccprofile.profiles item ${i + 1} has no id and was ignored`);
      return;
    }
    const profile: Profile = { ...p, label: typeof p.label === 'string' && p.label.trim() ? p.label : p.id };
    const at = profiles.findIndex(x => x.id === profile.id);
    if (at === 0) profiles[0] = profile;
    else if (at > 0) problems.push(`duplicate profile id "${p.id}"; the later one was ignored`);
    else profiles.push(profile);
  });
  return { profiles, problems };
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? os.homedir() + p.slice(1) : p;
}
