// @ts-check
/* global acquireVsCodeApi, marked, DOMPurify */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
  const log = $('log');
  const input = $('input');
  const sendBtn = $('send');
  const profileSel = $('profile');
  const modeSel = $('mode');
  const badge = $('badge');
  const statusEl = $('status');

  const ADD = '__add__';
  const MANAGE = '__manage__';

  /** @type {any[]} */
  let items = [];
  let busy = false;
  let activeId = '';
  const dirty = new Set();
  let frame = 0;

  marked.use({ gfm: true, breaks: true });
  const md = (/** @type {string} */ text) => DOMPurify.sanitize(marked.parse(text || ''));

  // ---- Rendering: the i-th child of #log always corresponds to items[i] ----

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function render(item) {
    const node = el('div', 'item ' + item.kind);
    switch (item.kind) {
      case 'user':
        if (item.profile) node.appendChild(el('div', 'tag', item.profile));
        node.appendChild(el('div', 'body', item.text));
        break;
      case 'assistant':
        node.innerHTML = md(item.text);
        break;
      case 'thinking': {
        const d = el('details');
        d.append(el('summary', '', 'Thinking'), el('div', 'text', item.text));
        node.appendChild(d);
        break;
      }
      case 'tool': {
        node.classList.add(item.status);
        const d = el('details');
        const s = el('summary');
        s.append(
          el('span', 'state', item.status === 'running' ? '…' : item.status === 'ok' ? '✓' : '✗'),
          el('span', 'name', item.name),
          el('span', 'summary', item.summary),
        );
        d.appendChild(s);
        if (item.output) d.appendChild(el('pre', '', item.output));
        node.appendChild(d);
        break;
      }
      case 'notice':
        node.classList.add(item.level);
        node.textContent = item.text;
        break;
    }
    return node;
  }

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const scrollEnd = () => { log.scrollTop = log.scrollHeight; };

  function replace(i) {
    const old = log.children[i];
    const node = render(items[i]);
    const oldDetails = old && old.querySelector('details');
    const newDetails = node.querySelector('details');
    if (oldDetails && newDetails) newDetails.open = oldDetails.open; // keep expanded state across streamed updates
    if (old) log.replaceChild(node, old);
    else log.appendChild(node);
  }

  function flush() {
    frame = 0;
    const stick = nearBottom();
    for (const i of dirty) replace(i);
    dirty.clear();
    if (stick) scrollEnd();
  }

  function mark(i) {
    dirty.add(i);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  function resetItems(next) {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    dirty.clear();
    items = next;
    log.replaceChildren(...items.map(render));
    scrollEnd();
  }

  function applyOp(m) {
    switch (m.op) {
      case 'reset':
        resetItems(m.items);
        break;
      case 'push': {
        const stick = m.item.kind === 'user' || nearBottom();
        items.push(m.item);
        log.appendChild(render(m.item));
        if (stick) scrollEnd();
        break;
      }
      case 'set':
        items[m.index] = m.item;
        mark(m.index);
        break;
      case 'append':
        if (items[m.index]) {
          items[m.index].text += m.text;
          mark(m.index);
        }
        break;
    }
  }

  // ---- Top bar / bottom bar ----

  function option(value, label) {
    const o = el('option', '', label);
    o.value = value;
    return o;
  }

  function applyState(m) {
    activeId = m.activeId;
    profileSel.replaceChildren(
      ...m.profiles.map(p => option(p.id, p.label)),
      option(ADD, '+ Add model…'),
      option(MANAGE, 'Manage models…'),
    );
    profileSel.value = activeId;
    modeSel.replaceChildren(...m.modes.map(x => option(x, x)));
    modeSel.value = m.mode;
    badge.hidden = m.mode !== 'bypassPermissions';
    statusEl.textContent = m.status || '';
    setBusy(m.busy);
    resetItems(m.items);
  }

  function setBusy(b) {
    busy = b;
    sendBtn.textContent = busy ? 'Stop' : 'Send';
    sendBtn.classList.toggle('stop', busy);
  }

  function send() {
    if (busy) return;
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
    vscode.setState({ draft: '' });
  }

  sendBtn.addEventListener('click', () => (busy ? vscode.postMessage({ type: 'stop' }) : send()));

  input.addEventListener('keydown', e => {
    // Enter during IME composition picks a candidate; it must not send
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener('input', () => vscode.setState({ draft: input.value }));

  profileSel.addEventListener('change', () => {
    const v = profileSel.value;
    profileSel.value = activeId; // the real switch is confirmed by the state the extension sends back
    if (v === ADD) vscode.postMessage({ type: 'addProfile' });
    else if (v === MANAGE) vscode.postMessage({ type: 'manageProfiles' });
    else vscode.postMessage({ type: 'setProfile', id: v });
  });

  modeSel.addEventListener('change', () => vscode.postMessage({ type: 'setMode', mode: modeSel.value }));

  $('history').addEventListener('click', () => vscode.postMessage({ type: 'history' }));

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'state') applyState(m);
    else if (m.type === 'op') applyOp(m);
    else if (m.type === 'busy') setBusy(m.busy);
    else if (m.type === 'status') statusEl.textContent = m.text || '';
  });

  input.value = (vscode.getState() || {}).draft || '';
  vscode.postMessage({ type: 'ready' });
})();
