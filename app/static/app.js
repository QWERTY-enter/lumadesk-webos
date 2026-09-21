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
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>',
    restore: '<svg viewBox="0 0 24 24"><path d="M4 13a8 8 0 1 0 2.3-5.7M4 5v6h6"/></svg>',
    eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.7-6.2 10-6.2S22 12 22 12s-3.7 6.2-10 6.2S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>',
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
    lastSystem: null,
    shortcuts: []
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

  function closeContextMenu() {
    const menu = $('.context-menu');
    if (menu) menu.remove();
  }

  function showContextMenu(x, y, items) {
    closeContextMenu();
    const visible = items.filter(Boolean);
    if (!visible.length) return;
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = visible.map(item => item.separator
      ? '<span class="menu-sep"></span>'
      : `<button class="menu-item${item.danger ? ' danger' : ''}" data-id="${attr(item.id)}">${item.icon ? svg(item.icon) : ''}<span>${esc(item.label)}</span>${item.hint ? `<kbd>${esc(item.hint)}</kbd>` : ''}</button>`).join('');
    $('#desktop').append(menu);
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(6, Math.min(x, innerWidth - box.width - 8))}px`;
    menu.style.top = `${Math.max(6, Math.min(y, innerHeight - box.height - 8))}px`;
    menu.addEventListener('click', event => {
      const button = event.target.closest('.menu-item');
      if (!button) return;
      const item = visible.find(candidate => candidate.id === button.dataset.id);
      closeContextMenu();
      item?.action?.();
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
    refreshStoreShortcuts();
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
  const TRASH_PATH = '@trash';

  function filesMarkup() {
    return `<div class="files-shell">
      <aside class="files-sidebar">
        <div class="sidebar-label">Places</div>
        <button class="place-button active" data-path="/"><span class="place-icon">⌂</span>Home</button>
        <button class="place-button" data-path="/Desktop"><span class="place-icon">▣</span>Desktop</button>
        <button class="place-button" data-path="/Documents"><span class="place-icon">▤</span>Documents</button>
        <button class="place-button" data-path="/Downloads"><span class="place-icon">⇣</span>Downloads</button>
        <button class="place-button" data-path="/Projects"><span class="place-icon">◈</span>Projects</button>
        <div class="sidebar-label">System</div>
        <button class="place-button" data-path="${TRASH_PATH}"><span class="place-icon">⌫</span>Trash</button>
        <div class="sidebar-label">Storage</div>
        <div class="files-storage"><div class="storage-track"><i class="storage-bar"></i></div><span class="storage-text">Measuring…</span></div>
      </aside>
      <section class="files-main">
        <div class="app-toolbar files-toolbar">
          <div class="nav-group"><button class="tool-button icon-tool file-back" title="Back">${svg('back')}</button><button class="tool-button icon-tool file-up" title="Parent">${svg('up')}</button><button class="tool-button icon-tool file-refresh" title="Refresh">${svg('refresh')}</button></div>
          <div class="breadcrumb"></div>
          <div class="search-field files-search">${svg('search')}<input class="file-search" placeholder="Search workspace" autocomplete="off"><button class="tool-button icon-tool file-search-clear hidden" title="Clear search">${svg('close')}</button></div>
          <button class="tool-button icon-tool file-hidden" title="Toggle hidden files">${svg('eye')}</button>
          <button class="tool-button file-new">${svg('plus')} New</button>
          <button class="tool-button file-upload">${svg('upload')} Upload</button>
          <button class="tool-button danger file-empty hidden">${svg('trash')} Empty Trash</button>
        </div>
        <div class="files-grid"><div class="app-empty"><div><div class="spinner"></div><p>Opening workspace…</p></div></div></div>
        <div class="files-status"><span class="file-count">—</span><span class="files-context">Home volume</span></div>
      </section>
    </div>`;
  }

  function mountFiles(win) {
    const local = {
      path: '/', history: [], index: -1, entries: [], trash: [], results: [], selected: null,
      query: '', searchTimer: null,
      showHidden: localStorage.getItem('lumadesk.showHidden') === '1'
    };
    win._fileState = local;
    const grid = $('.files-grid', win);
    const main = $('.files-main', win);
    const inTrash = () => local.path === TRASH_PATH;
    const inSearch = () => local.query.trim().length >= 2;

    const renderBreadcrumb = () => {
      if (inTrash()) { $('.breadcrumb', win).innerHTML = `<span data-path="${TRASH_PATH}">Trash</span>`; return; }
      const parts = local.path.split('/').filter(Boolean);
      let current = '';
      $('.breadcrumb', win).innerHTML = `<span data-path="/">Home</span>` + parts.map(part => {
        current += `/${part}`;
        return `<i>›</i><span data-path="${attr(current)}">${esc(part)}</span>`;
      }).join('');
    };

    const setStatus = (count, context) => {
      $('.file-count', win).textContent = count;
      $('.files-context', win).textContent = context;
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
      const hidden = local.entries.filter(item => item.hidden).length;
      setStatus(`${local.entries.length} item${local.entries.length === 1 ? '' : 's'}`, hidden ? `Home volume · ${hidden} hidden shown` : 'Home volume');
    };

    const renderTrash = () => {
      if (!local.trash.length) {
        grid.innerHTML = `<div class="app-empty" style="grid-column:1/-1"><div><strong>Trash is empty</strong><p>Items you move to Trash wait here for 30 days before the maintenance timer purges them.</p></div></div>`;
      } else {
        grid.innerHTML = `<div class="trash-view">${local.trash.map(item => {
          const folder = item.type === 'directory';
          const extension = folder ? '' : (item.label.split('.').pop() || 'file').slice(0, 5);
          return `<div class="trash-row" data-name="${attr(item.name)}">
            <span class="file-glyph ${folder ? 'folder' : ''}" data-ext="${esc(extension)}"></span>
            <div class="trash-meta"><strong>${esc(item.label)}</strong><span>${item.original ? `from ${esc(item.original)} · ` : ''}deleted ${esc(timeAgo(item.deleted))} · ${formatBytes(item.size)}</span></div>
            <div class="trash-actions"><button class="row-action restore">Restore</button><button class="row-action purge">Delete</button></div>
          </div>`;
        }).join('')}</div>`;
      }
      const total = local.trash.reduce((sum, item) => sum + (item.size || 0), 0);
      setStatus(`${local.trash.length} item${local.trash.length === 1 ? '' : 's'}`, local.trash.length ? `${formatBytes(total)} awaiting restore` : 'Nothing to restore');
    };

    const renderSearch = () => {
      if (!local.results.length) {
        grid.innerHTML = `<div class="app-empty" style="grid-column:1/-1"><div><strong>No matches</strong><p>Nothing in this folder tree is named like “${esc(local.query.trim())}”.</p></div></div>`;
      } else {
        grid.innerHTML = `<div class="search-view">${local.results.map(item => {
          const folder = item.type === 'directory';
          const extension = folder ? '' : (item.name.split('.').pop() || 'file').slice(0, 5);
          return `<div class="search-row" data-path="${attr(item.path)}" data-type="${item.type}">
            <span class="file-glyph ${folder ? 'folder' : ''}" data-ext="${esc(extension)}"></span>
            <div class="trash-meta"><strong>${esc(item.name)}</strong><span>${esc(item.folder === '/' ? 'Workspace root' : item.folder)} · ${folder ? 'folder' : formatBytes(item.size)} · ${esc(timeAgo(item.modified))}</span></div>
            <div class="trash-actions"><button class="row-action open">Open</button><button class="row-action trash">Trash</button></div>
          </div>`;
        }).join('')}</div>`;
      }
      setStatus(`${local.results.length} match${local.results.length === 1 ? '' : 'es'}`, local.truncated ? 'More results exist; refine the search' : `Searching ${local.searchRoot}`);
    };

    const syncToolbar = () => {
      const busy = inTrash() || inSearch();
      $('.file-new', win).classList.toggle('hidden', busy);
      $('.file-upload', win).classList.toggle('hidden', busy);
      $('.file-hidden', win).classList.toggle('hidden', inTrash());
      $('.file-hidden', win).classList.toggle('primary', local.showHidden);
      $('.file-empty', win).classList.toggle('hidden', !inTrash());
      $('.file-search-clear', win).classList.toggle('hidden', !local.query);
      $('.file-back', win).disabled = busy || local.index <= 0;
      $('.file-up', win).disabled = busy;
      $$('.place-button', win).forEach(button => button.classList.toggle('active', !inSearch() && button.dataset.path === local.path));
    };

    const loadTrash = async () => {
      local.path = TRASH_PATH;
      local.selected = null;
      grid.innerHTML = `<div class="app-empty" style="grid-column:1/-1"><div><div class="spinner"></div><p>Reading Trash…</p></div></div>`;
      syncToolbar();
      const data = await api('/api/trash');
      local.trash = data.entries;
      local.entries = [];
      renderBreadcrumb(); renderTrash(); syncToolbar();
    };

    const loadSearch = async () => {
      const query = local.query.trim();
      if (query.length < 2) return;
      grid.innerHTML = `<div class="app-empty" style="grid-column:1/-1"><div><div class="spinner"></div><p>Searching…</p></div></div>`;
      syncToolbar();
      const extra = local.showHidden ? '&hidden=1' : '';
      const data = await api(`/api/files/search?q=${encodeURIComponent(query)}&path=${encodeURIComponent(local.path === TRASH_PATH ? '/' : local.path)}${extra}`);
      local.results = data.matches;
      local.truncated = data.truncated;
      local.searchRoot = data.root;
      local.entries = [];
      renderSearch(); syncToolbar();
    };
    local.loadSearch = loadSearch;

    const clearSearch = () => {
      clearTimeout(local.searchTimer);
      local.query = ''; local.results = [];
      $('.file-search', win).value = '';
      load(local.path, false);
    };

    const scheduleSearch = () => {
      clearTimeout(local.searchTimer);
      local.searchTimer = setTimeout(() => {
        local.query = $('.file-search', win).value;
        if (local.query.trim().length >= 2) loadSearch();
        else { local.results = []; load(local.path, false); }
        syncToolbar();
      }, 220);
    };

    const openResult = row => {
      const path = unattr(row.dataset.path);
      if (row.dataset.type === 'directory') { clearSearch(); load(path); } else openEditor(path);
    };

    const load = async (path = local.path, addHistory = true) => {
      if (path === TRASH_PATH) return loadTrash();
      grid.innerHTML = `<div class="app-empty" style="grid-column:1/-1"><div><div class="spinner"></div><p>Loading…</p></div></div>`;
      const extra = local.showHidden ? '&hidden=1' : '';
      const data = await api(`/api/files?path=${encodeURIComponent(path)}${extra}`);
      local.path = data.path; local.entries = data.entries; local.selected = null;
      if (addHistory && local.history[local.index] !== local.path) {
        local.history = local.history.slice(0, local.index + 1); local.history.push(local.path); local.index++;
      }
      renderBreadcrumb(); renderEntries(); syncToolbar();
    };
    local.load = load;

    const selectEntry = element => {
      $$('.file-entry', grid).forEach(node => node.classList.remove('selected'));
      if (element) { element.classList.add('selected'); local.selected = unattr(element.dataset.path); }
      else local.selected = null;
    };

    const openPath = path => {
      const entry = local.entries.find(item => item.path === path);
      if (entry && entry.type === 'directory') load(path); else openEditor(path);
    };

    async function createEntry({title, message, placeholder, confirm, kind = null}) {
      const raw = await showDialog({title, message, input: {placeholder}, confirm});
      if (!raw) return;
      const folder = kind === 'directory' || (kind === null && raw.endsWith('/'));
      const name = kind === null && folder ? raw.slice(0, -1) : raw;
      try {
        await api('/api/files/create', {method: 'POST', body: {parent: local.path, name, type: folder ? 'directory' : 'file'}});
        toast('Created', `${name} was added to this folder.`);
        await load(local.path, false);
      } catch (error) { toast('Could not create item', error.message, 'error'); }
    }

    async function uploadFiles(files) {
      const list = [...files];
      if (!list.length) return;
      const form = new FormData();
      list.forEach(file => form.append('file', file));
      try {
        const result = await api(`/api/files/upload?path=${encodeURIComponent(local.path)}`, {method: 'POST', body: form});
        toast('Upload complete', `${result.files.length} file${result.files.length === 1 ? '' : 's'} added to ${local.path}.`);
        await load(local.path, false);
      } catch (error) { toast('Upload failed', error.message, 'error'); }
    }

    const pickUpload = () => { state.uploadTarget = files => uploadFiles(files); $('#upload-input').click(); };

    const toggleHidden = async () => {
      local.showHidden = !local.showHidden;
      localStorage.setItem('lumadesk.showHidden', local.showHidden ? '1' : '0');
      await load(local.path, false);
    };

    async function renameSelected() {
      if (!local.selected) return toast('Select an item', 'Choose a file or folder first.', 'error');
      const oldName = local.selected.split('/').pop();
      const name = await showDialog({title: 'Rename item', input: {value: oldName}, confirm: 'Rename'});
      if (!name || name === oldName) return;
      try { await api('/api/files/rename', {method: 'POST', body: {path: local.selected, name}}); toast('Renamed', `${oldName} is now ${name}.`); await load(local.path, false); }
      catch (error) { toast('Rename failed', error.message, 'error'); }
    }

    async function deleteSelected() {
      if (!local.selected) return toast('Select an item', 'Choose a file or folder first.', 'error');
      const name = local.selected.split('/').pop();
      const answer = await showDialog({title: `Move ${name} to Trash?`, message: 'The item leaves this folder and stays restorable from the Trash view.', confirm: 'Move to Trash', danger: true});
      if (!answer) return;
      try {
        await api(`/api/file?path=${encodeURIComponent(local.selected)}`, {method: 'DELETE'});
        toast('Moved to Trash', `${name} can be restored from Trash.`);
        local.selected = null;
        if (inSearch()) await loadSearch(); else await load(local.path, false);
      }
      catch (error) { toast('Delete failed', error.message, 'error'); }
    }

    async function restoreEntry(name) {
      try {
        const result = await api('/api/trash/restore', {method: 'POST', body: {name}});
        toast('Restored', `${result.name} returned to ${result.path}.`);
        await loadTrash();
      } catch (error) { toast('Restore failed', error.message, 'error'); }
    }

    async function purgeEntry(name) {
      const answer = await showDialog({title: 'Delete permanently?', message: 'This removes the item from the Trash and cannot be undone.', confirm: 'Delete forever', danger: true});
      if (!answer) return;
      try { await api('/api/trash/purge', {method: 'POST', body: {name}}); toast('Deleted', 'The item was removed permanently.'); await loadTrash(); }
      catch (error) { toast('Delete failed', error.message, 'error'); }
    }

    async function emptyTrash() {
      const answer = await showDialog({title: 'Empty the Trash?', message: `${local.trash.length} item${local.trash.length === 1 ? '' : 's'} will be removed permanently.`, confirm: 'Empty Trash', danger: true});
      if (!answer) return;
      try {
        const result = await api('/api/trash/empty', {method: 'POST', body: {}});
        toast('Trash emptied', `${result.removed} item${result.removed === 1 ? '' : 's'} removed.`);
        await loadTrash();
      } catch (error) { toast('Could not empty Trash', error.message, 'error'); }
    }

    win._renameSelected = renameSelected; win._deleteSelected = deleteSelected;

    grid.addEventListener('click', event => {
      if (inSearch()) {
        const row = event.target.closest('.search-row');
        if (!row) return;
        const path = unattr(row.dataset.path);
        if (event.target.closest('.trash')) { local.selected = path; return deleteSelected(); }
        if (event.target.closest('.open')) return openResult(row);
        return;
      }
      if (inTrash()) {
        const row = event.target.closest('.trash-row');
        if (!row) return;
        const name = unattr(row.dataset.name);
        if (event.target.closest('.restore')) return restoreEntry(name);
        if (event.target.closest('.purge')) return purgeEntry(name);
        return;
      }
      selectEntry(event.target.closest('.file-entry'));
    });
    grid.addEventListener('dblclick', event => {
      if (inSearch()) { const row = event.target.closest('.search-row'); if (row) openResult(row); return; }
      if (inTrash()) return;
      const entry = event.target.closest('.file-entry');
      if (entry) openPath(unattr(entry.dataset.path));
    });
    grid.addEventListener('contextmenu', event => {
      event.preventDefault();
      if (inSearch()) {
        const row = event.target.closest('.search-row');
        if (!row) return;
        const path = unattr(row.dataset.path);
        local.selected = path;
        const folder = row.dataset.type === 'directory';
        showContextMenu(event.clientX, event.clientY, [
          {id: 'open', label: folder ? 'Open folder' : 'Open in editor', action: () => openResult(row)},
          folder ? null : {id: 'download', icon: 'download', label: 'Download', action: () => downloadPath(path)},
          {separator: true},
          {id: 'reveal', icon: 'refresh', label: 'Show containing folder', action: () => { clearSearch(); load(path.split('/').slice(0, -1).join('/') || '/'); }},
          {id: 'trash', icon: 'trash', label: 'Move to Trash', danger: true, action: deleteSelected}
        ]);
        return;
      }
      if (inTrash()) {
        const row = event.target.closest('.trash-row');
        if (!row) { showContextMenu(event.clientX, event.clientY, [{id: 'empty', icon: 'trash', label: 'Empty Trash', danger: true, action: emptyTrash}]); return; }
        const name = unattr(row.dataset.name);
        showContextMenu(event.clientX, event.clientY, [
          {id: 'restore', icon: 'restore', label: 'Restore', action: () => restoreEntry(name)},
          {id: 'purge', icon: 'trash', label: 'Delete permanently', danger: true, action: () => purgeEntry(name)}
        ]);
        return;
      }
      const entry = event.target.closest('.file-entry');
      selectEntry(entry);
      if (entry) {
        const path = unattr(entry.dataset.path);
        const folder = entry.dataset.type === 'directory';
        showContextMenu(event.clientX, event.clientY, [
          {id: 'open', label: folder ? 'Open folder' : 'Open in editor', hint: '↵', action: () => openPath(path)},
          folder ? null : {id: 'download', icon: 'download', label: 'Download', action: () => downloadPath(path)},
          {separator: true},
          {id: 'rename', label: 'Rename', hint: 'F2', action: renameSelected},
          {id: 'trash', icon: 'trash', label: 'Move to Trash', hint: 'Del', danger: true, action: deleteSelected}
        ]);
        return;
      }
      showContextMenu(event.clientX, event.clientY, [
        {id: 'file', icon: 'plus', label: 'New file', action: () => createEntry({title: 'New file', message: 'Give the file a name with its extension.', placeholder: 'notes.txt', confirm: 'Create'}, 'file')},
        {id: 'folder', icon: 'plus', label: 'New folder', action: () => createEntry({title: 'New folder', message: 'Give the folder a name.', placeholder: 'Projects', confirm: 'Create'}, 'directory')},
        {id: 'upload', icon: 'upload', label: 'Upload files', action: pickUpload},
        {separator: true},
        {id: 'hidden', icon: 'eye', label: local.showHidden ? 'Hide dotfiles' : 'Show hidden files', action: toggleHidden}
      ]);
    });
    $('.breadcrumb', win).addEventListener('click', event => { const crumb = event.target.closest('[data-path]'); if (crumb) load(unattr(crumb.dataset.path)); });
    $$('.place-button', win).forEach(button => button.addEventListener('click', () => load(button.dataset.path)));
    $('.file-back', win).addEventListener('click', () => { if (local.index > 0) { local.index--; load(local.history[local.index], false); } });
    $('.file-up', win).addEventListener('click', () => { if (!inTrash()) load(local.path.split('/').slice(0, -1).join('/') || '/', false); });
    $('.file-refresh', win).addEventListener('click', () => load(local.path, false));
    $('.file-new', win).addEventListener('click', () => createEntry({title: 'Create an item', message: 'Add a trailing slash to create a folder.', placeholder: 'notes.txt or Projects/', confirm: 'Create'}));
    $('.file-upload', win).addEventListener('click', pickUpload);
    $('.file-hidden', win).addEventListener('click', toggleHidden);
    $('.file-empty', win).addEventListener('click', emptyTrash);
    $('.file-search', win).addEventListener('input', scheduleSearch);
    $('.file-search', win).addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); clearSearch(); win.focus(); } });
    $('.file-search-clear', win).addEventListener('click', () => { clearSearch(); $('.file-search', win).focus(); });

    let dragDepth = 0;
    const dragging = event => !inTrash() && [...(event.dataTransfer?.types || [])].includes('Files');
    main.addEventListener('dragover', event => { if (dragging(event)) event.preventDefault(); });
    main.addEventListener('dragenter', event => { if (!dragging(event)) return; event.preventDefault(); dragDepth++; main.classList.add('drop-active'); });
    main.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) main.classList.remove('drop-active'); });
    main.addEventListener('drop', event => {
      if (!dragging(event)) return;
      event.preventDefault(); dragDepth = 0; main.classList.remove('drop-active');
      uploadFiles(event.dataTransfer.files);
    });

    const onKey = event => {
      if (state.activeWindow !== win || win.classList.contains('minimized') || inTrash() || inSearch()) return;
      if (event.target.closest('input, textarea')) return;
      if (event.key === 'F2' && local.selected) { event.preventDefault(); renameSelected(); }
      else if (event.key === 'Delete' && local.selected) { event.preventDefault(); deleteSelected(); }
      else if (event.key === 'Enter' && local.selected) { event.preventDefault(); openPath(local.selected); }
    };
    document.addEventListener('keydown', onKey);

    api('/api/system').then(data => {
      const disk = data.system.disk;
      $('.storage-bar', win).style.width = `${Math.round(disk.percent)}%`;
      $('.storage-text', win).textContent = `${formatBytes(disk.used)} of ${formatBytes(disk.total)}`;
    }).catch(() => { $('.storage-text', win).textContent = 'Workspace volume'; });

    win._cleanup = () => { document.removeEventListener('keydown', onKey); closeContextMenu(); };
    syncToolbar();
    load('/');
  }

  async function openEditor(path) {
    const key = `editor:${path}`;
    const existing = state.windows.get(key); if (existing) return focusWindow(existing);
    openApp('editor', {key, path, title: path.split('/').pop()});
  }

  // Terminal app
  function terminalMarkup() {
    return `<div class="terminal-shell">
      <div class="terminal-bar">
        <div class="terminal-tabs"></div>
        <span class="terminal-host">connecting…</span>
        <div class="terminal-actions"><button class="terminal-clear" title="Clear">⌫</button><button class="terminal-reconnect" title="Reconnect">↻</button><button class="terminal-add" title="New tab">+</button></div>
      </div>
      <div class="terminal-panes"></div>
    </div>`;
  }

  const TERMINAL_THEME = {background:'#090e15', foreground:'#cbd5df', cursor:'#79e6c6', cursorAccent:'#090e15', selectionBackground:'#2a5f5b88', black:'#111820', red:'#f0787f', green:'#74d9af', yellow:'#e5c07b', blue:'#74a8e8', magenta:'#b28ade', cyan:'#67d2ce', white:'#dce3ea', brightBlack:'#536070', brightRed:'#ff8d93', brightGreen:'#8ce9c3', brightYellow:'#f0d08c', brightBlue:'#8bbaff', brightMagenta:'#c49bf4', brightCyan:'#83e8df', brightWhite:'#f5f7fa'};

  function mountTerminal(win, options = {}) {
    if (!window.Terminal || !window.FitAddon) throw new Error('Terminal assets did not load');
    const tabBar = $('.terminal-tabs', win);
    const panes = $('.terminal-panes', win);
    const fontSize = Number(localStorage.getItem('lumadesk.termFont')) || 12;
    const sessions = [];
    let created = 0;

    const active = () => sessions.find(session => session.active) || null;

    const paintTabs = () => {
      tabBar.innerHTML = sessions.map((session, index) => `<button class="terminal-tab${session.active ? ' active' : ''}" data-index="${index}"><i></i><span>${esc(session.title)}</span><em class="tab-close" data-close="${index}" title="Close tab">×</em></button>`).join('');
      const current = active();
      $('.terminal-host', win).textContent = current ? current.status : '';
    };

    const fitSession = session => {
      try {
        session.fit.fit();
        if (session.socket?.readyState === WebSocket.OPEN) {
          session.socket.send(JSON.stringify({type: 'resize', rows: session.terminal.rows, cols: session.terminal.cols}));
        }
      } catch (_) { /* the pane can detach mid-frame */ }
    };

    const activate = session => {
      if (!session) return;
      sessions.forEach(item => { item.active = item === session; item.pane.classList.toggle('hidden', item !== session); });
      paintTabs();
      setTimeout(() => { fitSession(session); session.terminal.focus(); }, 30);
    };

    const connect = session => {
      clearTimeout(session.reconnectTimer);
      if (session.socket) { try { session.socket.close(); } catch (_) {} }
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${scheme}://${location.host}/ws/terminal`);
      session.socket = socket;
      socket.binaryType = 'arraybuffer';
      session.status = 'connecting…';
      paintTabs();
      socket.onopen = () => { session.status = `${state.session?.user || 'webos'}@${state.session?.host || location.host}`; paintTabs(); fitSession(session); };
      socket.onmessage = event => {
        if (typeof event.data === 'string') {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'ready') {
              session.status = `${data.user}@${data.host}`;
              paintTabs();
              if (session.command) { socket.send(JSON.stringify({type: 'input', data: `${session.command}\r`})); session.command = null; }
              return;
            }
          } catch (_) { session.terminal.write(event.data); }
        } else session.terminal.write(new Uint8Array(event.data));
      };
      socket.onclose = () => {
        session.status = 'disconnected';
        paintTabs();
        session.terminal.write('\r\n\x1b[38;5;245m[session disconnected — press ↻ to reconnect]\x1b[0m\r\n');
      };
      socket.onerror = () => { session.status = 'connection error'; paintTabs(); };
    };

    let pendingCommand = options.command || null;
    const createSession = () => {
      created += 1;
      const pane = document.createElement('div');
      pane.className = 'terminal-container';
      panes.append(pane);
      const terminal = new window.Terminal({
        cursorBlink: true, cursorStyle: 'bar', fontFamily: 'SFMono-Regular, Cascadia Code, Liberation Mono, monospace',
        fontSize, lineHeight: 1.25, scrollback: 5000, allowTransparency: true, theme: TERMINAL_THEME
      });
      const fit = new window.FitAddon.FitAddon();
      terminal.loadAddon(fit);
      terminal.open(pane);
      const session = {title: `bash ${created}`, pane, terminal, fit, socket: null, reconnectTimer: null, status: 'connecting…', active: false, observer: null, command: pendingCommand};
      pendingCommand = null;
      session.observer = new ResizeObserver(() => requestAnimationFrame(() => { if (session.active) fitSession(session); }));
      session.observer.observe(pane);
      terminal.onData(data => { if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({type: 'input', data})); });
      sessions.push(session);
      connect(session);
      activate(session);
      return session;
    };

    const closeSession = session => {
      const index = sessions.indexOf(session);
      if (index === -1) return;
      clearTimeout(session.reconnectTimer);
      try { session.observer?.disconnect(); } catch (_) {}
      try { session.socket?.close(); } catch (_) {}
      try { session.terminal.dispose(); } catch (_) {}
      session.pane.remove();
      sessions.splice(index, 1);
      if (!sessions.length) { createSession(); return; }
      activate(sessions[Math.min(index, sessions.length - 1)]);
    };

    tabBar.addEventListener('click', event => {
      const closer = event.target.closest('[data-close]');
      if (closer) { closeSession(sessions[Number(closer.dataset.close)]); return; }
      const tab = event.target.closest('.terminal-tab');
      if (tab) activate(sessions[Number(tab.dataset.index)]);
    });
    $('.terminal-add', win).addEventListener('click', () => createSession());
    $('.terminal-clear', win).addEventListener('click', () => { const session = active(); if (session) { session.terminal.clear(); session.terminal.focus(); } });
    $('.terminal-reconnect', win).addEventListener('click', () => { const session = active(); if (session) connect(session); });

    win._onResize = () => fitSession(active());
    win._onFocus = () => setTimeout(() => active()?.terminal.focus(), 20);
    win._cleanup = () => {
      while (sessions.length) {
        const session = sessions.pop();
        clearTimeout(session.reconnectTimer);
        try { session.observer?.disconnect(); } catch (_) {}
        try { session.socket?.close(); } catch (_) {}
        try { session.terminal.dispose(); } catch (_) {}
      }
    };
    createSession();
    setTimeout(() => fitSession(active()), 100);
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

  function settingsMarkup(){
    const session = state.session || {};
    const edition = session.runtime === 'systemd' ? 'Docker web workspace · systemd edition' : 'Docker web workspace · compatibility edition';
    const termFont = Number(localStorage.getItem('lumadesk.termFont')) || 12;
    const showHidden = localStorage.getItem('lumadesk.showHidden') === '1';
    return `<div class="settings-shell"><aside class="settings-nav"><div class="settings-profile"><div class="avatar">${esc((session.user || 'w').charAt(0).toUpperCase())}</div><div><strong>${esc(session.user || 'webos')}</strong><span>${esc(session.host || location.hostname)}</span></div></div><button class="active" data-page="appearance">◐ Appearance</button><button data-page="workspace">⌨ Workspace</button><button data-page="about">◎ About</button></aside><section class="settings-content">
      <div class="settings-page active" data-page="appearance"><h2>Appearance</h2><p>Personalize this browser. Preferences are stored locally on this device.</p><div class="setting-group"><div class="setting-row"><div><strong>Accent color</strong><small>Used for controls, indicators, and charts</small></div><div class="accent-choices"><button class="accent-choice" style="--choice:#72e6c1" data-color="#72e6c1" data-rgb="114,230,193"></button><button class="accent-choice" style="--choice:#77a8ff" data-color="#77a8ff" data-rgb="119,168,255"></button><button class="accent-choice" style="--choice:#b491ff" data-color="#b491ff" data-rgb="180,145,255"></button><button class="accent-choice" style="--choice:#ff9b7b" data-color="#ff9b7b" data-rgb="255,155,123"></button></div></div><div class="setting-row"><div><strong>Wallpaper mood</strong><small>Adjust the desktop atmosphere</small></div><div class="wallpaper-choices"><button class="wallpaper-choice" data-paper="aurora" style="--paper:linear-gradient(145deg,#183d43,#26325a,#121721)"></button><button class="wallpaper-choice" data-paper="ocean" style="--paper:linear-gradient(145deg,#123f53,#0a1b32)"></button><button class="wallpaper-choice" data-paper="ember" style="--paper:linear-gradient(145deg,#4c2434,#21162f)"></button></div></div><div class="setting-row"><div><strong>Reduce motion</strong><small>Minimize interface animation and transitions</small></div><button class="switch motion-switch" aria-label="Reduce motion"></button></div></div></div>
      <div class="settings-page" data-page="workspace"><h2>Workspace</h2><p>Defaults for the Files and Terminal apps on this device.</p><div class="setting-group"><div class="setting-row"><div><strong>Show hidden files</strong><small>Display dotfiles as soon as the Files app opens</small></div><button class="switch hidden-switch ${showHidden ? 'on' : ''}" aria-label="Show hidden files"></button></div><div class="setting-row"><div><strong>Terminal font size</strong><small>Applied to Terminal windows opened from now on</small></div><div class="segmented">${[11, 12, 13, 14, 16].map(size => `<button class="segment ${size === termFont ? 'active' : ''}" data-size="${size}">${size}</button>`).join('')}</div></div><div class="setting-row"><div><strong>Reset local preferences</strong><small>Clear accent, wallpaper, motion, and workspace defaults</small></div><button class="tool-button danger settings-reset">Reset</button></div></div></div>
      <div class="settings-page" data-page="about"><h2>About</h2><p>Runtime details for this workspace.</p><div class="setting-group"><div class="setting-row"><div class="about-logo"><div class="brand-symbol"><span></span><span></span><span></span></div><div><strong>LumaDesk OS ${esc(session.version || 'dev')}</strong><small>${edition}</small></div></div></div><div class="setting-row"><div><strong>Session</strong><small>Signed in as ${esc(session.user || 'webos')} on ${esc(session.host || 'this host')}</small></div><span class="state-pill enabled">Active</span></div><div class="setting-row"><div><strong>Security model</strong><small>Authenticated session · CSRF protection · workspace-scoped files</small></div><span class="state-pill enabled">Protected</span></div><div class="setting-row"><div><strong>Sign out</strong><small>Close every open application window and clear the session cookie</small></div><button class="tool-button settings-logout">Sign out</button></div></div></div>
    </section></div>`;
  }

  function applyPreferences(){
    const color=localStorage.getItem('lumadesk.accent')||'#72e6c1',rgb=localStorage.getItem('lumadesk.accentRgb')||'114,230,193';document.documentElement.style.setProperty('--accent',color);document.documentElement.style.setProperty('--accent-rgb',rgb);
    document.body.classList.toggle('reduce-motion',localStorage.getItem('lumadesk.reduceMotion')==='1');
    const paper=localStorage.getItem('lumadesk.wallpaper')||'aurora',wall=$('.wallpaper');if(wall){wall.dataset.paper=paper;wall.style.background=paper==='ocean'?'radial-gradient(ellipse at 50% 70%,#14475c 0%,#0b2238 38%,#070b13 78%)':paper==='ember'?'radial-gradient(ellipse at 55% 70%,#4a2638 0%,#23162d 40%,#090a12 78%)':'';}
  }
  function mountSettings(win){
    $$('.settings-nav button[data-page]',win).forEach(button=>button.addEventListener('click',()=>{
      $$('.settings-nav button[data-page]',win).forEach(node=>node.classList.toggle('active',node===button));
      $$('.settings-page',win).forEach(page=>page.classList.toggle('active',page.dataset.page===button.dataset.page));
    }));
    const color=localStorage.getItem('lumadesk.accent')||'#72e6c1';$$('.accent-choice',win).forEach(button=>{button.classList.toggle('active',button.dataset.color===color);button.addEventListener('click',()=>{localStorage.setItem('lumadesk.accent',button.dataset.color);localStorage.setItem('lumadesk.accentRgb',button.dataset.rgb);applyPreferences();$$('.accent-choice',win).forEach(b=>b.classList.toggle('active',b===button));});});
    const paper=localStorage.getItem('lumadesk.wallpaper')||'aurora';$$('.wallpaper-choice',win).forEach(button=>{button.classList.toggle('active',button.dataset.paper===paper);button.addEventListener('click',()=>{localStorage.setItem('lumadesk.wallpaper',button.dataset.paper);applyPreferences();$$('.wallpaper-choice',win).forEach(b=>b.classList.toggle('active',b===button));});});
    const toggle=$('.motion-switch',win);toggle.classList.toggle('on',document.body.classList.contains('reduce-motion'));toggle.addEventListener('click',()=>{const on=localStorage.getItem('lumadesk.reduceMotion')!=='1';localStorage.setItem('lumadesk.reduceMotion',on?'1':'0');applyPreferences();toggle.classList.toggle('on',on);});
    const hiddenToggle=$('.hidden-switch',win);hiddenToggle.addEventListener('click',()=>{
      const on=!hiddenToggle.classList.contains('on');
      hiddenToggle.classList.toggle('on',on);
      localStorage.setItem('lumadesk.showHidden',on?'1':'0');
      [...state.windows.values()].filter(node=>node.dataset.app==='files').forEach(node=>node._fileState?.load?.(node._fileState.path,false));
      toast('Files updated',on?'Hidden files are now visible.':'Dotfiles are hidden again.');
    });
    $$('.segmented .segment',win).forEach(button=>button.addEventListener('click',()=>{localStorage.setItem('lumadesk.termFont',button.dataset.size);$$('.segmented .segment',win).forEach(node=>node.classList.toggle('active',node===button));toast('Terminal updated','New Terminal windows use this font size.');}));
    $('.settings-reset',win).addEventListener('click',async()=>{
      const answer=await showDialog({title:'Reset preferences?',message:'Accent color, wallpaper, motion, and workspace defaults return to their shipped values.',confirm:'Reset',danger:true});
      if(!answer)return;
      Object.keys(localStorage).filter(key=>key.startsWith('lumadesk.')&&key!=='lumadesk.seen').forEach(key=>localStorage.removeItem(key));
      applyPreferences();
      toast('Preferences reset','Reopen Settings or reload to see every default.');
    });
    $('.settings-logout',win).addEventListener('click',signOut);
  }

  // Store (CasaOS-style app catalog)
  function storeMarkup() {
    return `<div class="store-shell">
      <div class="store-head">
        <div class="store-heading"><strong>Store</strong><span class="store-count">Loading catalog…</span></div>
        <div class="search-field store-search-field">${svg('search')}<input class="store-search" placeholder="Search apps" autocomplete="off"></div>
      </div>
      <div class="store-cats"></div>
      <div class="store-grid"><div class="app-empty" style="grid-column:1/-1"><div><div class="spinner"></div><p>Loading catalog…</p></div></div></div>
    </div>`;
  }

  function mountStore(win) {
    const local = {apps: [], category: 'All', query: '', jobs: new Map()};
    win._storeState = local;
    const grid = $('.store-grid', win);

    const categories = () => ['All', ...new Set(local.apps.map(app => app.category))];

    const renderCategories = () => {
      $('.store-cats', win).innerHTML = categories().map(category => {
        const total = category === 'All' ? local.apps.length : local.apps.filter(app => app.category === category).length;
        return `<button class="store-cat${category === local.category ? ' active' : ''}" data-cat="${attr(category)}">${esc(category)}<span>${total}</span></button>`;
      }).join('');
    };

    const renderApps = () => {
      const query = local.query.trim().toLowerCase();
      const apps = local.apps.filter(app => (local.category === 'All' || app.category === local.category)
        && (!query || `${app.name} ${app.tagline} ${app.category}`.toLowerCase().includes(query)));
      if (!apps.length) {
        grid.innerHTML = `<div class="app-empty" style="grid-column:1/-1"><div><strong>No apps match</strong><p>Try another search term or category.</p></div></div>`;
        return;
      }
      grid.innerHTML = apps.map(app => {
        const job = local.jobs.get(app.id);
        const busy = job && job.state !== 'done' && job.state !== 'failed';
        const action = busy
          ? `<button class="tool-button" disabled><span class="spinner mini"></span>${job.action === 'install' ? 'Installing' : 'Removing'}…</button>`
          : app.installed
            ? `<button class="tool-button primary store-open">Open</button><button class="tool-button store-uninstall" ${app.installable || app.type !== 'package' ? '' : 'disabled'}>Uninstall</button>`
            : `<button class="tool-button primary store-install" ${app.installable ? '' : 'disabled'}>Install</button>`;
        return `<article class="store-card${app.installed ? ' installed' : ''}" data-id="${attr(app.id)}">
          <span class="store-icon">${app.icon}</span>
          <div class="store-copy"><strong>${esc(app.name)}</strong><span>${esc(app.tagline)}</span></div>
          <div class="store-meta"><span class="store-cat-chip">${esc(app.category)}</span>${app.installed ? '<span class="store-installed">Installed</span>' : ''}${app.type === 'package' ? `<span class="store-kind">apt</span>` : `<span class="store-kind">${esc(app.type)}</span>`}</div>
          <div class="store-actions">${action}<button class="tool-button icon-tool store-log" title="Show job log" ${job ? '' : 'disabled'}>${svg('refresh')}</button></div>
        </article>`;
      }).join('');
    };

    const showLog = app => {
      const job = local.jobs.get(app.id);
      const drawer = document.createElement('div');
      drawer.className = 'log-drawer';
      drawer.innerHTML = `<div class="log-header"><strong>${esc(app.name)} · ${esc(job?.action || 'install')}</strong><button class="tool-button log-close">${svg('close')} Close</button></div><pre class="log-content">No output yet.</pre>`;
      $('.window-content', win).append(drawer);
      $('.log-close', drawer).addEventListener('click', () => drawer.remove());
      if (job) $('.log-content', drawer).textContent = job.log.join('\n\n') || 'Waiting for output…';
    };

    const pollJob = async (app, jobId) => {
      for (let attempt = 0; attempt < 240; attempt += 1) {
        await sleep(900);
        let job;
        try { job = (await api(`/api/store/jobs/${encodeURIComponent(jobId)}`)).job; } catch (_) { return; }
        local.jobs.set(app.id, job);
        renderApps();
        if (job.state === 'done') {
          toast('Store', `${app.name} ${job.action === 'install' ? 'installed' : 'removed'}.`);
          await load();
          return;
        }
        if (job.state === 'failed') {
          toast('Store', `${app.name}: ${job.action} failed. Open the log for details.`, 'error', 6000);
          await load();
          return;
        }
      }
    };

    const run = async (app, action) => {
      if (action === 'uninstall') {
        const answer = await showDialog({
          title: `Uninstall ${app.name}?`,
          message: app.type === 'package' ? `apt will remove ${app.packages.join(', ')} from this container.` : 'The launcher entry will be removed from this desktop.',
          confirm: 'Uninstall', danger: true
        });
        if (!answer) return;
      }
      try {
        const result = await api(`/api/store/${encodeURIComponent(app.id)}/${action}`, {method: 'POST', body: {}});
        local.jobs.set(app.id, {action, state: 'queued', log: []});
        renderApps();
        pollJob(app, result.job);
      } catch (error) { toast('Store', error.message, 'error'); }
    };

    const load = async () => {
      try {
        const data = await api('/api/store');
        local.apps = data.apps;
        const installed = data.apps.filter(app => app.installed).length;
        $('.store-count', win).textContent = `${data.count} apps · ${installed} installed`;
        if (!data.package_install_supported) {
          $('.store-count', win).title = data.package_install_message;
        }
        renderCategories();
        renderApps();
      } catch (error) {
        grid.innerHTML = `<div class="app-empty" style="grid-column:1/-1"><div><strong>Store unavailable</strong><p>${esc(error.message)}</p></div></div>`;
      }
    };
    local.load = load;

    grid.addEventListener('click', event => {
      const card = event.target.closest('.store-card');
      if (!card) return;
      const app = local.apps.find(candidate => candidate.id === unattr(card.dataset.id));
      if (!app) return;
      if (event.target.closest('.store-log')) return showLog(app);
      if (event.target.closest('.store-install')) return run(app, 'install');
      if (event.target.closest('.store-uninstall')) return run(app, 'uninstall');
      if (event.target.closest('.store-open')) return openStoreApp(app);
    });
    $('.store-cats', win).addEventListener('click', event => {
      const button = event.target.closest('.store-cat');
      if (!button) return;
      local.category = unattr(button.dataset.cat);
      renderCategories();
      renderApps();
    });
    $('.store-search', win).addEventListener('input', event => { local.query = event.target.value; renderApps(); });
    load();
  }

  function openStoreApp(app) {
    if (app.type === 'link') { window.open(app.url, '_blank', 'noopener'); return; }
    if (app.launch?.command) {
      openApp('terminal', {key: `terminal:${app.id}`, title: app.launch.label || app.name, command: app.launch.command});
      return;
    }
    openApp('terminal');
  }

  async function refreshStoreShortcuts() {
    try {
      const data = await api('/api/store');
      state.shortcuts = data.apps.filter(app => app.installed && (app.launch || app.type === 'link'));
    } catch (_) { state.shortcuts = []; }
    populateLauncher();
    renderDesktopShortcuts();
  }

  function renderDesktopShortcuts() {
    const holder = $('#desktop-icons');
    if (!holder) return;
    $$('.desktop-icon[data-shortcut]', holder).forEach(node => node.remove());
    (state.shortcuts || []).slice(0, 8).forEach(app => {
      const button = document.createElement('button');
      button.className = 'desktop-icon';
      button.dataset.shortcut = app.id;
      button.innerHTML = `<span class="app-icon icon-shortcut">${app.icon}</span><span>${esc(app.launch?.label || app.name)}</span>`;
      button.addEventListener('click', () => openStoreApp(app));
      holder.append(button);
    });
  }

  const apps = {
    welcome: {title:'Welcome',icon:'welcome',width:790,height:570,render:welcomeMarkup,mount:mountWelcome},
    files: {title:'Files',icon:'files',width:890,height:570,render:filesMarkup,mount:mountFiles},
    terminal: {title:'Terminal',icon:'terminal',width:820,height:510,render:terminalMarkup,mount:mountTerminal},
    store: {title:'Store',icon:'store',width:1000,height:640,render:storeMarkup,mount:mountStore},
    services: {title:'Services',icon:'services',width:960,height:590,render:servicesMarkup,mount:mountServices},
    system: {title:'System Monitor',icon:'system',width:900,height:610,render:systemMarkup,mount:mountSystem},
    settings: {title:'Settings',icon:'settings',width:720,height:520,render:settingsMarkup,mount:mountSettings},
    editor: {title:'Editor',icon:'editor',width:760,height:540,singleton:false,render:editorMarkup,mount:mountEditor}
  };

  function populateLauncher(){
    const order=['files','terminal','store','services','system','settings','welcome'];
    const builtIn=order.map(id=>`<button class="launcher-app" data-app="${id}" data-search="${apps[id].title.toLowerCase()}">${icon(apps[id].icon)}<span>${esc(apps[id].title)}</span></button>`).join('');
    const installed=(state.shortcuts||[]).map(app=>`<button class="launcher-app installed-app" data-shortcut="${attr(app.id)}" data-search="${esc((app.launch?.label||app.name).toLowerCase())}"><span class="app-icon icon-shortcut">${app.icon}</span><span>${esc(app.launch?.label||app.name)}</span></button>`).join('');
    $('#launcher-grid').innerHTML=builtIn+installed;
    $$('.launcher-app[data-app]').forEach(button=>button.addEventListener('click',()=>openApp(button.dataset.app)));
    $$('.launcher-app[data-shortcut]').forEach(button=>button.addEventListener('click',()=>{
      const app=(state.shortcuts||[]).find(candidate=>candidate.id===unattr(button.dataset.shortcut));
      if(app){hidePanels();openStoreApp(app);}
    }));
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
    document.addEventListener('pointerdown',event=>{if(!event.target.closest('.context-menu'))closeContextMenu();if(!event.target.closest('.panel,.topbar-brand,.status-button,.launcher-button'))hidePanels();},true);
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'){closeContextMenu();hidePanels();return;}
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
