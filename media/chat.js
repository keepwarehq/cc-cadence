// @ts-check
/* global acquireVsCodeApi, marked, DOMPurify */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
  const log = $('log');
  const input = $('input');
  const sendBtn = $('send');
  const stopBtn = $('stop');
  const chips = $('chips');
  const popup = $('mention-popup');
  const profilePill = $('profile');
  const modePill = $('mode');
  const statusEl = $('status');

  /** @type {any[]} */
  let items = [];
  /** @type {{id: string, name: string, kind: string, mediaType?: string, thumb?: string}[]} */
  let attachments = [];
  let busy = false;
  let activeId = '';
  /** @type {Record<string, string>} */
  const profileLabels = {};
  /** @type {string[]} */
  let modes = [];
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

  function toolFamily(/** @type {string} */ name) {
    const n = (name || '').toLowerCase();
    if (/^(bash|powerShell)$/.test(n) || n.startsWith('shell')) return 'bash';
    if (/^(read|write|edit|notebookedit|applypatch)/.test(n)) return 'file';
    if (/^(glob|grep|ls)/.test(n)) return 'search';
    if (/^(web|fetch|search)/.test(n)) return 'web';
    if (/^(agent|task|todo|skill|exit)/.test(n)) return 'agent';
    return 'other';
  }

  function addCopyButtons(node) {
    for (const pre of node.querySelectorAll('pre')) {
      const wrap = el('div', 'codeblock');
      pre.replaceWith(wrap);
      const btn = el('button', 'copy', 'Copy');
      btn.addEventListener('click', () => {
        const text = pre.textContent || '';
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
        else fallbackCopy(text);
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      });
      wrap.append(btn, pre);
    }
  }

  function fallbackCopy(text) {
    const ta = el('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* best effort */ }
    ta.remove();
  }

  function render(item) {
    const node = el('div', 'item ' + item.kind);
    switch (item.kind) {
      case 'user':
        node.classList.add('bubble');
        if (item.profile) node.appendChild(el('div', 'tag', item.profile));
        if (item.attachments?.length) {
          const row = el('div', 'attachments');
          for (const a of item.attachments) row.appendChild(el('span', 'chip', a.name));
          node.appendChild(row);
        }
        node.appendChild(el('div', 'body', item.text));
        break;
      case 'assistant':
        node.innerHTML = md(item.text);
        addCopyButtons(node);
        break;
      case 'thinking': {
        const d = el('details');
        d.append(el('summary', '', 'Thinking'), el('div', 'text', item.text));
        node.appendChild(d);
        break;
      }
      case 'tool': {
        node.classList.add(item.status, 'f-' + toolFamily(item.name));
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
      case 'task': {
        node.classList.add(item.status);
        const row = el('div', 'taskrow');
        row.append(
          el('span', 'state', item.status === 'running' ? '◔' : item.status === 'ok' ? '✓' : '✗'),
          el('span', 'name', item.description),
        );
        if (item.summary) row.appendChild(el('span', 'summary', item.summary));
        node.appendChild(row);
        break;
      }
      case 'notice':
        node.classList.add(item.level);
        node.appendChild(el('span', '', item.text));
        if (item.action === 'checkTasks') {
          const btn = el('button', 'check', 'Check now');
          btn.addEventListener('click', () => vscode.postMessage({ type: 'checkTasks' }));
          node.appendChild(btn);
        }
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
    markStreaming();
    if (stick) scrollEnd();
  }

  /** Blinking caret on the streaming assistant/thinking item (CSS class, no inline styles) */
  function markStreaming() {
    for (const n of log.querySelectorAll('.streaming')) n.classList.remove('streaming');
    if (!busy) return;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]?.kind === 'assistant' || items[i]?.kind === 'thinking') {
        log.children[i]?.classList.add('streaming');
        break;
      }
    }
  }

  function mark(i) {
    dirty.add(i);
    if (!frame) frame = requestAnimationFrame(flush);
  }

  function resetItems(next) {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    dirty.clear();
    items = next.slice(); // defensive copy: later ops mutate this array, never the host's
    log.replaceChildren(...items.map(render));
    markStreaming();
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

  // ---- Composer toolbar / attachment chips / mention popup ----

  function renderChips() {
    chips.replaceChildren(...attachments.map(a => {
      const c = el('span', 'chip' + (a.kind === 'image' ? ' img' : ''));
      const thumb = thumbs.get(a.id);
      if (thumb) {
        const img = document.createElement('img');
        img.src = thumb;
        img.alt = a.name;
        c.appendChild(img);
      }
      c.appendChild(el('span', 'chipname', a.name));
      const x = el('button', 'chipx', '×');
      x.title = 'Remove';
      x.addEventListener('click', () => vscode.postMessage({ type: 'removeAttachment', id: a.id }));
      c.appendChild(x);
      return c;
    }));
  }

  function applyState(m) {
    activeId = m.activeId;
    for (const p of m.profiles) profileLabels[p.id] = p.label;
    modes = m.modes;
    profilePill.textContent = profileLabels[activeId] || activeId;
    modePill.textContent = m.mode.replace(/Permissions$/, '');
    modePill.classList.toggle('bypass', m.mode === 'bypassPermissions');
    attachments = m.attachments || [];
    renderChips();
    statusEl.textContent = m.status || '';
    setBusy(m.busy);
    resetItems(m.items);
  }

  function setBusy(b) {
    busy = b;
    stopBtn.hidden = !b;
    markStreaming();
  }

  function send() {
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
    const st = vscode.getState() || {};
    vscode.setState({ ...st, draft: '' });
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  $('attach').addEventListener('click', () => vscode.postMessage({ type: 'attach' }));
  $('mention').addEventListener('click', () => { insertMention('@'); input.focus(); });
  $('history').addEventListener('click', () => vscode.postMessage({ type: 'history' }));
  profilePill.addEventListener('click', () => vscode.postMessage({ type: 'pickProfile' }));
  modePill.addEventListener('click', () => vscode.postMessage({ type: 'cycleMode' }));

  // ---- Attachment input: paste and drop ----

  let attachSeq = 0;
  /** Thumbnails the webview itself produced (paste/drop): keyed by the client id sent with the attachment */
  const thumbs = new Map();

  function fileToAttachment(/** @type {File} */ file, /** @type {(m: any) => void} */ post) {
    const fr = new FileReader();
    const cid = 'c' + Date.now().toString(36) + (attachSeq++).toString(36);
    fr.onloadend = () => {
      const s = String(fr.result || '');
      const at = s.indexOf('base64,');
      if (at < 0) return;
      const base64 = s.slice(at + 'base64,'.length);
      const image = /^image\//.test(file.type || '');
      if (image) thumbs.set(cid, s);
      post({ type: image ? 'attachData' : 'attachFile', cid, name: file.name, mediaType: file.type || undefined, base64 });
    };
    fr.readAsDataURL(file);
  }

  input.addEventListener('paste', e => {
    const files = [];
    for (const it of e.clipboardData?.items ?? []) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) fileToAttachment(f, m => vscode.postMessage(m));
  });

  const dropZone = $('composer');
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag');
    // OS drags carry both flavors for the same file; prefer files, use uri-list only as the fallback
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) {
      for (const f of files) fileToAttachment(f, m => vscode.postMessage(m));
    } else {
      const uriList = typeof e.dataTransfer?.getData === 'function' ? (e.dataTransfer.getData('text/uri-list') || '') : '';
      for (const u of uriList.split('\n').map(s => s.trim()).filter(Boolean)) vscode.postMessage({ type: 'attachUri', uri: u });
    }
  });

  // ---- @ mentions ----

  let mentionQueryId = 0;
  let mentionTimer = 0;
  let mentionAnchor = -1; // index of '@' in input.value; -1 = popup closed
  /** @type {{label: string, path: string, kind: string}[]} */
  let mentionItems = [];
  let mentionActive = 0;

  const mentionState = () => {
    const m = /(^|\s)@([^\s@]*)$/.exec(input.value.slice(0, input.selectionEnd ?? input.value.length));
    return m ? { at: m.index + m[1].length, q: m[2] } : null;
  };

  function closeMention() {
    mentionAnchor = -1;
    mentionItems = [];
    popup.hidden = true;
  }

  function openMention(at, q) {
    mentionAnchor = at;
    mentionActive = 0;
    popup.replaceChildren(el('div', 'mention-empty', 'Searching…'));
    popup.hidden = false;
    const queryId = String(++mentionQueryId);
    vscode.postMessage({ type: 'mentionQuery', queryId, text: q });
  }

  function renderMention() {
    popup.replaceChildren(...(mentionItems.length
      ? mentionItems.map((it, i) => {
          const row = el('div', 'mention-item' + (i === mentionActive ? ' active' : ''));
          row.append(el('span', 'mention-icon', it.kind === 'folder' ? '▸' : '·'), el('span', '', it.label));
          return row;
        })
      : [el('div', 'mention-empty', 'No matches')]));
    popup.hidden = false;
  }

  function insertMention(/** @type {string} */ path) {
    if (mentionAnchor >= 0) {
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, mentionAnchor) + path + input.value.slice(end);
    } else {
      input.value = input.value + (input.value.endsWith(' ') || !input.value ? '' : ' ') + path;
    }
    input.focus();
    closeMention();
    const st = vscode.getState() || {};
    vscode.setState({ ...st, draft: input.value });
  }

  input.addEventListener('input', () => {
    const st = vscode.getState() || {};
    vscode.setState({ ...st, draft: input.value });
    const m = mentionState();
    if (m) {
      clearTimeout(mentionTimer);
      mentionTimer = setTimeout(() => openMention(m.at, m.q), 150);
    } else {
      clearTimeout(mentionTimer);
      closeMention();
    }
  });

  // ---- Keyboard: popup first, then IME-aware send ----

  input.addEventListener('keydown', e => {
    if (mentionAnchor >= 0 && mentionItems.length) {
      if (e.key === 'ArrowDown') { mentionActive = (mentionActive + 1) % mentionItems.length; renderMention(); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { mentionActive = (mentionActive - 1 + mentionItems.length) % mentionItems.length; renderMention(); e.preventDefault(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { insertMention(mentionItems[mentionActive].path); e.preventDefault(); return; }
      if (e.key === 'Escape') { closeMention(); e.preventDefault(); return; }
    }
    // Enter during IME composition picks a candidate; it must not send
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      closeMention();
      send();
    }
  });

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'state') applyState(m);
    else if (m.type === 'op') applyOp(m);
    else if (m.type === 'busy') setBusy(m.busy);
    else if (m.type === 'status') statusEl.textContent = m.text || '';
    else if (m.type === 'thumbs') {
      for (const th of m.thumbs || []) thumbs.set(th.id, th.thumb);
      renderChips();
    }
    else if (m.type === 'mentionResults') {
      if (String(m.queryId) === String(mentionQueryId)) {
        mentionItems = m.items || [];
        mentionActive = 0;
        renderMention();
      }
    }
  });

  input.value = (vscode.getState() || {}).draft || '';
  vscode.postMessage({ type: 'ready' });
})();
