import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SettingsFile { path: string; dispose(): Promise<void> }

/** Serialize extra settings keys to a 0600 temp file for --settings; undefined when there is nothing to pass */
export async function writeSettingsFile(settings: Record<string, unknown> | undefined): Promise<SettingsFile | undefined> {
  if (!settings || !Object.keys(settings).length) return undefined;
  const dir = await fs.promises.mkdtemp(join(tmpdir(), 'ccprofile-'));
  const file = join(dir, 'settings.json');
  await fsp.writeFile(file, JSON.stringify(settings), { mode: 0o600 });
  return {
    path: file,
    dispose: () => fsp.rm(dir, { recursive: true, force: true }),
  };
}
