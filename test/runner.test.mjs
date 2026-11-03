import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runTurn } = await import('../out/runner.js');
const { Transcript, TurnTranslator } = await import('../out/transcript.js');

// A stub "claude" (shebang script) that records argv+stdin into $RECORD_OUT, then emits one result line
const stub = join(mkdtempSync(join(tmpdir(), 'ccprofile-stub-')), 'claude');
writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.RECORD_OUT, JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'stub-1', num_turns: 1 }));
`, { mode: 0o755 });
const record = join(mkdtempSync(join(tmpdir(), 'ccprofile-rec-')), 'record.json');

const env = () => ({ ...process.env, RECORD_OUT: record });

test('runTurn sends the message as a stream-json user line and passes --input-format/--settings', async () => {
  const h = runTurn({
    claudePath: stub,
    cwd: tmpdir(),
    env: env(),
    message: {
      text: 'look at this',
      blocks: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
        { type: 'text', text: 'look at this' },
      ],
    },
    permissionMode: 'bypassPermissions',
    settingsPath: '/tmp/fake-settings.json',
    sessionId: 'sess-9',
    onEvent: () => {},
  });
  const exit = await h.done;
  assert.equal(exit.spawnError, undefined);
  const rec = JSON.parse(readFileSync(record, 'utf8'));
  assert.ok(rec.argv.includes('--input-format'));
  assert.ok(rec.argv.includes('stream-json'));
  const at = rec.argv.indexOf('--settings');
  assert.notEqual(at, -1);
  assert.equal(rec.argv[at + 1], '/tmp/fake-settings.json');
  assert.ok(rec.argv.includes('--resume'));
  const line = JSON.parse(rec.stdin);
  assert.equal(line.type, 'user');
  assert.equal(line.message.role, 'user');
  assert.equal(line.message.content[0].type, 'image');
  assert.equal(line.message.content[0].source.data, 'aGk=');
  assert.equal(line.message.content.at(-1).text, 'look at this');
});

test('runTurn falls back to a plain text block when there are no blocks', async () => {
  writeFileSync(record, '', 'utf8');
  const h = runTurn({
    claudePath: stub,
    cwd: tmpdir(),
    env: env(),
    message: { text: 'hello', blocks: [] },
    permissionMode: 'default',
    onEvent: () => {},
  });
  await h.done;
  const rec = JSON.parse(readFileSync(record, 'utf8'));
  const line = JSON.parse(rec.stdin);
  assert.equal(line.message.content, 'hello');
});

test('runTurn events still flow through TurnTranslator', async () => {
  writeFileSync(record, '', 'utf8');
  const t = new Transcript();
  const tr = new TurnTranslator(t);
  const h = runTurn({
    claudePath: stub,
    cwd: tmpdir(),
    env: env(),
    message: { text: 'hi', blocks: [] },
    permissionMode: 'default',
    onEvent: e => tr.handle(e),
  });
  await h.done;
  assert.equal(tr.sessionId, 'stub-1');
  assert.ok(tr.gotResult);
});
