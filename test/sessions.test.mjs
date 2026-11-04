import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync, readFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ccprofile-sessions-'));
const { configDir, slugFor, listSessions, readTranscript, deleteSession, readSubagentTranscript, readSessionTitle, appendAiTitle, fallbackTitle, sessionPath, projectDir } = await import('../out/sessions.js');

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

test('readTranscript replays array-content user messages (text and image blocks)', async () => {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-w2');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'eeeeeeee-1111-2222-3333-444444444444.jsonl');
  writeFileSync(f, [
    JSON.stringify({ type: 'user', uuid: 'u1', isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'a screenshot' }] } }),
    '',
  ].join('\n'), 'utf8');
  const items = await readTranscript('eeeeeeee-1111-2222-3333-444444444444', '/w2');
  assert.equal(items[0].kind, 'user');
  assert.equal(items[0].text.includes('what is this?'), true);
  assert.equal(items[0].text.includes('image'), true);
  assert.equal(items[1].text, 'a screenshot');
  rmSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
});

test('readTranscript hands image blocks to onImage and shows them as attachments instead of placeholder text', async () => {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-w3');
  mkdirSync(dir, { recursive: true });
  const id = 'ffffffff-1111-2222-3333-444444444444';
  const img = data => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
  writeFileSync(join(dir, `${id}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'two shots' }, img('aGk='), img('eW8=')] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [img('c2tpcA==')] } }),
    '',
  ].join('\n'), 'utf8');
  const seen = [];
  const items = await readTranscript(id, '/w3', (mediaType, base64) => {
    seen.push([mediaType, base64]);
    return base64 === 'c2tpcA==' ? undefined : `${base64.slice(0, 2)}.png`;
  });
  assert.deepEqual(seen, [['image/png', 'aGk='], ['image/png', 'eW8='], ['image/png', 'c2tpcA==']]);
  assert.deepEqual(items[0], { kind: 'user', text: 'two shots', attachments: [
    { name: 'image-1.png', mediaType: 'image/png', file: 'aG.png' },
    { name: 'image-2.png', mediaType: 'image/png', file: 'eW.png' },
  ] });
  // a declined image keeps the placeholder
  assert.deepEqual(items[1], { kind: 'user', text: '[1 image attached]' });
  rmSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
});

test('readSubagentTranscript replays a subagent transcript (all sidechain records) for the detail panel', async () => {
  const sid = '99999999-1111-2222-3333-444444444444';
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-w4', sid, 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent-a76a.jsonl'), [
    JSON.stringify({ isSidechain: true, agentId: 'a76a', type: 'user', message: { role: 'user', content: 'Run sleep then reply A' } }),
    JSON.stringify({ isSidechain: true, agentId: 'a76a', type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'sleep 5' } }] } }),
    JSON.stringify({ isSidechain: true, agentId: 'a76a', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: '(Bash completed with no output)' }] } }),
    JSON.stringify({ isSidechain: true, agentId: 'a76a', type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } }),
    '',
  ].join('\n'), 'utf8');
  const items = await readSubagentTranscript(sid, '/w4', 'a76a');
  assert.deepEqual(items.map(i => i.kind), ['user', 'tool', 'assistant']);
  assert.equal(items[1].output, '(Bash completed with no output)');
  assert.deepEqual(await readSubagentTranscript(sid, '/w4', 'missing'), []);
  rmSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
});

test('readSessionTitle: the first ai-title, and the first user text (plain or the text blocks of an attachment send)', async () => {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-t');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 's1.jsonl'), [
    '{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGk="}},{"type":"text","text":"why is this card misaligned"}]}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"looking"}]}}',
    '{"type":"ai-title","aiTitle":"Card alignment","sessionId":"s1"}',
    '{"type":"ai-title","aiTitle":"Card alignment","sessionId":"s1"}',
  ].join('\n') + '\n');
  assert.deepEqual(await readSessionTitle('s1', '/t'), { aiTitle: 'Card alignment', firstText: 'why is this card misaligned' });
  writeFileSync(join(dir, 's2.jsonl'), '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}}\n{"type":"user","message":{"role":"user","content":"real question"}}\n');
  assert.deepEqual(await readSessionTitle('s2', '/t'), { aiTitle: undefined, firstText: 'real question' });
  assert.deepEqual(await readSessionTitle('missing', '/t'), { aiTitle: undefined, firstText: undefined });
});

test('appendAiTitle appends a CLI-shaped ai-title line that listSessions and readSessionTitle pick up', async () => {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-a');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'abc.jsonl');
  assert.equal(sessionPath('abc', '/a'), file);
  // no trailing newline: the record must still start on its own line
  writeFileSync(file, '{"type":"user","message":{"role":"user","content":"name   this\\nchat"}}');
  assert.equal((await listSessions('/a'))[0].title, 'name this chat', 'fallback: first message on one line');
  assert.equal(await appendAiTitle('abc', '/a', 'Session naming'), true);
  const lines = readFileSync(file, 'utf8').split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '');
  assert.deepEqual(JSON.parse(lines[1]), { type: 'ai-title', aiTitle: 'Session naming', sessionId: 'abc' });
  assert.equal((await readSessionTitle('abc', '/a')).aiTitle, 'Session naming');
  assert.equal((await listSessions('/a'))[0].title, 'Session naming');
});

test('appendAiTitle never creates a session file and skips an empty one', async () => {
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-n');
  mkdirSync(dir, { recursive: true });
  assert.equal(await appendAiTitle('nope', '/n', 'X'), false);
  assert.equal(existsSync(join(dir, 'nope.jsonl')), false);
  writeFileSync(join(dir, 'empty.jsonl'), '');
  assert.equal(await appendAiTitle('empty', '/n', 'X'), false);
  assert.equal(readFileSync(join(dir, 'empty.jsonl'), 'utf8'), '');
});

test('fallbackTitle puts the first message on one line and clips it to 60 characters', () => {
  assert.equal(fallbackTitle('  fix\n\tthe   bug '), 'fix the bug');
  const long = fallbackTitle('z'.repeat(100));
  assert.equal(long.length, 61);
  assert.ok(long.endsWith('…'));
});

test('projectDir slugs the real path, like claude does for a symlinked workspace', () => {
  const real = mkdtempSync(join(tmpdir(), 'ccprofile-real-'));
  const link = join(mkdtempSync(join(tmpdir(), 'ccprofile-link-')), 'ws');
  symlinkSync(real, link);
  const expected = join(process.env.CLAUDE_CONFIG_DIR, 'projects', slugFor(realpathSync(real)));
  assert.equal(projectDir(link), expected);
  assert.equal(projectDir(real), expected);
  assert.equal(projectDir('/does/not/exist'), join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-does-not-exist'));
});
