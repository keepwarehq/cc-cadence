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
  const agentsBtn = $('agents');
  const agentsPopup = $('agents-popup');
  const modePopup = $('mode-popup');
  const profilePopup = $('profile-popup');
  const fileInput = $('file-input');
  const statusEl = $('status');
  /** webview URI of the host's sent-image preview store; empty (tests, old hosts) → sent images show as name chips */
  const imageBase = document.body.dataset.images || '';

  /** @type {any[]} */
  let items = [];
  /** @type {{id: string, name: string, kind: string, mediaType?: string, thumb?: string}[]} */
  let attachments = [];
  let busy = false;
  let activeId = '';
  /** @type {Record<string, string>} */
  const profileLabels = {};
  /** @type {{id: string, label: string, description?: string}[]} */
  let profiles = [];
  /** @type {{id: string, label: string, detail?: string}[]} */
  let modelChoices = [];
  let currentModel = 'default';
  /** @type {{id: string, label: string, detail?: string}[]} */
  let effortChoices = [];
  let currentEffort = 'default';
  /** @type {string[]} */
  let modes = [];
  let currentMode = '';
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

  /** A sent image: clickable thumbnail that opens the lightbox; a store miss (pruned file) degrades to a name chip */
  function thumbButton(/** @type {string} */ src, /** @type {string} */ name) {
    const b = el('button', 'thumb');
    b.title = name;
    const img = document.createElement('img');
    img.src = src;
    img.alt = name;
    img.loading = 'lazy';
    img.addEventListener('error', () => b.replaceWith(el('span', 'chip', name)));
    b.appendChild(img);
    b.addEventListener('click', () => openLightbox(src, name));
    return b;
  }

  // ---- Lightbox: full-size view of an image; click anywhere or Esc closes ----

  /** @type {HTMLElement | undefined} */
  let lightbox;

  function openLightbox(/** @type {string} */ src, /** @type {string} */ name) {
    if (!lightbox) {
      lightbox = el('div', 'lightbox');
      lightbox.setAttribute('role', 'dialog');
      lightbox.setAttribute('aria-modal', 'true');
      lightbox.append(document.createElement('img'), el('div', 'caption'));
      lightbox.addEventListener('click', closeLightbox);
      document.body.appendChild(lightbox);
    }
    const img = /** @type {HTMLImageElement} */ (lightbox.querySelector('img'));
    img.src = src;
    img.alt = name;
    /** @type {HTMLElement} */ (lightbox.querySelector('.caption')).textContent = name;
    lightbox.hidden = false;
  }

  function closeLightbox() {
    if (lightbox) lightbox.hidden = true;
  }

  function render(item) {
    const node = el('div', 'item ' + item.kind);
    switch (item.kind) {
      case 'user': {
        node.classList.add('bubble');
        if (item.profile) node.appendChild(el('div', 'tag', item.profile));
        const atts = item.attachments || [];
        const pics = imageBase ? atts.filter(a => a.file) : [];
        const others = atts.filter(a => !pics.includes(a));
        if (pics.length) {
          const row = el('div', 'thumbs');
          for (const a of pics) row.appendChild(thumbButton(imageBase + '/' + encodeURIComponent(a.file), a.name));
          node.appendChild(row);
        }
        if (others.length) {
          const row = el('div', 'attachments');
          for (const a of others) row.appendChild(el('span', 'chip', a.name));
          node.appendChild(row);
        }
        node.appendChild(el('div', 'body', item.text));
        break;
      }
      case 'assistant':
        node.innerHTML = md(item.text);
        addCopyButtons(node);
        break;
      case 'thinking': {
        if (item.text) {
          const d = el('details');
          d.append(el('summary', '', 'Thinking'), el('div', 'text', item.text));
          node.appendChild(d);
        } else {
          // claude -p on the Max subscription redacts the reasoning text, streaming only an estimated token count —
          // show a compact label instead of an empty, misleading expander
          const tok = fmtTokens(item.tokens);
          node.appendChild(el('span', 'thinking-label', tok ? 'Thinking · ~' + tok : 'Thinking…'));
        }
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
        // one card per background agent / shell: name + live meta, then the current step or the result; click → details
        node.classList.add(item.status);
        const head = el('div', 'taskhead');
        head.append(
          el('span', 'tstate ' + item.status, stateGlyph(item.status)),
          el('span', 'name ' + taskKind(item), item.description || 'Background task'),
          el('span', 'meta', taskMeta(item)),
          el('span', 'open', 'Details \u203a'),
        );
        node.appendChild(head);
        node.appendChild(el('div', 'detail', taskLine(item)));
        node.title = 'Show details';
        node.addEventListener('click', () => openTaskPanel(item.taskId));
        break;
      }
      case 'notice':
        node.classList.add(item.level);
        node.appendChild(el('span', '', item.text));
        if (item.action === 'checkTasks') {
          const btn = el('button', 'check', 'Check now');
          btn.addEventListener('click', () => vscode.postMessage({ type: 'checkTasks' }));
          node.appendChild(btn);
        } else if (item.action === 'setKey' && item.profileId) {
          const btn = el('button', 'check', 'Set API key');
          btn.addEventListener('click', () => vscode.postMessage({ type: 'setKey', profileId: item.profileId }));
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
    updateAgents();
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
        updateAgents();
        if (stick) scrollEnd();
        break;
      }
      case 'set':
        items[m.index] = m.item;
        mark(m.index);
        updateAgents();
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

  function fmtDuration(ms) {
    if (typeof ms !== 'number' || ms <= 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + 'm ' + r + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function fmtTokens(n) {
    if (typeof n !== 'number' || n <= 0) return '';
    if (n >= 1000) return Math.round(n / 100) / 10 + 'k tokens';
    return n + ' tokens';
  }

  function stateGlyph(/** @type {string} */ status) {
    return status === 'ok' ? '\u2713' : status === 'error' ? '\u2717' : ''; // running: a CSS spinner
  }

  function taskKind(item) {
    return item.taskType === 'local_bash' ? 't-shell' : 't-agent';
  }

  /** "12s · 14.7k tokens": a running task ticks from its start time; a finished one shows its final duration */
  function taskMeta(item) {
    const ms = item.status === 'running' && item.startedAt ? Date.now() - item.startedAt : item.durationMs;
    return [fmtDuration(ms), fmtTokens(item.tokens)].filter(Boolean).join(' \u00b7 ');
  }

  /** The card's second line: what it is doing now, or how it ended */
  function taskLine(item) {
    if (item.status === 'running') return item.activity || (item.background ? 'Running in the background\u2026' : 'Working\u2026');
    return item.summary || (item.status === 'ok' ? 'Done' : 'Failed');
  }

  function modeLabel(mode) {
    return mode === 'bypassPermissions' ? 'Bypass' : mode.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
  }

  const MODE_INFO = [
    ['bypassPermissions', 'Bypass permissions', 'Never ask before running commands or editing files'],
    ['acceptEdits', 'Edit automatically', 'Approve file edits in the active folder automatically'],
    ['plan', 'Plan', 'Explore the code and present a plan before editing'],
    ['default', 'Manual', 'Ask before every tool call'],
    ['dontAsk', 'Don\'t ask', 'Never ask; denied tools are skipped silently'],
    ['auto', 'Auto', 'Approve actions that pass a safety check and pause for anything risky'],
  ];

  function renderModePopup() {
    closeProfileMenu();
    modePopup.replaceChildren(...MODE_INFO
      .filter(([id]) => modes.includes(id))
      .map(([id, label, desc]) => {
        const row = el('div', 'mode-row' + (id === currentMode ? ' active' : ''));
        row.append(el('span', 'mode-label', label), el('span', 'mode-desc', desc));
        row.addEventListener('click', () => {
          vscode.postMessage({ type: 'setMode', mode: id });
          closeModeMenu();
        });
        return row;
      }));
    modePopup.hidden = false;
  }

  function closeModeMenu() { modePopup.hidden = true; }

  modePill.addEventListener('click', () => (modePopup.hidden ? renderModePopup() : closeModeMenu()));

  /** Single-line menu row: label left, dim detail right (keeps provider + model + effort on one screen) */
  function menuRow(label, desc, active, onPick) {
    const row = el('div', 'menu-row' + (active ? ' active' : ''));
    row.append(el('span', 'menu-label', label));
    if (desc) row.append(el('span', 'menu-desc', desc));
    row.addEventListener('click', () => { onPick(); closeProfileMenu(); });
    return row;
  }

  /** Provider rows, then the active provider's model rows, then the add/manage actions */
  function renderProfilePopup() {
    closeModeMenu();
    const rows = [el('div', 'menu-header', 'Provider')];
    for (const p of profiles) {
      const row = menuRow(p.label, p.description, p.id === activeId, () => vscode.postMessage({ type: 'setProfile', id: p.id }));
      row.dataset.profile = p.id;
      rows.push(row);
    }
    if (modelChoices.length > 1) {
      rows.push(el('div', 'menu-header', 'Model'));
      for (const c of modelChoices) {
        const row = menuRow(c.label, c.detail, c.id === currentModel, () => vscode.postMessage({ type: 'setModel', model: c.id }));
        row.dataset.model = c.id;
        rows.push(row);
      }
    }
    if (effortChoices.length > 1) rows.push(effortRow());
    rows.push(el('div', 'menu-sep'));
    rows.push(menuRow('Add model\u2026', '', false, () => vscode.postMessage({ type: 'addProfile' })));
    rows.push(menuRow('Manage models\u2026', '', false, () => vscode.postMessage({ type: 'manageProfiles' })));
    profilePopup.replaceChildren(...rows);
    profilePopup.hidden = false;
  }

  function closeProfileMenu() { profilePopup.hidden = true; }

  /** One slider row: a dot per level; clicking the active dot goes back to default (no --effort) */
  function effortRow() {
    const row = el('div', 'effort-row');
    const current = effortChoices.find(c => c.id === currentEffort && c.id !== 'default');
    row.append(el('span', 'effort-label', 'Effort'), el('span', 'effort-value', current ? current.label : 'Default'));
    const track = el('div', 'effort-track');
    for (const c of effortChoices.filter(x => x.id !== 'default')) {
      const dot = el('div', 'effort-dot' + (c.id === currentEffort ? ' active' : ''));
      dot.dataset.effort = c.id;
      dot.title = c.label + ' (' + c.detail + ')';
      dot.addEventListener('click', () => {
        currentEffort = c.id === currentEffort ? 'default' : c.id;
        vscode.postMessage({ type: 'setEffort', effort: currentEffort });
        row.replaceWith(effortRow());
      });
      track.appendChild(dot);
    }
    row.appendChild(track);
    return row;
  }

  profilePill.addEventListener('click', () => (profilePopup.hidden ? renderProfilePopup() : closeProfileMenu()));

  function updateAgents() {
    const running = items.filter(x => x?.kind === 'task' && x.status === 'running');
    agentsBtn.hidden = items.every(x => x?.kind !== 'task');
    agentsBtn.textContent = '\u26a1' + (running.length ? running.length : '');
    agentsBtn.classList.toggle('live', running.length > 0);
    agentsBtn.title = running.length ? `${running.length} of ${items.filter(x => x?.kind === 'task').length} background tasks running` : 'Background tasks';
    if (!agentsBtn.hidden && !agentsPopup.hidden) renderAgentsPopup();
    if (panel && !panel.hidden) refreshPanelHead();
    syncTicker();
  }

  // ---- Live elapsed time on running task cards (only while the CLI is alive: a running task implies it) ----

  let ticker = 0;

  function syncTicker() {
    const live = busy && items.some(x => x?.kind === 'task' && x.status === 'running');
    if (live && !ticker) ticker = setInterval(tick, 1000);
    else if (!live && ticker) { clearInterval(ticker); ticker = 0; }
  }

  function tick() {
    items.forEach((x, i) => {
      if (x?.kind !== 'task' || x.status !== 'running') return;
      const m = log.children[i]?.querySelector('.taskhead .meta');
      if (m) m.textContent = taskMeta(x);
    });
    if (!agentsPopup.hidden) renderAgentsPopup();
    if (panel && !panel.hidden) refreshPanelHead();
  }

  // ---- Task detail panel: a subagent's full transcript (or a shell's output), refreshed while it runs ----

  /** @type {HTMLElement | undefined} */
  let panel;
  let panelTask = '';
  let panelPoll = 0;
  /** JSON of each rendered panel item, so a refresh only re-renders what changed (keeps expanded tool output open) */
  /** @type {string[]} */
  let panelSeen = [];

  function panelPart(/** @type {string} */ cls) {
    return /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (panel).querySelector(cls));
  }

  function openTaskPanel(/** @type {string} */ taskId) {
    if (!panel) {
      panel = el('div', 'taskpanel-backdrop');
      const box = el('div', 'taskpanel');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      const head = el('header', 'taskpanel-head');
      const close = el('button', 'close', '\u00d7');
      close.title = 'Close (Esc)';
      close.addEventListener('click', closeTaskPanel);
      head.append(el('span', 'tstate'), el('span', 'title'), el('span', 'meta'), close);
      box.append(head, el('div', 'taskpanel-sub'), el('div', 'taskpanel-note'), el('div', 'taskpanel-body'));
      panel.appendChild(box);
      panel.addEventListener('mousedown', e => { if (e.target === panel) closeTaskPanel(); });
      document.body.appendChild(panel);
    }
    panelTask = taskId;
    panelSeen = [];
    panel.hidden = false;
    panelPart('.taskpanel-note').hidden = true;
    panelPart('.taskpanel-body').replaceChildren(el('div', 'taskpanel-empty', 'Loading\u2026'));
    refreshPanelHead();
    vscode.postMessage({ type: 'taskDetail', taskId });
  }

  function closeTaskPanel() {
    if (panel) panel.hidden = true;
    panelTask = '';
    clearTimeout(panelPoll);
  }

  function panelTaskItem() {
    return items.find(x => x?.kind === 'task' && x.taskId === panelTask);
  }

  function refreshPanelHead() {
    const t = panelTaskItem();
    if (!t) return closeTaskPanel(); // the chat was cleared or replaced
    const st = panelPart('.taskpanel-head .tstate');
    st.className = 'tstate ' + t.status;
    st.textContent = stateGlyph(t.status);
    panelPart('.taskpanel-head .title').textContent = t.description || 'Background task';
    panelPart('.taskpanel-head .meta').textContent = taskMeta(t);
    const sub = panelPart('.taskpanel-sub');
    sub.className = 'taskpanel-sub ' + t.status;
    sub.textContent = taskLine(t);
  }

  function renderPanelBody(m) {
    const body = panelPart('.taskpanel-body');
    const first = !panelSeen.length;
    const stick = first || body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    const note = panelPart('.taskpanel-note');
    note.hidden = !m.truncated;
    note.textContent = m.truncated ? 'Showing the most recent part only.' : '';
    const running = panelTaskItem()?.status === 'running';
    const list = Array.isArray(m.items) ? m.items.map((it, i) => (i === 0 && it.kind === 'user' ? { ...it, profile: 'Prompt' } : it)) : [];
    if (list.length) {
      if (first) body.replaceChildren();
      list.forEach((it, i) => {
        const json = JSON.stringify(it);
        if (panelSeen[i] === json) return;
        const node = render(it);
        if (body.children[i]) body.children[i].replaceWith(node);
        else body.appendChild(node);
        panelSeen[i] = json;
      });
      while (body.children.length > list.length) body.lastChild?.remove();
      panelSeen.length = list.length;
    } else {
      panelSeen = [];
      const text = typeof m.text === 'string' && m.text ? m.text : '';
      body.replaceChildren(text
        ? el('pre', 'taskpanel-output', text)
        : el('div', 'taskpanel-empty', running ? 'Nothing recorded yet\u2026' : 'No output was recorded for this task.'));
    }
    if (stick) body.scrollTop = body.scrollHeight;
    clearTimeout(panelPoll);
    if (running && busy) panelPoll = setTimeout(() => vscode.postMessage({ type: 'taskDetail', taskId: panelTask }), 1500);
  }

  function renderAgentsPopup() {
    const tasks = items.filter(x => x?.kind === 'task');
    agentsPopup.replaceChildren(...(tasks.length
      ? tasks.map(x => {
          const row = el('div', 'agent-row ' + x.status);
          row.append(el('span', 'tstate ' + x.status, stateGlyph(x.status)),
                     el('span', 'name', x.description),
                     el('span', 'sub', taskLine(x)));
          const meta = taskMeta(x);
          if (meta) row.appendChild(el('span', 'meta', meta));
          row.addEventListener('click', () => {
            closeAgents();
            openTaskPanel(x.taskId);
          });
          return row;
        })
      : [el('div', 'mention-empty', 'No background tasks in this conversation')]));
    agentsPopup.hidden = false;
  }

  function closeAgents() { agentsPopup.hidden = true; }

  agentsBtn.addEventListener('click', () => (agentsPopup.hidden ? renderAgentsPopup() : closeAgents()));

  function renderChips() {
    chips.replaceChildren(...attachments.map(a => {
      const thumb = thumbs.get(a.id);
      const c = el('span', 'chip' + (a.kind === 'image' ? ' img' : '') + (thumb ? ' tile' : ''));
      if (thumb) {
        c.title = a.name;
        const img = document.createElement('img');
        img.src = thumb;
        img.alt = a.name;
        img.addEventListener('click', () => openLightbox(thumb, a.name));
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
    profiles = m.profiles;
    for (const p of m.profiles) profileLabels[p.id] = p.label;
    modelChoices = m.modelChoices || [];
    currentModel = m.model || 'default';
    effortChoices = m.effortChoices || [];
    currentEffort = m.effort || 'default';
    modes = m.modes;
    profilePill.textContent = [
      profileLabels[activeId] || activeId,
      currentModel !== 'default' ? currentModel : '',
      currentEffort !== 'default' ? currentEffort + ' effort' : '',
    ].filter(Boolean).join(' \u00b7 ');
    if (!profilePopup.hidden) renderProfilePopup();
    currentMode = m.mode;
    remember({ sessionId: m.sessionId, mode: m.mode });
    modePill.textContent = modeLabel(m.mode);
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
    syncTicker();
  }

  function send() {
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
    syncHighlight();
    remember({ draft: '' });
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));

  // The ＋ button has a single action, so it opens the file picker directly (no menu).
  $('attach').addEventListener('click', () => fileInput.click());

  // ---- Session history: opened from the view title bar (host sends the list), drops down at the top right ----

  const historyPopup = $('history-popup');
  const historySearch = el('input', 'history-search');
  historySearch.type = 'text';
  historySearch.placeholder = 'Search sessions\u2026';
  const historyList = el('div', 'history-list');
  historyPopup.append(historySearch, historyList);
  /** @type {{id: string, title: string, ago: string}[]} */
  let sessions = [];
  let currentSession = '';

  function renderHistoryList() {
    const q = historySearch.value.trim().toLowerCase();
    const shown = sessions.filter(s => !q || s.title.toLowerCase().includes(q));
    if (!shown.length) {
      historyList.replaceChildren(el('div', 'history-empty', sessions.length ? 'No matching sessions' : 'No saved sessions for this folder yet.'));
      return;
    }
    historyList.replaceChildren(...shown.map(s => {
      const row = el('div', 'history-row' + (s.id === currentSession ? ' active' : ''));
      row.dataset.session = s.id;
      const del = el('span', 'history-delete', '\u00d7');
      del.title = 'Delete session';
      del.addEventListener('click', e => {
        e.stopPropagation();
        if (!del.classList.contains('armed')) {
          del.classList.add('armed');
          del.textContent = 'Delete?';
          return;
        }
        vscode.postMessage({ type: 'deleteSession', id: s.id });
      });
      row.append(el('span', 'history-title', s.title), el('span', 'history-ago', s.ago), del);
      row.addEventListener('click', () => {
        closeHistory();
        vscode.postMessage({ type: 'resumeSession', id: s.id });
      });
      return row;
    }));
  }

  function openHistory(m) {
    if (historyPopup.hidden) historySearch.value = '';
    sessions = m.items || [];
    currentSession = m.current || '';
    closeModeMenu();
    closeProfileMenu();
    historyPopup.hidden = false;
    renderHistoryList();
    historySearch.focus();
  }

  function closeHistory() { historyPopup.hidden = true; }

  historySearch.addEventListener('input', renderHistoryList);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeLightbox();
    closeTaskPanel();
    closeHistory();
    closeModeMenu();
    closeProfileMenu();
  });
  // Every composer popup closes when a mousedown lands outside both it and the pill that opens it.
  // mousedown (not click) so it fires before the pill's own click re-toggles.
  const OUTSIDE_CLOSE = [
    [historyPopup, null, closeHistory],
    [profilePopup, profilePill, closeProfileMenu],
    [modePopup, modePill, closeModeMenu],
    [agentsPopup, agentsBtn, closeAgents],
  ];
  document.addEventListener('mousedown', e => {
    const target = /** @type {Node} */ (e.target);
    for (const [popup, pill, close] of OUTSIDE_CLOSE) {
      if (popup.hidden) continue;
      if (popup.contains(target)) continue;
      if (pill && pill.contains(target)) continue;
      close();
    }
  });
  fileInput.addEventListener('change', () => {
    for (const f of [...(fileInput.files ?? [])]) fileToAttachment(f, m => vscode.postMessage(m));
    fileInput.value = '';
  });
  $('mention').addEventListener('click', () => startMention());
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
          // mousedown (not click) so the textarea keeps focus and the caret position
          row.addEventListener('mousedown', e => { e.preventDefault(); pickMention(it); });
          return row;
        })
      : [el('div', 'mention-empty', 'No matches')]));
    popup.hidden = false;
  }

  function saveDraft() {
    remember({ draft: input.value });
  }

  /** Merge into the webview state; VS Code hands it back to the panel serializer after a window reload */
  function remember(patch) {
    vscode.setState({ ...(vscode.getState() || {}), ...patch });
  }

  /** Replace the `@query` being typed with `@path` (kept, like Claude Code); files get a trailing space, folders stay open for drilling in */
  function pickMention(/** @type {{path: string, kind: string}} */ it) {
    if (mentionAnchor < 0) return;
    const end = input.selectionEnd ?? input.value.length;
    const token = '@' + it.path + (it.kind === 'folder' ? '' : ' ');
    const rest = input.value.slice(end).replace(/^\S*/, ''); // drop the rest of a half-typed word after the caret
    input.value = input.value.slice(0, mentionAnchor) + token + (it.kind === 'folder' ? rest : rest.replace(/^ /, ''));
    const caret = mentionAnchor + token.length;
    input.setSelectionRange(caret, caret);
    input.focus();
    closeMention();
    syncHighlight();
    saveDraft();
    if (it.kind === 'folder') openMention(mentionAnchorFor(caret), it.path);
  }

  const mentionAnchorFor = (/** @type {number} */ caret) => input.value.lastIndexOf('@', caret - 1);

  /** Toolbar @ button: start a new mention at the caret and open the picker */
  function startMention() {
    const pos = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, pos);
    const lead = !before || /\s$/.test(before) ? '@' : ' @';
    input.value = before + lead + input.value.slice(pos);
    const caret = pos + lead.length;
    input.setSelectionRange(caret, caret);
    input.focus();
    syncHighlight();
    saveDraft();
    openMention(caret - 1, '');
  }

  // ---- Mention highlighting: a mirror layer behind the transparent textarea paints @tokens ----

  const inputWrap = el('div', 'input-wrap');
  const inputHl = el('div', 'input-hl');
  inputHl.setAttribute('aria-hidden', 'true');
  input.parentNode.insertBefore(inputWrap, input);
  inputWrap.append(inputHl, input);

  function syncHighlight() {
    const text = input.value;
    const re = /(^|\s)(@[^\s@]+)/g;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (let m; (m = re.exec(text));) {
      const start = m.index + m[1].length;
      frag.append(text.slice(last, start), el('mark', 'mention-token', m[2]));
      last = start + m[2].length;
    }
    // trailing newline needs a placeholder char or the mirror ends one line short
    frag.append(text.slice(last) + (text.endsWith('\n') ? ' ' : ''));
    inputHl.replaceChildren(frag);
    inputHl.scrollTop = input.scrollTop;
  }

  input.addEventListener('scroll', () => { inputHl.scrollTop = input.scrollTop; });

  input.addEventListener('input', () => {
    syncHighlight();
    saveDraft();
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
      if (e.key === 'Enter' || e.key === 'Tab') { pickMention(mentionItems[mentionActive]); e.preventDefault(); return; }
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
    else if (m.type === 'sessions') openHistory(m);
    else if (m.type === 'busy') setBusy(m.busy);
    else if (m.type === 'status') statusEl.textContent = m.text || '';
    else if (m.type === 'session') remember({ sessionId: m.sessionId });
    else if (m.type === 'taskDetail') {
      if (panel && !panel.hidden && m.taskId === panelTask) renderPanelBody(m);
    }
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
  syncHighlight();
  window.addEventListener('resize', syncHighlight);
  vscode.postMessage({ type: 'ready' });
})();
