// Runs the real media/chat.js in jsdom (plus the bundled marked / DOMPurify), checking rendering and interactions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { Transcript, TurnTranslator } = require('../out/transcript.js');

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const BODY = `
<main id="log"></main>
<footer>
  <div id="mention-popup" hidden></div>
  <div id="status"></div>
  <div id="chips"></div>
  <div class="composer" id="composer">
    <textarea id="input"></textarea>
    <div class="toolbar">
      <button id="attach">＋</button><button id="mention">@</button><button id="history">🕘</button>
      <button id="profile"></button><button id="mode"></button><span class="spacer"></span>
      <button id="stop" hidden>⏹</button><button id="send">Send</button>
    </div>
  </div>
</footer>`;

function boot() {
  const dom = new JSDOM(`<!DOCTYPE html><body>${BODY}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const posted = [];
  // Serialize like a real postMessage (also drops jsdom object prototypes)
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

test('posts ready on boot; state fills the composer pills', () => {
  const { posted, send, $ } = boot();
  assert.deepEqual(posted[0], { type: 'ready' });
  send(STATE);
  assert.equal($('profile').textContent, 'Claude (Max)');
  assert.equal($('mode').textContent, 'bypass');
  assert.equal($('mode').className.includes('bypass'), true);
  send({ ...STATE, mode: 'plan' });
  assert.equal($('mode').textContent, 'plan');
});

test('picking a profile posts pickProfile; the mode pill cycles the mode', () => {
  const { window, posted, send, $ } = boot();
  send(STATE);
  $('profile').click();
  assert.deepEqual(posted.at(-1), { type: 'pickProfile' });
  $('mode').click();
  assert.deepEqual(posted.at(-1), { type: 'cycleMode' });
});

test('replays a real event stream: four items render in order', async () => {
  const { send, $, frame } = boot();
  send(STATE);
  const events = read('./fixtures/turn.jsonl').trim().split('\n').map(l => JSON.parse(l));
  const t = new Transcript(op => send({ type: 'op', ...structuredClone(op) }));
  t.push({ kind: 'user', text: 'run it', profile: 'Claude (Max)' });
  const tr = new TurnTranslator(t);
  for (const e of events) tr.handle(e);
  await frame();
  const nodes = [...$('log').children];
  assert.deepEqual(nodes.map(n => n.className), ['item user bubble', 'item thinking', 'item tool ok', 'item thinking', 'item assistant']);
  assert.equal(nodes[2].querySelector('.name').textContent, 'Bash');
  assert.equal(nodes[2].querySelector('pre').textContent, 'hello-from-tool');
  assert.equal(nodes[4].textContent.trim(), 'The command executed successfully and printed the expected output.');
});

test('scripts and event attributes in model output are stripped', async () => {
  const { send, $ } = boot();
  send({ ...STATE, items: [{ kind: 'assistant', text: 'hi <img src="x" onerror="alert(1)"><script>alert(2)</script> **b**' }] });
  const node = $('log').children[0];
  assert.equal(node.querySelector('script'), null);
  assert.equal(node.querySelector('img').getAttribute('onerror'), null);
  assert.equal(node.querySelector('strong').textContent, 'b');
});


test('Enter sends; IME-composing Enter does not; the busy button becomes Stop', () => {
  const { window, posted, send, $ } = boot();
  send(STATE);
  const input = $('input');
  input.value = 'hello';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
  assert.equal(posted.filter(m => m.type === 'send').length, 0);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
  assert.deepEqual(posted.at(-1), { type: 'send', text: 'hello' });
  assert.equal(input.value, '');

  send({ type: 'busy', busy: true });
  assert.equal($('send').textContent, 'Send'); // send stays available: interrupt-and-replace
  assert.equal($('stop').hidden, false);
  $('stop').click();
  assert.deepEqual(posted.at(-1), { type: 'stop' });
});

test('paste with an image item posts attachData', async () => {
  const { window, posted, send, $ } = boot();
  send(STATE);
  const input = $('input');
  const item = {
    kind: 'file',
    getAsFile: () => ({ name: 'shot.png', type: 'image/png' }),
  };
  const ev = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { items: [item] } });
  // FileReader in jsdom cannot read a fake blob; stub it (assigned before dispatch)
  const realFR = window.FileReader;
  window.FileReader = class {
    constructor() { setTimeout(() => { this.result = 'data:image/png;base64,aGk='; this.onloadend(); }, 0); }
    readAsDataURL() {}
  };
  input.dispatchEvent(ev);
  await new Promise(r => setTimeout(r, 5));
  window.FileReader = realFR;
  const msg = posted.find(m => m.type === 'attachData');
  assert.ok(msg, 'attachData posted');
  assert.equal(msg.name, 'shot.png');
  assert.equal(msg.mediaType, 'image/png');
  assert.equal(msg.base64, 'aGk=');
});

test('drop with a File posts attachFile', async () => {
  const { window, posted, send, $ } = boot();
  send(STATE);
  const input = $('input');
  const realFR = window.FileReader;
  window.FileReader = class {
    readAsDataURL() { this.result = 'data:text/plain;base64,aGk='; this.onloadend(); }
  };
  const file = { name: 'notes.txt', type: 'text/plain' };
  const ev = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files: [file], types: ['Files'], getData: () => '' } });
  input.dispatchEvent(ev);
  await new Promise(r => setImmediate(r));
  window.FileReader = realFR;
  const msg = posted.find(m => m.type === 'attachFile');
  assert.ok(msg, 'attachFile posted');
  assert.equal(msg.name, 'notes.txt');
  assert.equal(msg.base64, 'aGk=');
});

test('typing @ triggers mentionQuery; mentionResults renders the popup; Enter inserts and suppresses send', async () => {
  const { window, posted, send, $, frame } = boot();
  send(STATE);
  const input = $('input');
  input.value = 'fix @';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const q = posted.find(m => m.type === 'mentionQuery');
  assert.ok(q, 'mentionQuery posted');
  send({ type: 'mentionResults', queryId: q.queryId, items: [{ label: 'src/auth.ts', path: 'src/auth.ts', kind: 'file' }] });
  await frame();
  const popup = $('mention-popup');
  assert.ok(popup, 'popup rendered');
  assert.ok(popup.textContent.includes('src/auth.ts'));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(input.value, 'fix src/auth.ts');
  assert.equal(posted.filter(m => m.type === 'send').length, 0);
});

test('task card renders spinner then ok with summary', async () => {
  const { send, $, frame } = boot();
  send(STATE);
  const t = new Transcript(op => send({ type: 'op', ...structuredClone(op) }));
  await frame();
  t.push({ kind: 'task', taskId: 't1', taskType: 'local_agent', description: 'Sleep then reply PONG', status: 'running' });
  await frame();
  const node = $('log').children[0];
  assert.equal(node.className, 'item task running');
  assert.ok(node.querySelector('.state'));
  t.set(0, { kind: 'task', taskId: 't1', taskType: 'local_agent', description: 'Sleep then reply PONG', status: 'ok', summary: 'PONG' });
  await frame();
  assert.equal($('log').children[0].className, 'item task ok');
  assert.ok($('log').children[0].textContent.includes('PONG'));
});

test('copy button on code blocks works without inline styles anywhere', async () => {
  const { window, send, $, frame } = boot();
  send({ ...STATE, items: [
    { kind: 'assistant', text: '```js\nconsole.log(1)\n```' },
    { kind: 'user', text: 'hi', profile: 'Claude (Max)', attachments: [{ name: 'shot.png', mediaType: 'image/png' }] },
    { kind: 'task', taskId: 't', taskType: 'local_bash', description: 'job', status: 'running' },
    { kind: 'notice', level: 'info', text: 'bg tasks pending', action: 'checkTasks' },
    { kind: 'thinking', text: 'hmm' },
  ] });
  await frame();
  assert.equal(window.document.querySelectorAll('[style]').length, 0, 'no element carries an inline style attribute');
  const pre = $('log').querySelector('pre');
  assert.ok(pre, 'code block rendered');
  const btn = pre.parentElement.querySelector('.copy');
  assert.ok(btn, 'copy button rendered');
  btn.click();
});
