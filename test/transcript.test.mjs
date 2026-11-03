// Replays a real captured round of stream-json (thinking → Bash tool → text), no network calls
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Transcript, TurnTranslator } = require('../out/transcript.js');
const { buildEnv, loadProfiles, CLAUDE } = require('../out/profiles.js');

const events = readFileSync(new URL('./fixtures/turn.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));

function replay(evts) {
  const ops = [];
  const t = new Transcript(op => ops.push(structuredClone(op)));
  const seen = {};
  const tr = new TurnTranslator(t, {
    init: e => { seen.init = e; },
    result: e => { seen.result = e; },
    rateLimit: r => { seen.rate = r; },
  });
  for (const e of evts) tr.handle(e);
  return { t, tr, ops, seen };
}

// Same rules as applyOp in media/chat.js
function applyOps(ops) {
  let items = [];
  for (const m of ops) {
    if (m.op === 'reset') items = m.items;
    else if (m.op === 'push') items.push(m.item);
    else if (m.op === 'set') items[m.index] = m.item;
    else if (m.op === 'append') items[m.index].text += m.text;
  }
  return items;
}

test('stream events → thinking, tool card, thinking, answer', () => {
  const { t, tr, seen } = replay(events);
  assert.deepEqual(t.items.map(i => i.kind), ['thinking', 'tool', 'thinking', 'assistant']);
  const tool = t.items[1];
  assert.equal(tool.name, 'Bash');
  assert.equal(tool.summary, 'echo hello-from-tool');
  assert.equal(tool.status, 'ok');
  assert.equal(tool.output, 'hello-from-tool');
  assert.equal(t.items[3].text, 'The command executed successfully and printed the expected output.');
  assert.equal(tr.gotResult, true);
  assert.equal(tr.sessionId, seen.init.sessionId);
  assert.equal(seen.init.apiKeySource, 'none');
  assert.equal(seen.rate.status, 'allowed');
});

test('without stream events the full-message fallback produces the same result', () => {
  const streamed = replay(events).t.items;
  const fallback = replay(events.filter(e => e.type !== 'stream_event')).t.items;
  assert.deepEqual(fallback, streamed);
});

test('webview replay of ops matches the extension-side list', () => {
  const { t, ops } = replay(events);
  assert.deepEqual(applyOps(ops), t.items);
});

test('stopping midway: unfinished tool cards are marked failed', () => {
  const cut = events.findIndex(e => e.type === 'user');
  const { t, tr } = replay(events.slice(0, cut));
  tr.finish('Interrupted');
  const tool = t.items.find(i => i.kind === 'tool');
  assert.equal(tool.status, 'error');
  assert.equal(tool.output, 'Interrupted');
});

test('events after detach are not recorded', () => {
  const t = new Transcript();
  const tr = new TurnTranslator(t);
  tr.detach();
  for (const e of events) tr.handle(e);
  assert.equal(t.items.length, 0);
});

test('Claude profile: strips all auth-stealing variables', () => {
  const env = buildEnv({
    PATH: '/usr/bin', HOME: '/h',
    ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y', ANTHROPIC_BASE_URL: 'z',
    CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDECODE: '1', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: '/c',
  }, CLAUDE);
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/c' });
});

test('third-party profile: base URL, key, model alias mapping', () => {
  const env = buildEnv({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'leak' },
    { id: 'm', label: 'M', baseUrl: 'https://example.test/anthropic', model: 'big', models: { haiku: 'small' } }, 'sk-1');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://example.test/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-1');
  assert.equal(env.ANTHROPIC_MODEL, 'big');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'big');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'big');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'small');

  const viaApiKey = buildEnv({}, { id: 'm', label: 'M', baseUrl: 'https://e.test', authEnv: 'ANTHROPIC_API_KEY' }, 'sk-2');
  assert.equal(viaApiKey.ANTHROPIC_API_KEY, 'sk-2');
  assert.equal(viaApiKey.ANTHROPIC_AUTH_TOKEN, undefined);
});

test('profiles: built-in Claude first, overridable, bad entries reported', () => {
  const { profiles, problems } = loadProfiles([
    { id: 'claude', model: 'opus' },
    { id: 'glm', label: 'GLM', baseUrl: 'https://e.test' },
    { id: 'glm', label: 'dup' },
    { label: 'no id' },
  ]);
  assert.deepEqual(profiles.map(p => p.id), ['claude', 'glm']);
  assert.equal(profiles[0].model, 'opus');
  assert.equal(profiles[0].label, 'claude');
  assert.equal(problems.length, 2);
  assert.deepEqual(loadProfiles(undefined).profiles, [CLAUDE]);
});

test('system task events become task cards even with parent_tool_use_id', () => {
  const t = new Transcript();
  const tr = new TurnTranslator(t);
  tr.handle({ type: 'system', subtype: 'task_started', parent_tool_use_id: 'call_x',
    task_id: 't1', tool_use_id: 'call_x', task_type: 'local_agent', description: 'Sleep then reply PONG' });
  assert.equal(t.items.length, 1);
  const card = t.items[0];
  assert.equal(card.kind, 'task');
  assert.equal(card.taskId, 't1');
  assert.equal(card.toolUseId, 'call_x');
  assert.equal(card.taskType, 'local_agent');
  assert.equal(card.description, 'Sleep then reply PONG');
  assert.equal(card.status, 'running');
  tr.handle({ type: 'system', subtype: 'task_progress', task_id: 't1', description: 'Running sleep' });
  assert.equal(t.items[0].status, 'running');
  assert.equal(t.items[0].description, 'Running sleep');
  tr.handle({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'PONG' });
  assert.equal(t.items[0].status, 'ok');
  assert.equal(t.items[0].summary, 'PONG');
});

test('task_notification with a non-completed status marks the card error', () => {
  const t = new Transcript();
  const tr = new TurnTranslator(t);
  tr.handle({ type: 'system', subtype: 'task_started', task_id: 't2', task_type: 'local_bash', description: 'bg job' });
  tr.handle({ type: 'system', subtype: 'task_notification', task_id: 't2', status: 'failed' });
  assert.equal(t.items[0].status, 'error');
});

test('background_tasks_changed sets pendingTasks', () => {
  const t = new Transcript();
  const tr = new TurnTranslator(t);
  tr.handle({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a' }, { task_id: 'b' }] });
  assert.equal(tr.pendingTasks, 2);
  tr.handle({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(tr.pendingTasks, 0);
});

test('two result events in one stream do not duplicate items; sessionId takes the last', () => {
  const t = new Transcript();
  const tr = new TurnTranslator(t);
  tr.handle({ type: 'system', subtype: 'init', session_id: 's1' });
  tr.handle({ type: 'result', subtype: 'success', session_id: 's1', num_turns: 2 });
  tr.handle({ type: 'system', subtype: 'init', session_id: 's2' });
  tr.handle({ type: 'result', subtype: 'success', session_id: 's2', num_turns: 1 });
  assert.ok(tr.gotResult);
  assert.equal(tr.sessionId, 's2');
  assert.equal(t.items.length, 0);
});

test('finish fails running task cards too', () => {
  const t = new Transcript();
  const tr = new TurnTranslator(t);
  tr.handle({ type: 'system', subtype: 'task_started', task_id: 't3', task_type: 'local_agent', description: 'still going' });
  tr.finish('Interrupted');
  assert.equal(t.items[0].status, 'error');
  assert.equal(t.items[0].summary, 'Interrupted');
});

test('setUserAttachments pushes a user item carrying attachment names', () => {
  const t = new Transcript();
  const tr = new TurnTranslator(t);
  tr.setUserAttachments('look at this', [{ name: 'shot.png', mediaType: 'image/png' }]);
  assert.deepEqual(t.items[0], {
    kind: 'user', text: 'look at this',
    attachments: [{ name: 'shot.png', mediaType: 'image/png' }],
  });
});

test('task_progress and task_notification capture duration and tokens', () => {
  const t = new Transcript();
  const tr = new TurnTranslator(t);
  tr.handle({ type: 'system', subtype: 'task_started', task_id: 't9', task_type: 'local_agent', description: 'review' });
  tr.handle({ type: 'system', subtype: 'task_progress', task_id: 't9', description: 'review',
    usage: { total_tokens: 147300, tool_uses: 2, duration_ms: 753000 }, last_tool_name: 'Read' });
  assert.equal(t.items[0].durationMs, 753000);
  assert.equal(t.items[0].tokens, 147300);
  tr.handle({ type: 'system', subtype: 'task_notification', task_id: 't9', status: 'completed', summary: 'done',
    usage: { total_tokens: 150000, duration_ms: 800000 } });
  assert.equal(t.items[0].tokens, 150000);
  assert.equal(t.items[0].durationMs, 800000);
  assert.equal(t.items[0].status, 'ok');
});
