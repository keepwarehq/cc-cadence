// 用真实抓到的一轮 stream-json（thinking → Bash 工具 → 文本）回放，不调用网络
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

// 和 media/chat.js 里 applyOp 同样的规则
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

test('流式事件 → 思考、工具卡片、思考、回答', () => {
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

test('没有 stream_event 时用完整消息兜底，结果一致', () => {
  const streamed = replay(events).t.items;
  const fallback = replay(events.filter(e => e.type !== 'stream_event')).t.items;
  assert.deepEqual(fallback, streamed);
});

test('webview 按 op 还原出的列表和扩展端一致', () => {
  const { t, ops } = replay(events);
  assert.deepEqual(applyOps(ops), t.items);
});

test('中途停止：未完成的工具卡片标成失败', () => {
  const cut = events.findIndex(e => e.type === 'user');
  const { t, tr } = replay(events.slice(0, cut));
  tr.finish('已中断');
  const tool = t.items.find(i => i.kind === 'tool');
  assert.equal(tool.status, 'error');
  assert.equal(tool.output, '已中断');
});

test('detach 之后的事件不再写入', () => {
  const t = new Transcript();
  const tr = new TurnTranslator(t);
  tr.detach();
  for (const e of events) tr.handle(e);
  assert.equal(t.items.length, 0);
});

test('Claude 档：去掉所有会抢认证的变量', () => {
  const env = buildEnv({
    PATH: '/usr/bin', HOME: '/h',
    ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y', ANTHROPIC_BASE_URL: 'z',
    CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDECODE: '1', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: '/c',
  }, CLAUDE);
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/c' });
});

test('第三方档：Base URL、Key、模型别名映射', () => {
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

test('档位：内置 Claude 在第一位，可被覆盖，坏条目报问题', () => {
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
