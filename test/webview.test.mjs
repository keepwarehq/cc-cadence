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
<div id="history-popup" hidden></div>
<main id="log"></main>
<footer>
  <div id="mention-popup" hidden></div>
  <div id="agents-popup" hidden></div>
  <div id="mode-popup" hidden></div>
  <div id="profile-popup" hidden></div>
  <div id="status"></div>
  <div id="chips"></div>
  <div class="composer" id="composer">
    <textarea id="input"></textarea>
    <input type="file" id="file-input" multiple hidden>
    <div class="toolbar">
      <button id="attach" title="Upload from computer">＋</button><button id="mention">@</button>
      <button id="profile"></button><button id="mode"></button><span class="spacer"></span>
      <button id="agents" hidden>⚡</button><button id="stop" hidden>⏹</button><button id="send">Send</button>
    </div>
  </div>
</footer>`;

function boot(initialState, { images } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><body${images ? ` data-images="${images}"` : ''}>${BODY}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const posted = [];
  // webview state round-trips through JSON like VS Code's persisted state
  let saved = initialState;
  // Serialize like a real postMessage (also drops jsdom object prototypes)
  window.acquireVsCodeApi = () => ({
    postMessage: m => posted.push(JSON.parse(JSON.stringify(m))),
    getState: () => saved,
    setState: s => { saved = JSON.parse(JSON.stringify(s)); },
  });
  for (const f of ['../media/vendor/marked.min.js', '../media/vendor/purify.min.js', '../media/chat.js']) window.eval(read(f));
  const send = data => window.dispatchEvent(new window.MessageEvent('message', { data }));
  const $ = id => window.document.getElementById(id);
  const frame = () => new Promise(r => window.requestAnimationFrame(() => r()));
  return { window, posted, send, $, frame, state: () => saved };
}

const STATE = {
  type: 'state',
  profiles: [
    { id: 'claude', label: 'Claude (Max)', description: 'local claude -p · Max subscription' },
    { id: 'glm', label: 'GLM', description: 'http://localhost:11240' },
  ],
  activeId: 'claude',
  model: 'default',
  modelChoices: [
    { id: 'default', label: 'Default', detail: 'claude CLI default' },
    { id: 'opus', label: 'Opus', detail: '--model opus' },
    { id: 'sonnet', label: 'Sonnet', detail: '--model sonnet' },
    { id: 'haiku', label: 'Haiku', detail: '--model haiku' },
    { id: 'fable', label: 'Fable', detail: '--model fable' },
  ],
  effort: 'default',
  effortChoices: [
    { id: 'default', label: 'Default', detail: 'claude CLI default' },
    { id: 'low', label: 'Low', detail: '--effort low' },
    { id: 'medium', label: 'Medium', detail: '--effort medium' },
    { id: 'high', label: 'High', detail: '--effort high' },
    { id: 'xhigh', label: 'XHigh', detail: '--effort xhigh' },
    { id: 'max', label: 'Max', detail: '--effort max' },
  ],
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
  assert.equal($('mode').textContent, 'Bypass');
  assert.equal($('mode').className.includes('bypass'), true);
  send({ ...STATE, mode: 'plan' });
  assert.equal($('mode').textContent, 'Plan');
});

test('the profile pill opens its menu; the mode pill opens a mode menu and closes the profile one', () => {
  const { window, posted, send, $ } = boot();
  send(STATE);
  $('profile').click();
  assert.equal($('profile-popup').hidden, false, 'profile menu opens in the panel, no QuickPick round-trip');
  $('mode').click();
  assert.equal($('profile-popup').hidden, true, 'only one menu open at a time');
  const popup = $('mode-popup');
  assert.equal(popup.hidden, false, 'mode menu opens');
  assert.ok(popup.textContent.includes('Bypass permissions'));
  assert.ok(popup.textContent.includes('Plan'));
  assert.ok(popup.textContent.includes('present a plan'), 'descriptions shown');
  const active = popup.querySelector('.mode-row.active');
  assert.ok(active && active.textContent.includes('Bypass permissions'), 'active mode checked');
  [...popup.querySelectorAll('.mode-row')].find(r => r.textContent.includes('Plan')).click();
  assert.deepEqual(posted.at(-1), { type: 'setMode', mode: 'plan' });
  assert.equal(popup.hidden, true, 'menu closes after picking');
  $('mode').click();
  assert.equal(popup.hidden, false, 'pill toggles the menu');
  $('mode').click();
  assert.equal(popup.hidden, true);
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
  assert.deepEqual(nodes.map(n => n.className), ['item user bubble', 'item thinking', 'item tool ok f-bash', 'item thinking', 'item assistant']);
  assert.equal(nodes[2].querySelector('.name').textContent, 'Bash');
  assert.equal(nodes[2].querySelector('pre').textContent, 'hello-from-tool');
  assert.equal(nodes[4].textContent.trim(), 'The command executed successfully and printed the expected output.');
});

test('thinking with text renders an expandable details with the reasoning', async () => {
  const { send, $, frame } = boot();
  send({ ...STATE, items: [{ kind: 'thinking', text: 'first I consider X' }] });
  await frame();
  const node = $('log').children[0];
  const d = node.querySelector('details');
  assert.ok(d, 'expandable details rendered');
  assert.equal(d.querySelector('.text').textContent, 'first I consider X');
});

test('redacted thinking (empty text) renders a token label, not an empty expander', async () => {
  const { send, $, frame } = boot();
  send({ ...STATE, items: [{ kind: 'thinking', text: '', tokens: 1300 }] });
  await frame();
  const node = $('log').children[0];
  assert.equal(node.querySelector('details'), null, 'no misleading empty expander');
  const label = node.querySelector('.thinking-label');
  assert.ok(label, 'compact thinking label rendered');
  assert.match(label.textContent, /Thinking · ~1\.3k tokens/);
});

test('redacted thinking without a token estimate shows a plain Thinking… label', async () => {
  const { send, $, frame } = boot();
  send({ ...STATE, items: [{ kind: 'thinking', text: '' }] });
  await frame();
  const node = $('log').children[0];
  assert.equal(node.querySelector('details'), null);
  assert.equal(node.querySelector('.thinking-label').textContent, 'Thinking…');
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
  assert.equal(input.value, 'fix @src/auth.ts ');
  assert.equal(posted.filter(m => m.type === 'send').length, 0);
  const marks = [...window.document.querySelectorAll('.input-hl .mention-token')].map(m => m.textContent);
  assert.deepEqual(marks, ['@src/auth.ts']);
});

test('picking a mention keeps @, replaces only the typed query, and clicking a row works', async () => {
  const { window, posted, send, $, frame } = boot();
  send(STATE);
  const input = $('input');
  input.value = 'read @HAND and summarize';
  input.setSelectionRange(10, 10); // caret right after "@HAND"
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const q = posted.filter(m => m.type === 'mentionQuery').pop();
  assert.equal(q.text, 'HAND');
  send({ type: 'mentionResults', queryId: q.queryId, items: [{ label: 'HANDOVER.md', path: 'HANDOVER.md', kind: 'file' }] });
  await frame();
  $('mention-popup').querySelector('.mention-item').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(input.value, 'read @HANDOVER.md and summarize');
  assert.ok($('mention-popup').hidden);
  assert.deepEqual([...window.document.querySelectorAll('.input-hl .mention-token')].map(m => m.textContent), ['@HANDOVER.md']);
});

test('picking a folder inserts @dir/ without a space and re-queries inside it', async () => {
  const { window, posted, send, $, frame } = boot();
  send(STATE);
  const input = $('input');
  input.value = '@sr';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const q = posted.filter(m => m.type === 'mentionQuery').pop();
  send({ type: 'mentionResults', queryId: q.queryId, items: [{ label: 'src/', path: 'src/', kind: 'folder' }] });
  await frame();
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.equal(input.value, '@src/');
  const q2 = posted.filter(m => m.type === 'mentionQuery').pop();
  assert.equal(q2.text, 'src/');
  assert.notEqual(q2.queryId, q.queryId);
});

test('@ toolbar button inserts @ at the caret and opens the picker', async () => {
  const { window, posted, send, $ } = boot();
  send(STATE);
  const input = $('input');
  input.value = 'look at';
  input.setSelectionRange(7, 7);
  $('mention').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(input.value, 'look at @');
  const q = posted.filter(m => m.type === 'mentionQuery').pop();
  assert.equal(q.text, '');
  assert.ok(!$('mention-popup').hidden);
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
  assert.ok(node.querySelector('.tstate.running'), 'spinner');
  assert.equal(node.querySelector('.name').textContent, 'Sleep then reply PONG');
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

test('drop prefers files over uri-list (no double attach)', async () => {
  const { window, posted, send, $ } = boot();
  send(STATE);
  const input = $('input');
  const realFR = window.FileReader;
  window.FileReader = class {
    constructor() { setTimeout(() => { this.result = 'data:image/png;base64,aGk='; this.onloadend(); }, 0); }
    readAsDataURL() {}
  };
  const file = { name: 'shot.png', type: 'image/png' };
  const ev = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', {
    value: { files: [file], types: ['Files'], getData: () => 'file:///home/u/shot.png' },
  });
  input.dispatchEvent(ev);
  await new Promise(r => setTimeout(r, 5));
  window.FileReader = realFR;
  assert.equal(posted.filter(m => m.type === 'attachUri').length, 0, 'no attachUri when files are present');
  assert.equal(posted.filter(m => m.type === 'attachData' || m.type === 'attachFile').length, 1, 'exactly one attachment');
});

test('attachData carries a cid and state attachments carry no base64 thumb', async () => {
  const { window, posted, send, $, frame } = boot();
  send(STATE);
  const realFR = window.FileReader;
  window.FileReader = class {
    constructor() { setTimeout(() => { this.result = 'data:image/png;base64,aGk='; this.onloadend(); }, 0); }
    readAsDataURL() {}
  };
  const item = { kind: 'file', getAsFile: () => ({ name: 'shot.png', type: 'image/png' }) };
  const ev = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { items: [item] } });
  $('input').dispatchEvent(ev);
  await new Promise(r => setTimeout(r, 5));
  const msg = posted.find(m => m.type === 'attachData');
  assert.ok(msg?.cid, 'cid present');
  // the host echoes a state whose attachment entry carries NO thumb; the chip still shows the webview's own thumbnail
  send({ ...STATE, attachments: [{ id: msg.cid, name: 'shot.png', kind: 'image', mediaType: 'image/png' }] });
  await frame();
  const chip = $('chips').querySelector('.chip');
  assert.ok(chip, 'chip rendered');
  assert.ok(chip.querySelector('img'), 'thumbnail rendered from the webview cache despite thumbless state');
  assert.ok(chip.classList.contains('tile'), 'a pending image with a thumbnail renders as a preview tile');
  chip.querySelector('img').click();
  const lb = window.document.querySelector('.lightbox');
  assert.ok(lb && !lb.hidden, 'clicking the tile opens the lightbox');
  assert.equal(lb.querySelector('img').getAttribute('src'), 'data:image/png;base64,aGk=');
});

test('sent images render as thumbnails from the preview store; click opens the lightbox, Esc closes it', async () => {
  const { window, send, $, frame } = boot(undefined, { images: 'https://store.test/images' });
  send({ ...STATE, items: [{ kind: 'user', text: 'look', profile: 'Claude (Max)', attachments: [
    { name: 'shot.png', mediaType: 'image/png', file: 'abc.png' },
    { name: 'notes.txt', mediaType: 'text/plain' },
  ] }] });
  await frame();
  const node = $('log').children[0];
  assert.equal(node.className, 'item user bubble');
  const img = node.querySelector('.thumbs .thumb img');
  assert.equal(img?.getAttribute('src'), 'https://store.test/images/abc.png');
  assert.deepEqual([...node.querySelectorAll('.attachments .chip')].map(c => c.textContent), ['notes.txt'], 'non-images stay name chips');
  node.querySelector('.thumb').click();
  const lb = window.document.querySelector('.lightbox');
  assert.equal(lb.hidden, false);
  assert.equal(lb.querySelector('img').getAttribute('src'), 'https://store.test/images/abc.png');
  assert.equal(lb.querySelector('.caption').textContent, 'shot.png');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(lb.hidden, true, 'Esc closes');
  node.querySelector('.thumb').click();
  lb.click();
  assert.equal(lb.hidden, true, 'a click on the overlay closes');
  assert.equal(window.document.querySelectorAll('[style]').length, 0, 'no inline styles (CSP)');
});

test('a sent image whose preview file is gone degrades to a name chip', async () => {
  const { window, send, $, frame } = boot(undefined, { images: 'https://store.test/images' });
  send({ ...STATE, items: [{ kind: 'user', text: 'x', attachments: [{ name: 'old.png', mediaType: 'image/png', file: 'gone.png' }] }] });
  await frame();
  const node = $('log').children[0];
  node.querySelector('.thumb img').dispatchEvent(new window.Event('error'));
  assert.equal(node.querySelector('.thumb'), null);
  assert.equal(node.querySelector('.chip')?.textContent, 'old.png');
});

test('without a preview store, sent images show as name chips', async () => {
  const { send, $, frame } = boot();
  send({ ...STATE, items: [{ kind: 'user', text: 'x', attachments: [{ name: 'shot.png', mediaType: 'image/png', file: 'abc.png' }] }] });
  await frame();
  const node = $('log').children[0];
  assert.equal(node.querySelector('.thumb'), null);
  assert.equal(node.querySelector('.attachments .chip')?.textContent, 'shot.png');
});


test('agents pill counts running tasks and the popup lists each with meta', async () => {
  const { send, $, frame } = boot();
  send(STATE);
  send({ type: 'op', op: 'push', item: { kind: 'task', taskId: 'a', taskType: 'local_agent', description: 'review branch', status: 'running', durationMs: 753000, tokens: 147300 } });
  send({ type: 'op', op: 'push', item: { kind: 'task', taskId: 'b', taskType: 'local_bash', description: 'sleep', status: 'ok', durationMs: 72000, tokens: 60300 } });
  await frame();
  const pill = $('agents');
  assert.equal(pill.hidden, false, 'pill visible with tasks');
  assert.ok(pill.textContent.includes('1'), 'pill shows the running count');
  pill.click();
  const popup = $('agents-popup');
  assert.equal(popup.hidden, false, 'popup opens');
  assert.ok(popup.textContent.includes('review branch'));
  assert.ok(popup.textContent.includes('12m 33s'), 'duration formatted');
  assert.ok(popup.textContent.includes('147.3k'), 'tokens formatted');
  pill.click();
  assert.equal(popup.hidden, true, 'pill toggles the popup closed');
});

test('a task card shows its name, current step and meta; clicking it opens the detail panel', async () => {
  const { window, posted, send, $, frame } = boot();
  send(STATE);
  send({ type: 'op', op: 'push', item: { kind: 'task', taskId: 'k1', taskType: 'local_agent', description: 'Random math 3',
    activity: 'Print random math results for 10s', status: 'running', durationMs: 4000, tokens: 13000 } });
  await frame();
  const card = $('log').children[0];
  assert.equal(card.querySelector('.name').textContent, 'Random math 3', 'the name survives progress');
  assert.equal(card.querySelector('.detail').textContent, 'Print random math results for 10s');
  assert.equal(card.querySelector('.meta').textContent, '4s \u00b7 13k tokens');
  card.click();
  assert.deepEqual(posted.filter(m => m.type === 'taskDetail').pop(), { type: 'taskDetail', taskId: 'k1' });
  const panel = window.document.querySelector('.taskpanel-backdrop');
  assert.equal(panel.hidden, false);
  assert.equal(panel.querySelector('.taskpanel-head .title').textContent, 'Random math 3');
  send({ type: 'taskDetail', taskId: 'k1', items: [
    { kind: 'user', text: 'Answer random math questions' },
    { kind: 'tool', id: 'b1', name: 'Bash', summary: 'python3 rand.py', status: 'ok', output: '37 x 48 = 1776' },
    { kind: 'assistant', text: 'Done: **1776**' },
  ] });
  const body = panel.querySelector('.taskpanel-body');
  assert.deepEqual([...body.children].map(n => n.className), ['item user bubble', 'item tool ok f-bash', 'item assistant']);
  assert.equal(body.querySelector('.item.user .tag').textContent, 'Prompt', 'the first user turn is labelled as the prompt');
  // a refresh with one more item keeps the unchanged nodes (an expanded tool output stays open)
  const toolNode = body.children[1];
  send({ type: 'taskDetail', taskId: 'k1', items: [
    { kind: 'user', text: 'Answer random math questions' },
    { kind: 'tool', id: 'b1', name: 'Bash', summary: 'python3 rand.py', status: 'ok', output: '37 x 48 = 1776' },
    { kind: 'assistant', text: 'Done: **1776**' },
    { kind: 'assistant', text: 'And 7! = 5040' },
  ] });
  assert.equal(body.children.length, 4);
  assert.equal(body.children[1], toolNode, 'unchanged node kept');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(panel.hidden, true, 'Esc closes');
  assert.equal(window.document.querySelectorAll('[style]').length, 0, 'no inline styles (CSP)');
});

test('a shell task panel shows its output text; the agents popup row opens the panel too', async () => {
  const { window, posted, send, $, frame } = boot();
  send(STATE);
  send({ type: 'op', op: 'push', item: { kind: 'task', taskId: 'sh', taskType: 'local_bash', description: 'Background shell',
    status: 'ok', summary: 'exit code 0', durationMs: 3000, outputFile: '/tmp/x.output' } });
  await frame();
  $('agents').click();
  const row = $('agents-popup').querySelector('.agent-row');
  assert.ok(row.textContent.includes('Background shell') && row.textContent.includes('exit code 0'));
  row.click();
  assert.equal($('agents-popup').hidden, true, 'popup closes');
  assert.equal(posted.filter(m => m.type === 'taskDetail').pop().taskId, 'sh');
  send({ type: 'taskDetail', taskId: 'sh', items: [], text: 'line 1\nline 2\n' });
  const panel = window.document.querySelector('.taskpanel-backdrop');
  assert.equal(panel.querySelector('.taskpanel-output').textContent, 'line 1\nline 2\n');
  panel.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(panel.hidden, true, 'a backdrop click closes');
});

test('agents pill hides when there are no task items', async () => {
  const { send, $, frame } = boot();
  send(STATE);
  await frame();
  assert.equal($('agents').hidden, true);
});


test('+ opens the local file picker directly (no menu), not the host dialog', async () => {
  const { window, posted, send, $ } = boot();
  send(STATE);
  const fileInput = $('file-input');
  let picked = 0;
  fileInput.click = () => { picked++; };
  $('attach').click();
  assert.equal(picked, 1, 'one click opens the webview file picker (local machine under Remote)');
  assert.equal(posted.some(m => m.type === 'attach'), false, 'no host-side dialog');
  const realFR = window.FileReader;
  window.FileReader = class {
    readAsDataURL() { this.result = 'data:text/plain;base64,aGk='; this.onloadend(); }
  };
  Object.defineProperty(fileInput, 'files', { configurable: true, value: [{ name: 'notes.txt', type: 'text/plain' }] });
  fileInput.dispatchEvent(new window.Event('change'));
  await new Promise(r => setImmediate(r));
  window.FileReader = realFR;
  const msg = posted.find(m => m.type === 'attachFile');
  assert.ok(msg, 'picked file posted like a drop');
  assert.equal(msg.name, 'notes.txt');
  assert.equal(fileInput.value, '', 'reset so the same file can be picked again');
});

test('model pill opens a menu with profiles and models; picking posts setModel/setProfile', () => {
  const { posted, send, $ } = boot();
  send(STATE);
  $('profile').click();
  const popup = $('profile-popup');
  assert.equal(popup.hidden, false, 'profile menu opens');
  assert.ok(popup.textContent.includes('GLM'), 'other profiles listed');
  assert.ok(popup.textContent.includes('Max subscription'), 'profile description shown');
  const opusRow = [...popup.querySelectorAll('[data-model]')].find(r => r.dataset.model === 'opus');
  assert.ok(opusRow, 'model rows listed for the active profile');
  opusRow.click();
  assert.deepEqual(posted.at(-1), { type: 'setModel', model: 'opus' });
  assert.equal(popup.hidden, true);
  $('profile').click();
  [...popup.querySelectorAll('[data-profile]')].find(r => r.dataset.profile === 'glm').click();
  assert.deepEqual(posted.at(-1), { type: 'setProfile', id: 'glm' });
});

test('pill label carries the selected model', () => {
  const { send, $ } = boot();
  send({ ...STATE, model: 'opus' });
  assert.equal($('profile').textContent, 'Claude (Max) · opus');
  send({ ...STATE, model: 'default' });
  assert.equal($('profile').textContent, 'Claude (Max)');
});

test('every element chat.js looks up exists in the real webview HTML', () => {
  const ids = new Set([...read('../media/chat.js').matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]));
  const html = read('../src/chat.ts');
  assert.deepEqual([...ids].filter(id => !html.includes(`id="${id}"`)), []);
});

test('effort is a 5-dot slider: click a dot posts setEffort, clicking the active dot resets to default', () => {
  const { posted, send, $ } = boot();
  send(STATE);
  $('profile').click();
  const popup = $('profile-popup');
  assert.ok(popup.textContent.includes('Effort'), 'effort row shown');
  const dots = [...popup.querySelectorAll('.effort-dot')];
  assert.deepEqual(dots.map(d => d.dataset.effort), ['low', 'medium', 'high', 'xhigh', 'max'], 'one dot per level, no per-level rows');
  assert.equal(popup.querySelectorAll('.mode-row[data-effort]').length, 0);
  dots[2].click();
  assert.deepEqual(posted.at(-1), { type: 'setEffort', effort: 'high' });
  assert.equal(popup.hidden, false, 'slider keeps the menu open');
  assert.ok(popup.querySelector('[data-effort="high"]').className.includes('active'), 'picked dot marked at once');
  assert.ok(popup.textContent.includes('High'), 'current level named');
  popup.querySelector('[data-effort="high"]').click();
  assert.deepEqual(posted.at(-1), { type: 'setEffort', effort: 'default' });
  send({ ...STATE, model: 'opus', effort: 'high' });
  assert.equal($('profile').textContent, 'Claude (Max) · opus · high effort');
  send({ ...STATE, effort: 'max' });
  assert.equal($('profile').textContent, 'Claude (Max) · max effort');
  assert.ok(popup.querySelector('[data-effort="max"]').className.includes('active'), 'current effort marked');
});

const SESSIONS = {
  type: 'sessions',
  current: 's1',
  items: [
    { id: 's1', title: 'hello', ago: '13m' },
    { id: 's2', title: 'ccprofile extension feature enhancements', ago: '17m' },
  ],
};

test('sessions open the top-right history popup: search filters, click resumes', () => {
  const { window, posted, send, $ } = boot();
  send(STATE);
  send(SESSIONS);
  const popup = $('history-popup');
  assert.equal(popup.hidden, false, 'popup opens');
  const rows = () => [...popup.querySelectorAll('.history-row')];
  assert.equal(rows().length, 2);
  assert.ok(rows()[0].className.includes('active'), 'current session marked');
  assert.ok(rows()[0].textContent.includes('13m'), 'relative time shown');
  const search = popup.querySelector('input');
  search.value = 'CCP';
  search.dispatchEvent(new window.Event('input'));
  assert.deepEqual(rows().map(r => r.dataset.session), ['s2'], 'case-insensitive title filter');
  rows()[0].click();
  assert.deepEqual(posted.at(-1), { type: 'resumeSession', id: 's2' });
  assert.equal(popup.hidden, true, 'closes after picking');
});

test('history: delete needs a second click; Escape closes; empty list says so', () => {
  const { window, posted, send, $ } = boot();
  send(STATE);
  send(SESSIONS);
  const popup = $('history-popup');
  const del = popup.querySelector('[data-session="s2"] .history-delete');
  del.click();
  assert.equal(posted.some(m => m.type === 'deleteSession'), false, 'first click only arms');
  del.click();
  assert.deepEqual(posted.at(-1), { type: 'deleteSession', id: 's2' });
  assert.equal(popup.hidden, false, 'deleting keeps the list open');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(popup.hidden, true, 'Escape closes');
  send({ type: 'sessions', items: [] });
  assert.ok(popup.textContent.includes('No saved sessions'), 'empty state');
});

test('clicking outside closes the profile menu, the mode menu, and the agents popup', async () => {
  const { window, send, $ } = boot();
  send(STATE);
  const fire = () => $('log').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));

  $('profile').click();
  assert.equal($('profile-popup').hidden, false);
  fire();
  assert.equal($('profile-popup').hidden, true, 'profile menu closes on outside click');

  $('mode').click();
  assert.equal($('mode-popup').hidden, false);
  fire();
  assert.equal($('mode-popup').hidden, true, 'mode menu closes on outside click');

  send({ type: 'op', op: 'push', item: { kind: 'task', taskId: 'a', taskType: 'local_agent', description: 'x', status: 'running' } });
  $('agents').click();
  assert.equal($('agents-popup').hidden, false);
  fire();
  assert.equal($('agents-popup').hidden, true, 'agents popup closes on outside click');
});

test('clicking the pill itself does not immediately reclose via the outside handler', () => {
  const { send, $ } = boot();
  send(STATE);
  $('profile').click();
  assert.equal($('profile-popup').hidden, false, 'opening click is not swallowed by outside-close');
});

test('every composer popup hides when its [hidden] attribute is set (CSS does not defeat it)', () => {
  // #id selectors beat the UA [hidden] rule, so any popup given an explicit display must also state [hidden]{display:none}
  const css = read('../media/chat.css');
  const popups = [...css.matchAll(/#([a-z-]+-popup)\s*(?:,|\{)/g)].map(m => m[1]);
  const uniq = [...new Set(popups)];
  assert.ok(uniq.length >= 3, 'found the popups');
  for (const id of uniq) {
    const hasHiddenRule = new RegExp(`#${id}\\[hidden\\]`).test(css);
    assert.ok(hasHiddenRule, `#${id} must have a [hidden] display:none rule or it can never be closed`);
  }
});

test('webview state keeps the session id and mode for reload revival, without dropping the draft', () => {
  const { window, send, $, state } = boot({ draft: 'half-typed' });
  assert.equal($('input').value, 'half-typed');
  send({ ...STATE, mode: 'plan', sessionId: 'aaa-111' });
  assert.deepEqual(state(), { draft: 'half-typed', sessionId: 'aaa-111', mode: 'plan' });
  // the CLI reports a new session id mid-turn
  send({ type: 'session', sessionId: 'bbb-222' });
  assert.equal(state().sessionId, 'bbb-222');
  assert.equal(state().draft, 'half-typed');
  // New chat clears it
  send({ type: 'session' });
  assert.equal(state().sessionId, undefined);
  $('input').value = 'next';
  $('input').dispatchEvent(new window.Event('input'));
  assert.equal(state().draft, 'next');
  assert.equal(state().mode, 'plan');
});

test('a missing-key notice carries a Set API key button that posts the profile id', () => {
  const { window, posted, send, $ } = boot();
  send({ ...STATE, items: [{ kind: 'notice', level: 'error', text: 'no key', action: 'setKey', profileId: 'glm-5-3' }] });
  const btn = [...$('log').querySelectorAll('button')].find(b => b.textContent === 'Set API key');
  assert.ok(btn);
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(posted.at(-1), { type: 'setKey', profileId: 'glm-5-3' });
});
