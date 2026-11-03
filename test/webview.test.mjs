// 在 jsdom 里跑真实的 media/chat.js（加上打包进去的 marked / DOMPurify），检查渲染和交互
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { Transcript, TurnTranslator } = require('../out/transcript.js');

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const BODY = `
<header id="bar"><select id="profile"></select><select id="mode"></select><span id="badge" hidden>bypass</span></header>
<main id="log"></main>
<footer><div id="status"></div><textarea id="input"></textarea><button id="send">发送</button></footer>`;

function boot() {
  const dom = new JSDOM(`<!DOCTYPE html><body>${BODY}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const posted = [];
  // 和真实 postMessage 一样先序列化（也去掉 jsdom 那边的对象原型）
  window.acquireVsCodeApi = () => ({ postMessage: m => posted.push(JSON.parse(JSON.stringify(m))), getState: () => undefined, setState: () => {} });
  for (const f of ['../media/vendor/marked.min.js', '../media/vendor/purify.min.js', '../media/chat.js']) window.eval(read(f));
  const send = data => window.dispatchEvent(new window.MessageEvent('message', { data }));
  const $ = id => window.document.getElementById(id);
  const frame = () => new Promise(r => window.requestAnimationFrame(() => r()));
  return { window, posted, send, $, frame };
}

const STATE = {
  type: 'state',
  profiles: [{ id: 'claude', label: 'Claude (Max)' }, { id: 'glm', label: 'GLM' }],
  activeId: 'claude',
  mode: 'bypassPermissions',
  modes: ['bypassPermissions', 'acceptEdits', 'plan'],
  busy: false,
  items: [],
  status: '',
};

test('启动后发 ready；state 填好下拉框和 bypass 标记', () => {
  const { posted, send, $ } = boot();
  assert.deepEqual(posted[0], { type: 'ready' });
  send(STATE);
  assert.deepEqual([...$('profile').options].map(o => o.value), ['claude', 'glm', '__add__', '__manage__']);
  assert.equal($('profile').value, 'claude');
  assert.equal($('badge').hidden, false);
  send({ ...STATE, mode: 'plan' });
  assert.equal($('badge').hidden, true);
});

test('回放真实事件流：四个条目按顺序渲染出来', async () => {
  const { send, $, frame } = boot();
  send(STATE);
  const events = read('./fixtures/turn.jsonl').trim().split('\n').map(l => JSON.parse(l));
  const t = new Transcript(op => send({ type: 'op', ...structuredClone(op) }));
  t.push({ kind: 'user', text: 'run it', profile: 'Claude (Max)' });
  const tr = new TurnTranslator(t);
  for (const e of events) tr.handle(e);
  await frame();
  const nodes = [...$('log').children];
  assert.deepEqual(nodes.map(n => n.className), ['item user', 'item thinking', 'item tool ok', 'item thinking', 'item assistant']);
  assert.equal(nodes[2].querySelector('.name').textContent, 'Bash');
  assert.equal(nodes[2].querySelector('pre').textContent, 'hello-from-tool');
  assert.equal(nodes[4].textContent.trim(), 'The command executed successfully and printed the expected output.');
});

test('模型输出里的脚本和事件属性被清掉', async () => {
  const { send, $ } = boot();
  send({ ...STATE, items: [{ kind: 'assistant', text: 'hi <img src="x" onerror="alert(1)"><script>alert(2)</script> **b**' }] });
  const node = $('log').children[0];
  assert.equal(node.querySelector('script'), null);
  assert.equal(node.querySelector('img').getAttribute('onerror'), null);
  assert.equal(node.querySelector('strong').textContent, 'b');
});

test('选「添加模型」发命令，下拉框回到当前档位', () => {
  const { window, posted, send, $ } = boot();
  send(STATE);
  $('profile').value = '__add__';
  $('profile').dispatchEvent(new window.Event('change'));
  assert.deepEqual(posted.at(-1), { type: 'addProfile' });
  assert.equal($('profile').value, 'claude');
  $('profile').value = 'glm';
  $('profile').dispatchEvent(new window.Event('change'));
  assert.deepEqual(posted.at(-1), { type: 'setProfile', id: 'glm' });
});

test('Enter 发送；输入法组字时的 Enter 不发送；忙时按钮变停止', () => {
  const { window, posted, send, $ } = boot();
  send(STATE);
  const input = $('input');
  input.value = '你好';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
  assert.equal(posted.filter(m => m.type === 'send').length, 0);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
  assert.deepEqual(posted.at(-1), { type: 'send', text: '你好' });
  assert.equal(input.value, '');

  send({ type: 'busy', busy: true });
  assert.equal($('send').textContent, '停止');
  $('send').click();
  assert.deepEqual(posted.at(-1), { type: 'stop' });
});
