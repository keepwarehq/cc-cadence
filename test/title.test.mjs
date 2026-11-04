import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { cleanTitle, titlePrompt, titleArgs, generateTitle, tabTitle, TITLE_MODEL } = await import('../out/title.js');

// A stub "claude" that records argv / stdin / cwd into $RECORD_OUT, then behaves per $STUB_MODE
const stub = join(mkdtempSync(join(tmpdir(), 'ccprofile-title-stub-')), 'claude');
writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.RECORD_OUT, JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8'), cwd: process.cwd() }));
const mode = process.env.STUB_MODE;
if (mode === 'hang') setTimeout(() => {}, 60000);
else if (mode === 'error') console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' }));
else if (mode === 'garbage') console.log('not json');
else console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: process.env.STUB_RESULT }));
`, { mode: 0o755 });
const record = join(mkdtempSync(join(tmpdir(), 'ccprofile-title-rec-')), 'record.json');
const env = extra => ({ ...process.env, RECORD_OUT: record, ...extra });

test('cleanTitle keeps the first line and strips quotes, markdown, labels and trailing punctuation', () => {
  assert.equal(cleanTitle('Fix login bug'), 'Fix login bug');
  assert.equal(cleanTitle('"Fix login bug."'), 'Fix login bug');
  assert.equal(cleanTitle('**Title: Fix login bug**\n\nSome explanation'), 'Fix login bug');
  assert.equal(cleanTitle('# Debug   flaky\ttests'), 'Debug flaky tests');
  assert.equal(cleanTitle('「Subagent 卡片对齐问题」。'), 'Subagent 卡片对齐问题');
  assert.equal(cleanTitle('标题：会话命名'), '会话命名');
  assert.equal(cleanTitle('\n\n  '), undefined);
  assert.equal(cleanTitle('""'), undefined);
  assert.equal(cleanTitle(42), undefined);
  assert.equal(cleanTitle('x'.repeat(200)).length, 80);
});

test('titlePrompt fences the first message and clips it', () => {
  const p = titlePrompt('  write a poem  ');
  assert.match(p, /<message>\nwrite a poem\n<\/message>/);
  assert.ok(titlePrompt('y'.repeat(5000)).length < 2200);
});

test('titleArgs: one isolated fast-model call that leaves no session file and runs no tools', () => {
  const a = titleArgs();
  assert.equal(a[a.indexOf('--model') + 1], TITLE_MODEL);
  assert.equal(TITLE_MODEL, 'haiku');
  assert.ok(a.includes('--no-session-persistence'));
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.equal(a[a.indexOf('--setting-sources') + 1], '');
  assert.ok(a.includes('--strict-mcp-config'));
  assert.equal(a[a.indexOf('--output-format') + 1], 'json');
  assert.ok(!a.includes('--resume'));
});

test('generateTitle sends the prompt on stdin from a scratch cwd and returns the cleaned title', async () => {
  const t = await generateTitle({ claudePath: stub, env: env({ STUB_RESULT: '"Fix login bug."\n' }), firstMessage: 'the login page 500s' });
  assert.equal(t, 'Fix login bug');
  const rec = JSON.parse(readFileSync(record, 'utf8'));
  assert.match(rec.stdin, /the login page 500s/);
  assert.equal(realpathSync(rec.cwd), realpathSync(tmpdir()));
  assert.ok(rec.argv.includes('--no-session-persistence'));
});

test('generateTitle resolves undefined on an error result, bad output, a missing binary or a timeout', async () => {
  assert.equal(await generateTitle({ claudePath: stub, env: env({ STUB_MODE: 'error' }), firstMessage: 'x' }), undefined);
  assert.equal(await generateTitle({ claudePath: stub, env: env({ STUB_MODE: 'garbage' }), firstMessage: 'x' }), undefined);
  assert.equal(await generateTitle({ claudePath: '/nonexistent/claude', env: env(), firstMessage: 'x' }), undefined);
  const started = Date.now();
  assert.equal(await generateTitle({ claudePath: stub, env: env({ STUB_MODE: 'hang' }), firstMessage: 'x', timeoutMs: 300 }), undefined);
  assert.ok(Date.now() - started < 5000);
});

test('tabTitle: the product name for an empty chat, otherwise the title on one line clipped to tab width', () => {
  assert.equal(tabTitle(undefined), 'CC Cadence');
  assert.equal(tabTitle(''), 'CC Cadence');
  assert.equal(tabTitle('Fix\nlogin  bug'), 'Fix login bug');
  const long = tabTitle('a'.repeat(100));
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('…'));
});
