import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ccprofile-sessions-'));
const { configDir, slugFor, listSessions, readTranscript, deleteSession } = await import('../out/sessions.js');

test('slugFor replaces every non-alphanumeric character with a dash', () => {
  assert.equal(slugFor('/home/u.code/my_app'), '-home-u-code-my-app');
  assert.equal(slugFor('/home/junchen/code'), '-home-junchen-code');
  assert.equal(slugFor('/tmp/记事 簿'), '-tmp-----');
});

test('configDir honors CLAUDE_CONFIG_DIR', () => {
  assert.equal(configDir(), process.env.CLAUDE_CONFIG_DIR);
});

test('listSessions returns titles from ai-title, skips empty files, sorts mtime desc', async () => {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-w');
  mkdirSync(dir, { recursive: true });
  const fixture = join(import.meta.dirname, 'fixtures', 'session.jsonl');
  const a = join(dir, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl');
  const b = join(dir, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl');
  const c = join(dir, 'cccccccc-1111-2222-3333-444444444444.jsonl');
  writeFileSync(a, '{"type":"user","message":{"role":"user","content":"old chat"}}\n', 'utf8');
  writeFileSync(b, '', 'utf8');
  const fixtureText = readFileSync(fixture, 'utf8');
  writeFileSync(c, fixtureText);
  utimesSync(a, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  utimesSync(c, new Date(), new Date());

  const list = await listSessions('/w');
  assert.deepEqual(list.map(s => s.sessionId), ['cccccccc-1111-2222-3333-444444444444', 'aaaaaaaa-1111-2222-3333-444444444444']);
  assert.equal(list[0].title, 'Fix login bug');
  assert.equal(list[1].title, 'old chat');
});

test('readTranscript replays the fixture into items, skipping sidechain records', async () => {
  const items = await readTranscript('cccccccc-1111-2222-3333-444444444444', '/w');
  assert.deepEqual(items.map(i => i.kind), ['user', 'thinking', 'tool', 'assistant']);
  assert.equal(items[0].text, 'fix the login bug');
  assert.equal(items[1].text, 'let me look at the auth code');
  assert.equal(items[2].name, 'Read');
  assert.equal(items[2].status, 'ok');
  assert.equal(items[2].output, 'file body line');
  assert.equal(items[3].text, 'The null check is missing.');
  assert.ok(!JSON.stringify(items).includes('sidechain'));
});

test('deleteSession removes the jsonl file', async () => {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-w');
  const d = join(dir, 'dddddddd-1111-2222-3333-444444444444.jsonl');
  writeFileSync(d, '{"type":"user","message":{"role":"user","content":"bye"}}\n', 'utf8');
  await deleteSession('dddddddd-1111-2222-3333-444444444444', '/w');
  assert.equal(existsSync(d), false);
  rmSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
});
