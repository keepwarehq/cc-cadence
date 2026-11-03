import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { writeSettingsFile } = await import('../out/settingsFile.js');

test('writes settings.json readable only by the owner, with the given JSON', async () => {
  const f = await writeSettingsFile({ effortLevel: 'xhigh', model: 'glm-5.3' });
  assert.ok(f);
  assert.equal(readFileSync(f.path, 'utf8'), JSON.stringify({ effortLevel: 'xhigh', model: 'glm-5.3' }));
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.ok(dirname(f.path).startsWith(tmpdir()));
  await f.dispose();
  assert.equal(existsSync(f.path), false);
});

test('returns undefined for empty or missing settings', async () => {
  assert.equal(await writeSettingsFile({}), undefined);
  assert.equal(await writeSettingsFile(undefined), undefined);
});

test('dispose removes the temp directory', async () => {
  const f = await writeSettingsFile({ a: 1 });
  assert.ok(f);
  const dir = dirname(f.path);
  await f.dispose();
  assert.equal(existsSync(dir), false);
});
