(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const esc = (value = '') => String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  const attr = (value = '') => encodeURIComponent(String(value));
  const unattr = (value = '') => decodeURIComponent(value);
  const icon = name => `<span class="app-icon icon-${name}"></span>`;
  const svg = (name) => ({
    back: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4m-5 5 5-5 5 5M5 19h14"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M5 4h12l2 2v14H5V4Zm3 0v6h8V4M8 20v-7h8v7"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4v12m-5-5 5 5 5-5M5 20h14"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>'
  }[name] || '');

  const state = {
    session: null,
    windows: new Map(),
    activeWindow: null,
    z: 20,
    cascade: 0,
    locked: false,
    quickTimer: null,
    uploadTarget: null,
    lastSystem: null
  };

  async function api(path, options = {}) {
    const config = {...options};
    config.headers = {...(options.headers || {})};
    const method = (config.method || 'GET').toUpperCase();
    if (state.session?.csrf && !['GET', 'HEAD'].includes(method)) {
      config.headers['X-LumaDesk-CSRF'] = state.session.csrf;
    }
    if (config.body && !(config.body instanceof FormData) && typeof config.body !== 'string') {
      config.headers['Content-Type'] = 'application/json';
      config.body = JSON.stringify(config.body);
    }
    let response;
    try {
      response = await fetch(path, config);
    } catch (error) {
      throw new Error('Cannot reach the LumaDesk service');
    }
    let data;
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) data = await response.json();
    else data = {ok: response.ok, text: await response.text()};
    if (response.status === 401 && path !== '/api/login') {
      lockDesktop(true);
      throw new Error('Your session has expired');
    }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function formatBytes(bytes, decimals = 1) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** index).toFixed(index ? decimals : 0)} ${units[index]}`;
  }

  function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
  }

  function timeAgo(epoch) {
    const delta = Math.max(0, Math.floor(Date.now() / 1000 - epoch));
    if (delta < 60) return 'just now';
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return new Date(epoch * 1000).toLocaleDateString();
  }

  function toast(title, message, kind = 'success', timeout = 3600) {
    const holder = $('#notifications');
    if (!holder) return;
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.innerHTML = `<div class="toast-icon">${kind === 'error' ? '!' : '✓'}</div><div><strong>${esc(title)}</strong><span>${esc(message)}</span></div><button aria-label="Dismiss">×</button>`;
    const remove = () => { node.classList.add('leaving'); setTimeout(() => node.remove(), 240); };
    $('button', node).addEventListener('click', remove);
    holder.append(node);
    if (timeout) setTimeout(remove, timeout);
  }

  function showDialog({title, message = '', input = null, confirm = 'Continue', danger = false}) {
    return new Promise(resolve => {
      const backdrop = document.createElement('div');
      backdrop.className = 'dialog-backdrop';
      backdrop.innerHTML = `<form class="dialog">
        <h3>${esc(title)}</h3>${message ? `<p>${esc(message)}</p>` : ''}
        ${input ? `<input name="value" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" autocomplete="off">` : ''}
        <div class="dialog-actions"><button type="button" class="tool-button cancel">Cancel</button><button type="submit" class="tool-button ${danger ? 'danger' : 'primary'}">${esc(confirm)}</button></div>
      </form>`;
      $('#desktop').append(backdrop);
      const field = $('input', backdrop);
      if (field) { field.focus(); field.select(); }
      const done = value => { backdrop.remove(); resolve(value); };
      $('.cancel', backdrop).addEventListener('click', () => done(null));
      backdrop.addEventListener('mousedown', event => { if (event.target === backdrop) done(null); });
      $('form', backdrop).addEventListener('submit', event => {
        event.preventDefault();
        done(field ? field.value.trim() : true);
      });
    });
  }

  function setClock() {
    const now = new Date();
    const time = now.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    $('#clock').textContent = time;
    $('#quick-clock').textContent = time;
    $('#quick-date').textContent = now.toLocaleDateString([], {weekday: 'long', day: 'numeric', month: 'long'});
  }

  function hidePanels(except = null) {
    ['launcher', 'system-menu', 'quick-panel'].forEach(id => {
      if (id !== except) $(`#${id}`).classList.add('hidden');
    });
  }

  async function quickStatus() {
    if (!state.session || state.locked || document.hidden) return;
    try {
      const data = await api('/api/system');
      const system = data.system;
      state.lastSystem = system;
      $('#quick-cpu').textContent = `${Math.round(system.cpu.percent)}%`;
      $('#quick-memory').textContent = `${Math.round(system.memory.percent)}%`;
      $('#quick-cpu-bar').style.width = `${system.cpu.percent}%`;
      $('#quick-memory-bar').style.width = `${system.memory.percent}%`;
    } catch (_) { /* status is best effort */ }
  }

  function startDesktopServices() {
    setClock();
    setInterval(setClock, 1000);
    clearInterval(state.quickTimer);
    quickStatus();
    state.quickTimer = setInterval(quickStatus, 12000);
  }

  function updateSessionLabels() {
    const user = state.session?.user || 'webos';
    const host = state.session?.host || location.hostname;
    $('#launcher-user').textContent = user;
    $('#menu-user').textContent = user;
    $('#menu-host').textContent = host;
    $('#login-host').textContent = host;
  }

  async function checkSession() {
    try {
      const info = await api('/api/session');
      if (info.authenticated) {
        state.session = info;
        updateSessionLabels();
        await showDesktop();
      } else showLogin();
    } catch (_) { showLogin('The workspace service is not responding.'); }
  }

  async function showDesktop() {
    state.locked = false;
    $('#login').classList.add('hidden');
    $('#desktop').classList.remove('hidden');
    startDesktopServices();
    await sleep(120);
    if (state.session?.runtime && state.session.runtime !== 'systemd') {
      setTimeout(() => toast('Platform compatibility mode', 'Terminal, files, and monitoring are ready. systemd service control is unavailable on this host.'), 450);
    }
    if (!localStorage.getItem('lumadesk.seen')) {
      openApp('welcome');
      localStorage.setItem('lumadesk.seen', '1');
    }
  }

  function showLogin(error = '') {
    $('#desktop').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#login-error').textContent = error;
    setTimeout(() => $('#password').focus(), 80);
  }

  function lockDesktop(expired = false) {
    state.locked = true;
    state.session = expired ? null : state.session;
    hidePanels();
    showLogin(expired ? 'Your session ended. Sign in again.' : 'Workspace locked.');
    $('#password').value = '';
  }

  async function signOut() {
    try { await api('/api/logout', {method: 'POST', body: {}}); } catch (_) {}
    state.windows.forEach(win => closeWindow(win, true));
    state.windows.clear();
    state.session = null;
    lockDesktop(false);
    $('#login-error').textContent = 'Signed out safely.';
  }

  // Window manager
  function updateDock() {
    $$('.dock-button[data-app]').forEach(button => {
      const appId = button.dataset.app;
      const appWindows = [...state.windows.values()].filter(win => win.dataset.app === appId);
      button.classList.toggle('running', appWindows.length > 0);
      button.classList.toggle('focused', appWindows.some(win => win === state.activeWindow && !win.classList.contains('minimized')));
    });
  }

  function focusWindow(win) {
    if (!win || !document.body.contains(win)) return;
    $$('.app-window.active').forEach(node => node.classList.remove('active'));
    win.classList.remove('minimized');
    win.classList.add('active');
    win.style.zIndex = ++state.z;
    state.activeWindow = win;
    $('#active-app-title').textContent = win.dataset.title || 'Desktop';
    updateDock();
    win._onFocus?.();
  }

  function closeWindow(win, immediate = false) {
    if (!win) return;
    try { win._cleanup?.(); } catch (_) {}
    state.windows.delete(win.dataset.key);
    if (immediate) win.remove();
    else {
      win.style.transition = 'opacity .16s, transform .16s';
      win.style.opacity = '0';
      win.style.transform = 'scale(.96) translateY(10px)';
      setTimeout(() => win.remove(), 170);
    }
    if (state.activeWindow === win) {
      const candidates = [...state.windows.values()].filter(node => !node.classList.contains('minimized'));
      state.activeWindow = candidates.sort((a, b) => (+b.style.zIndex || 0) - (+a.style.zIndex || 0))[0] || null;
      if (state.activeWindow) focusWindow(state.activeWindow);
      else $('#active-app-title').textContent = 'Desktop';
    }
    updateDock();
  }

  function positionWindow(win, app) {
    const layer = $('#window-layer');
    const width = Math.min(app.width || 840, Math.max(430, layer.clientWidth - 30));
    const height = Math.min(app.height || 560, Math.max(280, layer.clientHeight - 14));
    win.style.setProperty('--w', `${width}px`);
    win.style.setProperty('--h', `${height}px`);
    const offset = state.cascade++ % 7;
    const left = Math.max(7, (layer.clientWidth - width) / 2 + offset * 18 - 45);
    const top = Math.max(5, (layer.clientHeight - height) / 2 + offset * 13 - 20);
    win.style.left = `${Math.min(left, layer.clientWidth - width - 7)}px`;
    win.style.top = `${Math.min(top, layer.clientHeight - height - 3)}px`;
  }

  function makeDraggable(win) {
    const bar = $('.window-titlebar', win);
    bar.addEventListener('pointerdown', event => {
      if (event.target.closest('button') || win.classList.contains('maximized') || matchMedia('(max-width: 720px)').matches) return;
      focusWindow(win);
      const rect = win.getBoundingClientRect();
      const layerRect = $('#window-layer').getBoundingClientRect();
      const startX = event.clientX, startY = event.clientY;
      const left = rect.left - layerRect.left, top = rect.top - layerRect.top;
      bar.setPointerCapture(event.pointerId);
      const move = moveEvent => {
        const nextLeft = Math.max(-rect.width + 110, Math.min(layerRect.width - 110, left + moveEvent.clientX - startX));
        const nextTop = Math.max(0, Math.min(layerRect.height - 45, top + moveEvent.clientY - startY));
        win.style.left = `${nextLeft}px`; win.style.top = `${nextTop}px`;
      };
      const end = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', end); };
      bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', end);
    });
    $('.resize-handle', win).addEventListener('pointerdown', event => {
      if (win.classList.contains('maximized')) return;
      event.preventDefault(); focusWindow(win);
      const startX = event.clientX, startY = event.clientY;
      const startW = win.offsetWidth, startH = win.offsetHeight;
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const move = e => {
        win.style.width = `${Math.max(430, Math.min(innerWidth - win.offsetLeft - 8, startW + e.clientX - startX))}px`;
        win.style.height = `${Math.max(280, Math.min($('#window-layer').clientHeight - win.offsetTop, startH + e.clientY - startY))}px`;
        win._onResize?.();
      };
      const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end);
    });
  }

  function toggleMaximize(win) {
    win.classList.toggle('maximized');
    setTimeout(() => win._onResize?.(), 190);
  }

  function openApp(id, options = {}) {
    const app = apps[id];
    if (!app) return;
    hidePanels();
    const key = options.key || (app.singleton === false ? `${id}:${Date.now()}:${Math.random()}` : id);
    const existing = state.windows.get(key);
    if (existing) { focusWindow(existing); return existing; }
    const win = $('#window-template').content.firstElementChild.cloneNode(true);
    win.dataset.app = id; win.dataset.key = key; win.dataset.title = options.title || app.title;
    $('.window-title strong', win).textContent = options.title || app.title;
    $('.window-app-icon', win).innerHTML = icon(app.icon || id);
    $('.window-content', win).innerHTML = app.render ? app.render(options) : '';
    positionWindow(win, app);
    win.style.zIndex = ++state.z;
    $('#window-layer').append(win);
    state.windows.set(key, win);
    makeDraggable(win);
    $('.close', win).addEventListener('click', () => closeWindow(win));
    $('.minimize', win).addEventListener('click', () => { win.classList.add('minimized'); updateDock(); });
    $('.maximize', win).addEventListener('click', () => toggleMaximize(win));
    $('.window-titlebar', win).addEventListener('dblclick', event => { if (!event.target.closest('button')) toggleMaximize(win); });
    win.addEventListener('pointerdown', () => focusWindow(win));
    focusWindow(win);
    Promise.resolve(app.mount?.(win, options)).catch(error => {
      toast(`${app.title} error`, error.message, 'error');
      const content = $('.window-content', win);
      if (content) content.innerHTML = `<div class="app-empty"><div><strong>Something went wrong</strong><p>${esc(error.message)}</p></div></div>`;
    });
    updateDock();
    return win;
  }

  // Files app
  function filesMarkup() {
    return `<div class="files-shell">
      <aside class="files-sidebar">
        <div class="sidebar-label">Places</div>
        <button class="place-button active" data-path="/"><span class="place-icon">⌂</span>Home</button>
        <button class="place-button" data-path="/Desktop"><span class="place-icon">▣</span>Desktop</button>
        <button class="place-button" data-path="/Documents"><span class="place-icon">▤</span>Documents</button>
        <button class="place-button" data-path="/Downloads"><span class="place-icon">⇣</span>Downloads</button>
        <div class="sidebar-label">Storage</div>
        <button class="place-button" data-path="/"><span class="place-icon">◉</span>Workspace</button>
      </aside>
      <section class="files-main">
        <div class="app-toolbar files-toolbar">
          <div class="nav-group"><button class="tool-button icon-tool file-back" title="Back">${svg('back')}</button><button class="tool-button icon-tool file-up" title="Parent">${svg('up')}</button><button class="tool-button icon-tool file-refresh" title="Refresh">${svg('refresh')}</button></div>
          <div class="breadcrumb"></div>
          <button class="tool-button file-new">${svg('plus')} New</button><button class="tool-button file-upload">${svg('upload')} Upload</button>
        </div>
        <div class="files-grid"><div class="app-empty"><div><div class="spinner"></div><p>Opening workspace…</p></div></div></div>
        <div class="files-status"><span class="file-count">—</span><span>Home volume</span></div>
      </section>
    </div>`;
  }

  function mountFiles(win) {
    const local = {path: '/', history: [], index: -1, entries: [], selected: null};
    win._fileState = local;
    const grid = $('.files-grid', win);

    const renderBreadcrumb = () => {
      const parts = local.path.split('/').filter(Boolean);
      let current = '';
      $('.breadcrumb', win).innerHTML = `<span data-path="/">Home</span>` + parts.map(part => {
        current += `/${part}`;
        return `<i>›</i><span data-path="${attr(current)}">${esc(part)}</span>`;
      }).join('');
    };

    const renderEntries = () => {
      if (!local.entries.length) {
        grid.innerHTML = `<div class="app-empty" style="grid-column:1/-1"><div><strong>This folder is empty</strong><p>Drop files here or use New to create something.</p></div></div>`;
      } else {
        grid.innerHTML = local.entries.map(item => {
          const folder = item.type === 'directory';
          const extension = folder ? '' : (item.name.split('.').pop() || 'file').slice(0, 5);
          return `<button class="file-entry" data-path="${attr(item.path)}" data-type="${item.type}" title="${esc(item.name)}">
            <span class="file-glyph ${folder ? 'folder' : ''}" data-ext="${esc(extension)}"></span><span class="file-name">${esc(item.name)}</span>
          </button>`;
        }).join('');
      }
      $('.file-count', win).textContent = `${local.entries.length} item${local.entries.length === 1 ? '' : 's'}`;
    };

    const load = async (path = local.path, addHistory = true) => {
      grid.innerHTML = `<div class="app-empty" style="grid-column:1/-1"><div><div class="spinner"></div><p>Loading…</p></div></div>`;
      const data = await api(`/api/files?path=${encodeURIComponent(path)}`);
      local.path = data.path; local.entries = data.entries; local.selected = null;
      if (addHistory && local.history[local.index] !== local.path) {
        local.history = local.history.slice(0, local.index + 1); local.history.push(local.path); local.index++;
      }
      renderBreadcrumb(); renderEntries();
      $('.file-back', win).disabled = local.index <= 0;
      $('.file-up', win).disabled = !data.parent;
      $$('.place-button', win).forEach(button => button.classList.toggle('active', button.dataset.path === local.path));
    };
    local.load = load;

    grid.addEventListener('click', event => {
      const entry = event.target.closest('.file-entry');
      if (!entry) { local.selected = null; $$('.file-entry', grid).forEach(e => e.classList.remove('selected')); return; }
      $$('.file-entry', grid).forEach(e => e.classList.remove('selected'));
      entry.classList.add('selected'); local.selected = unattr(entry.dataset.path);
    });
    grid.addEventListener('dblclick', event => {
      const entry = event.target.closest('.file-entry'); if (!entry) return;
      const path = unattr(entry.dataset.path);
      if (entry.dataset.type === 'directory') load(path);
      else openEditor(path);
    });
    grid.addEventListener('contextmenu', async event => {
      const entry = event.target.closest('.file-entry'); if (!entry) return;
      event.preventDefault();
      local.selected = unattr(entry.dataset.path);
      const choice = await showDialog({title: 'File action', message: 'Type “rename” or “delete” for the selected item.', input: {placeholder: 'rename or delete'}, confirm: 'Continue'});
      if (choice === 'rename') renameSelected();
      if (choice === 'delete') deleteSelected();
    });
    $('.breadcrumb', win).addEventListener('click', event => { const crumb = event.target.closest('[data-path]'); if (crumb) load(unattr(crumb.dataset.path)); });
    $$('.place-button', win).forEach(button => button.addEventListener('click', () => load(button.dataset.path)));
    $('.file-back', win).addEventListener('click', () => { if (local.index > 0) { local.index--; load(local.history[local.index], false); } });
    $('.file-up', win).addEventListener('click', () => { const parent = local.path.split('/').slice(0, -1).join('/') || '/'; load(parent); });
    $('.file-refresh', win).addEventListener('click', () => load(local.path, false));
    $('.file-new', win).addEventListener('click', async () => {
      const name = await showDialog({title: 'Create an item', message: 'Add a trailing slash to create a folder.', input: {placeholder: 'notes.txt or Projects/'}, confirm: 'Create'});
      if (!name) return;
      const isFolder = name.endsWith('/');
      try {
        await api('/api/files/create', {method: 'POST', body: {parent: local.path, name: isFolder ? name.slice(0, -1) : name, type: isFolder ? 'directory' : 'file'}});
        toast('Created', `${name} was added to this folder.`); await load(local.path, false);
      } catch (error) { toast('Could not create item', error.message, 'error'); }
    });
    $('.file-upload', win).addEventListener('click', () => {
      state.uploadTarget = async files => {
        const form = new FormData(); [...files].forEach(file => form.append('file', file));
        try { await api(`/api/files/upload?path=${encodeURIComponent(local.path)}`, {method:'POST', body: form}); toast('Upload complete', `${files.length} file${files.length === 1 ? '' : 's'} added.`); await load(local.path, false); }
        catch (error) { toast('Upload failed', error.message, 'error'); }
      };
      $('#upload-input').click();
    });

    async function renameSelected() {
      if (!local.selected) return toast('Select an item', 'Choose a file or folder first.', 'error');
      const oldName = local.selected.split('/').pop();
      const name = await showDialog({title:'Rename item', input:{value:oldName}, confirm:'Rename'});
      if (!name || name === oldName) return;
      try { await api('/api/files/rename', {method:'POST', body:{path:local.selected,name}}); toast('Renamed', `${oldName} is now ${name}.`); await load(local.path,false); }
      catch(error){ toast('Rename failed',error.message,'error'); }
    }
    async function deleteSelected() {
      if (!local.selected) return toast('Select an item', 'Choose a file or folder first.', 'error');
      const name = local.selected.split('/').pop();
      const answer = await showDialog({title:`Move ${name} to Trash?`, message:'The item will leave this folder and can be recovered from the hidden Trash directory.', confirm:'Move to Trash', danger:true});
      if (!answer) return;
      try { await api(`/api/file?path=${encodeURIComponent(local.selected)}`, {method:'DELETE'}); toast('Moved to Trash', `${name} was removed.`); await load(local.path,false); }
      catch(error){ toast('Delete failed',error.message,'error'); }
    }
    win._renameSelected = renameSelected; win._deleteSelected = deleteSelected;
    load('/');
  }

  async function openEditor(path) {
    const key = `editor:${path}`;
    const existing = state.windows.get(key); if (existing) return focusWindow(existing);
    openApp('editor', {key, path, title: path.split('/').pop()});
  }

  // Terminal app
  function terminalMarkup() {
    return `<div class="terminal-shell"><div class="terminal-bar"><div class="terminal-tab"><i></i><span>bash — login shell</span></div><span class="terminal-host">connecting…</span><div class="terminal-actions"><button class="terminal-clear" title="Clear">⌫</button><button class="terminal-reconnect" title="Reconnect">↻</button></div></div><div class="terminal-container"></div></div>`;
  }

  function mountTerminal(win) {
    const container = $('.terminal-container', win);
    if (!window.Terminal || !window.FitAddon) throw new Error('Terminal assets did not load');
    const terminal = new window.Terminal({
      cursorBlink: true, cursorStyle: 'bar', fontFamily: 'SFMono-Regular, Cascadia Code, Liberation Mono, monospace',
      fontSize: 12, lineHeight: 1.25, scrollback: 5000, allowTransparency: true,
      theme: {background:'#090e15', foreground:'#cbd5df', cursor:'#79e6c6', cursorAccent:'#090e15', selectionBackground:'#2a5f5b88', black:'#111820', red:'#f0787f', green:'#74d9af', yellow:'#e5c07b', blue:'#74a8e8', magenta:'#b28ade', cyan:'#67d2ce', white:'#dce3ea', brightBlack:'#536070', brightRed:'#ff8d93', brightGreen:'#8ce9c3', brightYellow:'#f0d08c', brightBlue:'#8bbaff', brightMagenta:'#c49bf4', brightCyan:'#83e8df', brightWhite:'#f5f7fa'}
    });
    const fit = new window.FitAddon.FitAddon(); terminal.loadAddon(fit); terminal.open(container);
    let socket = null; let reconnectTimer = null;
    const resize = () => { try { fit.fit(); if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type:'resize', rows:terminal.rows, cols:terminal.cols})); } catch (_) {} };
    const connect = () => {
      clearTimeout(reconnectTimer);
      if (socket) { try { socket.close(); } catch (_) {} }
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${location.host}/ws/terminal`); socket.binaryType = 'arraybuffer';
      $('.terminal-host', win).textContent = 'connecting…';
      socket.onopen = () => { $('.terminal-host', win).textContent = `${state.session.user}@${state.session.host}`; resize(); };
      socket.onmessage = event => {
        if (typeof event.data === 'string') {
          try { const data = JSON.parse(event.data); if (data.type === 'ready') $('.terminal-host', win).textContent = `${data.user}@${data.host}`; } catch (_) { terminal.write(event.data); }
        } else terminal.write(new Uint8Array(event.data));
      };
      socket.onclose = () => { $('.terminal-host', win).textContent = 'disconnected'; terminal.write('\r\n\x1b[38;5;245m[session disconnected — press ↻ to reconnect]\x1b[0m\r\n'); };
      socket.onerror = () => $('.terminal-host', win).textContent = 'connection error';
    };
    terminal.onData(data => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type:'input', data})); });
    const observer = new ResizeObserver(() => requestAnimationFrame(resize)); observer.observe(container);
    $('.terminal-clear', win).addEventListener('click', () => { terminal.clear(); terminal.focus(); });
    $('.terminal-reconnect', win).addEventListener('click', connect);
    win._onResize = resize; win._onFocus = () => setTimeout(() => terminal.focus(), 20);
    win._cleanup = () => { clearTimeout(reconnectTimer); observer.disconnect(); socket?.close(); terminal.dispose(); };
    connect(); setTimeout(() => { resize(); terminal.focus(); }, 100);
  }

  // Service manager
  function servicesMarkup() {
    return `<div class="services-shell">
      <div class="service-summary"><div class="summary-stat"><span class="summary-orb">●</span><div><strong class="service-running">—</strong><span>Running</span></div></div><div class="summary-stat"><span class="summary-orb">◇</span><div><strong class="service-stopped">—</strong><span>Inactive</span></div></div><div class="summary-stat"><span class="summary-orb">⚑</span><div><strong class="service-failed">—</strong><span>Failed</span></div></div></div>
      <div class="app-toolbar service-toolbar"><div class="search-field">${svg('search')}<input class="service-search" placeholder="Filter services"></div><button class="tool-button service-refresh">${svg('refresh')} Refresh</button></div>
      <div class="table-wrap services-table-wrap"><table class="data-table services-table"><thead><tr><th>Service</th><th class="optional">Description</th><th>State</th><th class="optional">Startup</th><th></th></tr></thead><tbody><tr><td colspan="5"><div class="app-empty"><div><div class="spinner"></div><p>Reading systemd units…</p></div></div></td></tr></tbody></table></div>
    </div>`;
  }

  function mountServices(win) {
    let all = [];
    const body = $('tbody', win);
    const render = () => {
      const query = $('.service-search', win).value.toLowerCase();
      const services = all.filter(service => `${service.unit} ${service.description}`.toLowerCase().includes(query));
      body.innerHTML = services.length ? services.map(service => `<tr data-unit="${attr(service.unit)}">
        <td class="primary-cell"><div class="service-name"><span class="state-dot ${esc(service.active)}"></span>${esc(service.unit.replace('.service',''))}</div></td>
        <td class="service-description optional" title="${esc(service.description)}">${esc(service.description)}</td>
        <td><span class="state-pill ${service.active === 'active' ? 'enabled' : ''}">${esc(service.sub)}</span></td>
        <td class="optional"><span class="state-pill ${service.enabled === 'enabled' ? 'enabled' : ''}">${esc(service.enabled)}</span></td>
        <td><div class="row-actions"><button class="row-action logs" title="View journal">Logs</button>${service.active === 'active' ? `<button class="row-action action" data-action="restart" ${service.protected?'disabled':''}>Restart</button><button class="row-action action" data-action="stop" ${service.protected?'disabled':''}>Stop</button>` : `<button class="row-action action" data-action="start" ${service.protected?'disabled':''}>Start</button>`}</div></td>
      </tr>`).join('') : `<tr><td colspan="5"><div class="app-empty"><div><strong>No matching services</strong><p>Try another search term.</p></div></div></td></tr>`;
    };
    const load = async () => {
      try {
        const data = await api('/api/services');
        if (!data.available) {
          body.innerHTML = `<tr><td colspan="5"><div class="app-empty"><div><strong>systemd is unavailable</strong><p>${esc(data.message || 'Run this app inside the supplied systemd container.')}</p></div></div></td></tr>`; return;
        }
        all = data.services;
        $('.service-running', win).textContent = all.filter(item => item.active === 'active').length;
        $('.service-stopped', win).textContent = all.filter(item => item.active !== 'active' && item.active !== 'failed').length;
        $('.service-failed', win).textContent = all.filter(item => item.active === 'failed').length;
        render();
      } catch (error) { body.innerHTML = `<tr><td colspan="5"><div class="app-empty"><div><strong>Could not read services</strong><p>${esc(error.message)}</p></div></div></td></tr>`; }
    };
    $('.service-search', win).addEventListener('input', render);
    $('.service-refresh', win).addEventListener('click', load);
    body.addEventListener('click', async event => {
      const row = event.target.closest('tr[data-unit]'); if (!row) return;
      const unit = unattr(row.dataset.unit);
      if (event.target.closest('.logs')) {
        const drawer = document.createElement('div'); drawer.className = 'log-drawer';
        drawer.innerHTML = `<div class="log-header"><strong>${esc(unit)} · journal</strong><button class="tool-button log-close">${svg('close')} Close</button></div><pre class="log-content">Loading journal…</pre>`;
        $('.window-content', win).append(drawer); $('.log-close', drawer).addEventListener('click', () => drawer.remove());
        try { const data = await api(`/api/services/${encodeURIComponent(unit)}/logs`); $('.log-content', drawer).textContent = data.logs || 'No journal entries.'; }
        catch(error){ $('.log-content', drawer).textContent = error.message; }
      }
      const actionButton = event.target.closest('.action');
      if (actionButton) {
        const action = actionButton.dataset.action;
        actionButton.disabled = true; actionButton.textContent = 'Working…';
        try { await api(`/api/services/${encodeURIComponent(unit)}/${action}`, {method:'POST',body:{}}); toast('Service updated', `${unit} · ${action}`); await sleep(400); await load(); }
        catch(error){ toast('Service action failed',error.message,'error'); actionButton.disabled=false; actionButton.textContent=action[0].toUpperCase()+action.slice(1); }
      }
    });
    load();
  }

  // System monitor
  function systemMarkup() {
    return `<div class="system-shell">
      <div class="system-overview">
        <div class="metric-card"><div class="metric-head"><span>CPU load</span><strong class="cpu-value">—%</strong></div><div class="metric-sub"><span class="cpu-detail">Detecting processors</span><span class="load-detail">load —</span></div><svg class="chart cpu-chart" viewBox="0 0 300 62" preserveAspectRatio="none"><polygon class="area" points="0,62 300,62"/><polyline points="0,62 300,62"/></svg></div>
        <div class="metric-card"><div class="metric-head"><span>Memory</span></div><div class="ring-metric"><div class="metric-ring memory-ring"><span>—%</span></div><div class="ring-copy"><strong class="memory-used">—</strong><span class="memory-total">of —</span></div></div></div>
        <div class="metric-card"><div class="metric-head"><span>Storage</span></div><div class="ring-metric"><div class="metric-ring disk-ring"><span>—%</span></div><div class="ring-copy"><strong class="disk-used">—</strong><span class="disk-total">of —</span></div></div></div>
      </div>
      <div class="host-strip"><div class="host-mark">L</div><div class="host-info"><strong class="host-name">Loading host…</strong><span class="host-detail">—</span></div><div class="host-badges"><span class="host-badge container-badge">container</span><span class="host-badge uptime-badge">uptime —</span></div></div>
      <section class="process-section"><div class="section-heading"><strong>Processes</strong><div class="search-field">${svg('search')}<input class="process-search" placeholder="Filter processes"></div></div><div class="table-wrap process-table-wrap"><table class="data-table process-table"><thead><tr><th>Process</th><th>PID</th><th class="optional">User</th><th class="numeric">CPU</th><th class="numeric">Memory</th><th></th></tr></thead><tbody><tr><td colspan="6"><div class="app-empty"><div><div class="spinner"></div><p>Sampling processes…</p></div></div></td></tr></tbody></table></div></section>
    </div>`;
  }

  function mountSystem(win) {
    let history = Array(36).fill(0), processes = [], stopped = false;
    const renderChart = () => {
      const points = history.map((value,index) => `${index * (300/(history.length-1))},${62 - Math.min(100,value)*.6}`).join(' ');
      $('.cpu-chart polyline',win).setAttribute('points',points);
      $('.cpu-chart .area',win).setAttribute('points',`0,62 ${points} 300,62`);
    };
    const updateMetrics = system => {
      history.push(system.cpu.percent); history.shift(); renderChart();
      $('.cpu-value',win).textContent=`${Math.round(system.cpu.percent)}%`;
      $('.cpu-detail',win).textContent=`${system.cpu.count} logical CPUs${system.cpu.frequency ? ` · ${system.cpu.frequency} MHz` : ''}`;
      $('.load-detail',win).textContent=`load ${system.cpu.load[0].toFixed(2)}`;
      const setRing=(name,data)=>{const ring=$(`.${name}-ring`,win);ring.style.setProperty('--value',data.percent);$('span',ring).textContent=`${Math.round(data.percent)}%`; $(`.${name}-used`,win).textContent=formatBytes(data.used);$(`.${name}-total`,win).textContent=`of ${formatBytes(data.total)}`;};
      setRing('memory',system.memory);setRing('disk',system.disk);
      $('.host-name',win).textContent=system.hostname;
      $('.host-detail',win).textContent=`${system.os} · ${system.kernel} · ${system.architecture}`;
      $('.container-badge',win).textContent=system.container?'Docker container':'Linux host';
      $('.uptime-badge',win).textContent=`uptime ${formatUptime(system.uptime)}`;
    };
    const renderProcesses=()=>{
      const query=$('.process-search',win).value.toLowerCase();
      const rows=processes.filter(p=>`${p.name} ${p.user} ${p.pid}`.toLowerCase().includes(query));
      $('tbody',win).innerHTML=rows.map(p=>`<tr data-pid="${p.pid}"><td class="primary-cell"><div class="process-name"><span class="state-dot ${p.status==='running'?'active':''}"></span>${esc(p.name)}</div></td><td>${p.pid}</td><td class="optional">${esc(p.user)}</td><td class="numeric">${p.cpu.toFixed(1)}%</td><td class="numeric">${p.memory.toFixed(1)}%</td><td><button class="kill-button" ${p.controllable?'':'disabled'} title="End process">End</button></td></tr>`).join('')||`<tr><td colspan="6"><div class="app-empty"><div><strong>No matching processes</strong></div></div></td></tr>`;
    };
    const loadSystem=async()=>{try{const data=await api('/api/system');if(!stopped)updateMetrics(data.system);}catch(_){}};
    const loadProcesses=async()=>{try{const data=await api('/api/processes');if(!stopped){processes=data.processes;renderProcesses();}}catch(error){if(!stopped)$('tbody',win).innerHTML=`<tr><td colspan="6"><div class="app-empty"><div><strong>Process list unavailable</strong><p>${esc(error.message)}</p></div></div></td></tr>`;}};
    $('.process-search',win).addEventListener('input',renderProcesses);
    $('tbody',win).addEventListener('click',async event=>{const button=event.target.closest('.kill-button');if(!button)return;const pid=+button.closest('tr').dataset.pid;const process=processes.find(p=>p.pid===pid);const answer=await showDialog({title:`End ${process?.name||pid}?`,message:'A SIGTERM signal will ask this process to exit cleanly.',confirm:'End process',danger:true});if(!answer)return;try{await api(`/api/processes/${pid}/signal`,{method:'POST',body:{signal:'TERM'}});toast('Signal sent',`Process ${pid} was asked to stop.`);setTimeout(loadProcesses,500);}catch(error){toast('Could not end process',error.message,'error');}});
    loadSystem();loadProcesses();const systemTimer=setInterval(loadSystem,2200),processTimer=setInterval(loadProcesses,5500);
    win._cleanup=()=>{stopped=true;clearInterval(systemTimer);clearInterval(processTimer);};
  }

  // Editor, welcome, settings
  function editorMarkup(options) {
    return `<div class="file-editor"><div class="editor-toolbar"><span class="editor-path">${esc(options.path)}</span><button class="tool-button editor-download">${svg('download')} Download</button><button class="tool-button primary editor-save">${svg('save')} Save</button></div><div class="app-empty editor-loading"><div><div class="spinner"></div><p>Opening file…</p></div></div></div>`;
  }

  async function mountEditor(win, options) {
    const shell=$('.file-editor',win), data=await api(`/api/file?path=${encodeURIComponent(options.path)}`);
    if(data.binary){
      $('.editor-save',win).remove();
      const image=data.mime.startsWith('image/');
      $('.editor-loading',win).outerHTML=`<div class="binary-preview">${image?`<img src="/api/file/raw?path=${encodeURIComponent(options.path)}" alt="${esc(data.name)}">`:''}<div><strong>${esc(data.name)}</strong><p>${esc(data.mime)} · ${formatBytes(data.size)}</p><button class="tool-button primary editor-download-inner">${svg('download')} Download file</button></div></div>`;
      $('.editor-download-inner',win)?.addEventListener('click',()=>downloadPath(options.path));
    }else{
      $('.editor-loading',win).outerHTML=`<textarea class="editor-area" spellcheck="false" aria-label="File content"></textarea>`;
      const area=$('.editor-area',win);area.value=data.content;area.focus();
      area.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();$('.editor-save',win).click();}if(event.key==='Tab'){event.preventDefault();const s=area.selectionStart;area.setRangeText('  ',s,area.selectionEnd,'end');}});
      $('.editor-save',win).addEventListener('click',async()=>{const button=$('.editor-save',win);button.disabled=true;try{await api('/api/file',{method:'PUT',body:{path:options.path,content:area.value}});toast('Saved',`${data.name} was written to disk.`);}catch(error){toast('Save failed',error.message,'error');}finally{button.disabled=false;}});
    }
    $('.editor-download',win).addEventListener('click',()=>downloadPath(options.path));
  }

  function downloadPath(path){const link=document.createElement('a');link.href=`/api/file/raw?path=${encodeURIComponent(path)}&download=1`;link.download=path.split('/').pop();document.body.append(link);link.click();link.remove();}

  function welcomeMarkup(){
    const compatibility = state.session?.runtime && state.session.runtime !== 'systemd';
    const intro = compatibility
      ? 'Terminal, files, processes, and live metrics are connected to this Linux container. The host does not provide privileged systemd access.'
      : 'Files, shells, processes, and systemd units are connected to the Linux system behind this desktop—not browser mockups.';
    const serviceCopy = compatibility
      ? 'This host runs compatibility mode, so systemd unit control and journals are intentionally disabled.'
      : 'Inspect unit state, read journals, and control non-core services through PID 1.';
    return `<div class="welcome-shell"><section class="welcome-hero"><div class="welcome-copy"><span class="welcome-kicker"><i class="live-dot"></i> Linux is ready</span><h2>Welcome to your<br>real container workspace.</h2><p>${intro}</p><div class="welcome-actions"><button class="tool-button primary welcome-terminal">Open Terminal</button><button class="tool-button welcome-files">Browse files</button></div></div></section><div class="feature-grid"><article class="feature-card" data-app="terminal"><span class="feature-icon">$_</span><strong>PTY terminal</strong><p>A true login shell with color, history, interactive commands, and persistent home storage.</p></article><article class="feature-card" data-app="services"><span class="feature-icon">◉</span><strong>${compatibility ? 'Compatibility mode' : 'systemd services'}</strong><p>${serviceCopy}</p></article><article class="feature-card" data-app="system"><span class="feature-icon">⌁</span><strong>Live system data</strong><p>Watch actual CPU, memory, disk, and process activity from the container.</p></article></div><div class="shortcut-strip"><strong>Shortcuts</strong><span><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>T</kbd> Terminal</span><span><kbd>Ctrl</kbd> + <kbd>Space</kbd> Apps</span><span><kbd>Alt</kbd> + <kbd>F4</kbd> Close</span></div></div>`;
  }
  function mountWelcome(win){$('.welcome-terminal',win).addEventListener('click',()=>openApp('terminal'));$('.welcome-files',win).addEventListener('click',()=>openApp('files'));$$('.feature-card',win).forEach(card=>card.addEventListener('click',()=>openApp(card.dataset.app)));}

  function settingsMarkup(){return `<div class="settings-shell"><aside class="settings-nav"><div class="settings-profile"><div class="avatar">W</div><div><strong>${esc(state.session.user)}</strong><span>${esc(state.session.host)}</span></div></div><button class="active">◐ Appearance</button><button>⌨ Workspace</button><button>◎ About</button></aside><section class="settings-content"><h2>Appearance</h2><p>Personalize this browser. Preferences are stored locally on this device.</p><div class="setting-group"><div class="setting-row"><div><strong>Accent color</strong><small>Used for controls, indicators, and charts</small></div><div class="accent-choices"><button class="accent-choice" style="--choice:#72e6c1" data-color="#72e6c1" data-rgb="114,230,193"></button><button class="accent-choice" style="--choice:#77a8ff" data-color="#77a8ff" data-rgb="119,168,255"></button><button class="accent-choice" style="--choice:#b491ff" data-color="#b491ff" data-rgb="180,145,255"></button><button class="accent-choice" style="--choice:#ff9b7b" data-color="#ff9b7b" data-rgb="255,155,123"></button></div></div><div class="setting-row"><div><strong>Wallpaper mood</strong><small>Adjust the desktop atmosphere</small></div><div class="wallpaper-choices"><button class="wallpaper-choice" data-paper="aurora" style="--paper:linear-gradient(145deg,#183d43,#26325a,#121721)"></button><button class="wallpaper-choice" data-paper="ocean" style="--paper:linear-gradient(145deg,#123f53,#0a1b32)"></button><button class="wallpaper-choice" data-paper="ember" style="--paper:linear-gradient(145deg,#4c2434,#21162f)"></button></div></div><div class="setting-row"><div><strong>Reduce motion</strong><small>Minimize interface animation and transitions</small></div><button class="switch motion-switch" aria-label="Reduce motion"></button></div></div><h2 style="margin-top:25px">About this system</h2><div class="setting-group"><div class="setting-row"><div class="about-logo"><div class="brand-symbol"><span></span><span></span><span></span></div><div><strong>LumaDesk OS 1.0.1</strong><small>${state.session?.runtime === 'systemd' ? 'Docker web workspace · systemd edition' : 'Docker web workspace · compatibility edition'}</small></div></div></div><div class="setting-row"><div><strong>Security model</strong><small>Authenticated session · CSRF protection · workspace-scoped files</small></div><span class="state-pill enabled">Protected</span></div><div class="setting-row"><div><strong>Session</strong><small>Sign out and close all open application windows</small></div><button class="tool-button settings-logout">Sign out</button></div></div></section></div>`;}

  function applyPreferences(){
    const color=localStorage.getItem('lumadesk.accent')||'#72e6c1',rgb=localStorage.getItem('lumadesk.accentRgb')||'114,230,193';document.documentElement.style.setProperty('--accent',color);document.documentElement.style.setProperty('--accent-rgb',rgb);
    document.body.classList.toggle('reduce-motion',localStorage.getItem('lumadesk.reduceMotion')==='1');
    const paper=localStorage.getItem('lumadesk.wallpaper')||'aurora',wall=$('.wallpaper');if(wall){wall.dataset.paper=paper;wall.style.background=paper==='ocean'?'radial-gradient(ellipse at 50% 70%,#14475c 0%,#0b2238 38%,#070b13 78%)':paper==='ember'?'radial-gradient(ellipse at 55% 70%,#4a2638 0%,#23162d 40%,#090a12 78%)':'';}
  }
  function mountSettings(win){
    const color=localStorage.getItem('lumadesk.accent')||'#72e6c1';$$('.accent-choice',win).forEach(button=>{button.classList.toggle('active',button.dataset.color===color);button.addEventListener('click',()=>{localStorage.setItem('lumadesk.accent',button.dataset.color);localStorage.setItem('lumadesk.accentRgb',button.dataset.rgb);applyPreferences();$$('.accent-choice',win).forEach(b=>b.classList.toggle('active',b===button));});});
    const paper=localStorage.getItem('lumadesk.wallpaper')||'aurora';$$('.wallpaper-choice',win).forEach(button=>{button.classList.toggle('active',button.dataset.paper===paper);button.addEventListener('click',()=>{localStorage.setItem('lumadesk.wallpaper',button.dataset.paper);applyPreferences();$$('.wallpaper-choice',win).forEach(b=>b.classList.toggle('active',b===button));});});
    const toggle=$('.motion-switch',win);toggle.classList.toggle('on',document.body.classList.contains('reduce-motion'));toggle.addEventListener('click',()=>{const on=localStorage.getItem('lumadesk.reduceMotion')!=='1';localStorage.setItem('lumadesk.reduceMotion',on?'1':'0');applyPreferences();toggle.classList.toggle('on',on);});
    $('.settings-logout',win).addEventListener('click',signOut);
  }

  const apps = {
    welcome: {title:'Welcome',icon:'welcome',width:790,height:570,render:welcomeMarkup,mount:mountWelcome},
    files: {title:'Files',icon:'files',width:890,height:570,render:filesMarkup,mount:mountFiles},
    terminal: {title:'Terminal',icon:'terminal',width:820,height:510,render:terminalMarkup,mount:mountTerminal},
    services: {title:'Services',icon:'services',width:960,height:590,render:servicesMarkup,mount:mountServices},
    system: {title:'System Monitor',icon:'system',width:900,height:610,render:systemMarkup,mount:mountSystem},
    settings: {title:'Settings',icon:'settings',width:720,height:520,render:settingsMarkup,mount:mountSettings},
    editor: {title:'Editor',icon:'editor',width:760,height:540,singleton:false,render:editorMarkup,mount:mountEditor}
  };

  function populateLauncher(){
    const order=['files','terminal','services','system','settings','welcome'];
    $('#launcher-grid').innerHTML=order.map(id=>`<button class="launcher-app" data-app="${id}" data-search="${apps[id].title.toLowerCase()}">${icon(apps[id].icon)}<span>${esc(apps[id].title)}</span></button>`).join('');
    $$('.launcher-app').forEach(button=>button.addEventListener('click',()=>openApp(button.dataset.app)));
  }

  function bindShell(){
    populateLauncher();applyPreferences();
    $$('.desktop-icon[data-app], .dock-button[data-app]').forEach(button=>button.addEventListener('click',()=>{
      const id=button.dataset.app, existing=[...state.windows.values()].find(win=>win.dataset.app===id);
      if(existing && existing===state.activeWindow && !existing.classList.contains('minimized')) existing.classList.add('minimized'); else if(existing) focusWindow(existing); else openApp(id);updateDock();
    }));
    $('[data-command="launcher"]').addEventListener('click',()=>{const panel=$('#launcher'),willOpen=panel.classList.contains('hidden');hidePanels(willOpen?'launcher':null);panel.classList.toggle('hidden',!willOpen);if(willOpen)setTimeout(()=>$('#launcher-search').focus(),20);});
    $('#system-menu-button').addEventListener('click',()=>{const panel=$('#system-menu'),open=panel.classList.contains('hidden');hidePanels(open?'system-menu':null);panel.classList.toggle('hidden',!open);});
    $('#quick-status').addEventListener('click',()=>{const panel=$('#quick-panel'),open=panel.classList.contains('hidden');hidePanels(open?'quick-panel':null);panel.classList.toggle('hidden',!open);if(open)quickStatus();});
    $('#launcher-search').addEventListener('input',event=>{const q=event.target.value.toLowerCase();$$('.launcher-app').forEach(button=>button.classList.toggle('no-match',!button.dataset.search.includes(q)));});
    $('#launcher-logout').addEventListener('click',signOut);$('#menu-logout').addEventListener('click',signOut);$('#menu-lock').addEventListener('click',()=>lockDesktop(false));
    $('.menu-actions [data-app]').addEventListener('click',event=>openApp(event.currentTarget.dataset.app));
    $('#focus-toggle').addEventListener('click',event=>{const on=$('#desktop').classList.toggle('focus-mode');event.currentTarget.classList.toggle('active',on);$('small',event.currentTarget).textContent=on?'On':'Off';});
    $('#upload-input').addEventListener('change',event=>{if(event.target.files.length&&state.uploadTarget)state.uploadTarget(event.target.files);event.target.value='';state.uploadTarget=null;});
    document.addEventListener('pointerdown',event=>{if(!event.target.closest('.panel,.topbar-brand,.status-button,.launcher-button'))hidePanels();});
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'){hidePanels();return;}
      if(event.altKey&&event.key==='F4'){event.preventDefault();if(state.activeWindow)closeWindow(state.activeWindow);}
      if(event.ctrlKey&&event.altKey&&event.key.toLowerCase()==='t'){event.preventDefault();openApp('terminal');}
      if(event.ctrlKey&&!event.altKey&&event.code==='Space'){event.preventDefault();$('[data-command="launcher"]').click();}
    });
  }

  function bindLogin(){
    $('#toggle-password').addEventListener('click',event=>{const input=$('#password'),show=input.type==='password';input.type=show?'text':'password';event.currentTarget.textContent=show?'Hide':'Show';input.focus();});
    $('#login-form').addEventListener('submit',async event=>{
      event.preventDefault();const button=$('.login-button'),password=$('#password').value;button.disabled=true;$('.login-button span').textContent='Opening…';$('#login-error').textContent='';
      try{const result=await api('/api/login',{method:'POST',body:{password}});const info=await api('/api/session');state.session={...info,csrf:result.csrf};updateSessionLabels();$('#password').value='';await showDesktop();}
      catch(error){$('#login-error').textContent=error.message;$('#password').select();}
      finally{button.disabled=false;$('.login-button span').textContent='Open workspace';}
    });
  }

  window.addEventListener('resize',()=>{state.windows.forEach(win=>{if(!win.classList.contains('maximized')&&!matchMedia('(max-width:720px)').matches){const maxLeft=Math.max(0,$('#window-layer').clientWidth-110),maxTop=Math.max(0,$('#window-layer').clientHeight-45);win.style.left=`${Math.min(parseFloat(win.style.left)||0,maxLeft)}px`;win.style.top=`${Math.min(parseFloat(win.style.top)||0,maxTop)}px`;}win._onResize?.();});});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)quickStatus();});

  async function init(){bindLogin();bindShell();await Promise.all([sleep(700),checkSession()]);$('#boot').classList.add('done');setTimeout(()=>$('#boot').remove(),500);}
  init();
})();
