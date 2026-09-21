/**
 * DOM smoke test for the desktop shell.
 *
 * Loads the real `index.html` and `app.js` in jsdom against a stubbed API and
 * drives the flows added in 1.1.0: hidden-file toggling, the Trash view with
 * restore/empty, right-click context menus, and the Settings tabs.
 *
 * Run with: npm run test:frontend
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM, VirtualConsole} from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticDir = path.join(root, 'app', 'static');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const settle = (ms = 900) => new Promise(resolve => setTimeout(resolve, ms));

const HOME_ENTRIES = [
  {name: 'Documents', path: '/Documents', type: 'directory', symlink: false, size: 4096, modified: 1_700_000_000, hidden: false, mime: null},
  {name: 'notes.txt', path: '/notes.txt', type: 'file', symlink: false, size: 12, modified: 1_700_000_000, hidden: false, mime: 'text/plain'},
  {name: '.bashrc', path: '/.bashrc', type: 'file', symlink: false, size: 220, modified: 1_700_000_000, hidden: true, mime: 'text/plain'}
];
const TRASH = {
  ok: true, count: 1, size: 12,
  entries: [{name: '20260920-120000-notes.txt', label: 'notes.txt', original: '/Documents/notes.txt', type: 'file', size: 12, deleted: Math.floor(Date.now() / 1000) - 60}]
};
const SYSTEM = {
  ok: true,
  system: {
    hostname: 'demo', os: 'Debian GNU/Linux 13', kernel: '6.1.0', architecture: 'x86_64', container: true, uptime: 600,
    cpu: {percent: 12, count: 4, frequency: 2400, load: [0.1, 0.1, 0.1]},
    memory: {total: 1e9, used: 2e8, available: 8e8, percent: 20},
    swap: {total: 0, used: 0, percent: 0},
    disk: {total: 1e10, used: 2e9, free: 8e9, percent: 20},
    network: {sent: 1, received: 2}, processes: 10, time: 0
  }
};

const calls = [];
const respond = (status, body) => ({
  ok: status < 400,
  status,
  headers: {get: () => 'application/json'},
  json: async () => body,
  text: async () => JSON.stringify(body)
});

function stubFetch(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  calls.push(`${method} ${url}`);
  if (url.startsWith('/api/session')) {
    return Promise.resolve(respond(200, {
      authenticated: true, user: 'webos', csrf: 'test-token', expires: 0,
      host: 'demo', demo: true, runtime: 'systemd', version: '1.1.0'
    }));
  }
  if (url.startsWith('/api/system')) return Promise.resolve(respond(200, SYSTEM));
  if (url.startsWith('/api/files/search')) {
    const query = new URL(url, 'http://localhost').searchParams.get('q') || '';
    const matches = query.toLowerCase() === 'notes'
      ? [
          {name: 'notes.txt', path: '/notes.txt', folder: '/', type: 'file', size: 12, modified: 1_700_000_000, mime: 'text/plain'},
          {name: 'notes-old.md', path: '/Documents/notes-old.md', folder: '/Documents', type: 'file', size: 40, modified: 1_700_000_000, mime: 'text/markdown'}
        ]
      : [];
    return Promise.resolve(respond(200, {ok: true, query, root: '/', count: matches.length, truncated: false, matches}));
  }
  if (url.startsWith('/api/files')) {
    const showHidden = url.includes('hidden=1');
    return Promise.resolve(respond(200, {
      ok: true, path: '/', parent: null, entries: HOME_ENTRIES.filter(entry => showHidden || !entry.hidden)
    }));
  }
  if (url.startsWith('/api/trash/restore')) return Promise.resolve(respond(200, {ok: true, name: 'notes.txt', path: '/Documents/notes.txt'}));
  if (url.startsWith('/api/trash/empty')) return Promise.resolve(respond(200, {ok: true, removed: 1}));
  if (url.startsWith('/api/trash')) return Promise.resolve(respond(200, TRASH));
  if (url.startsWith('/api/logout')) return Promise.resolve(respond(200, {ok: true}));
  return Promise.resolve(respond(404, {ok: false, error: `not stubbed: ${url}`}));
}

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => { throw error; });

const dom = new JSDOM(readFileSync(path.join(staticDir, 'index.html'), 'utf8'), {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'http://localhost/',
  virtualConsole
});
const {window} = dom;
window.fetch = stubFetch;
window.WebSocket = class {constructor() {this.readyState = 0;} send() {} close() {}};
window.ResizeObserver = class {observe() {} disconnect() {}};
window.Terminal = class {
  constructor(options) {this.options = options; this.rows = 24; this.cols = 80;}
  loadAddon() {} open() {} write() {} clear() {} focus() {} dispose() {}
  onData() {return {dispose() {}};}
};
window.FitAddon = {FitAddon: class {fit() {}}};
window.matchMedia = () => ({matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}});

window.eval(readFileSync(path.join(staticDir, 'app.js'), 'utf8'));
await settle();

const doc = window.document;
const click = async element => { element.dispatchEvent(new window.MouseEvent('click', {bubbles: true, cancelable: true})); await tick(); };

// The desktop opens once the session check succeeds.
assert.equal(doc.querySelector('#desktop').classList.contains('hidden'), false, 'desktop is visible after the session check');
assert.equal(doc.querySelector('#menu-user').textContent, 'webos', 'session user is rendered');

// Files lists the folder, hiding dotfiles until the toggle is used.
await click(doc.querySelector('.dock-button[data-app="files"]'));
assert.equal(doc.querySelectorAll('.file-entry').length, 2, 'dotfiles are hidden by default');
await click(doc.querySelector('.file-hidden'));
assert.equal(doc.querySelectorAll('.file-entry').length, 3, 'the hidden-file toggle reveals dotfiles');
assert.ok(calls.some(call => call.includes('/api/files') && call.includes('hidden=1')), 'hidden=1 is sent to the API');
await click(doc.querySelector('.file-hidden'));

// Right-clicking a folder offers folder actions; right-clicking a file adds Download.
const contextLabels = async element => {
  element.dispatchEvent(new window.MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 20, clientY: 20}));
  await tick();
  return [...doc.querySelectorAll('.context-menu .menu-item span')].map(node => node.textContent);
};
assert.deepEqual(
  await contextLabels(doc.querySelector('.file-entry[data-type="directory"]')),
  ['Open folder', 'Rename', 'Move to Trash']
);
assert.deepEqual(
  await contextLabels(doc.querySelector('.file-entry[data-type="file"]')),
  ['Open in editor', 'Download', 'Rename', 'Move to Trash']
);
await click(doc.querySelector('.context-menu .menu-item'));
assert.equal(doc.querySelector('.context-menu'), null, 'the context menu closes after an action');

// The Trash place lists restorable items and exposes Empty Trash.
await click(doc.querySelector('.place-button[data-path="@trash"]'));
assert.equal(doc.querySelectorAll('.trash-row').length, 1, 'the trashed item is listed');
assert.equal(doc.querySelector('.trash-meta strong').textContent, 'notes.txt', 'the original name is shown');
assert.match(doc.querySelector('.trash-meta span').textContent, /from \/Documents\/notes\.txt/, 'the original path is shown');
assert.equal(doc.querySelector('.file-empty').classList.contains('hidden'), false, 'Empty Trash is available in the Trash view');
await click(doc.querySelector('.trash-row .restore'));
assert.ok(calls.some(call => call === 'POST /api/trash/restore'), 'restore posts to the Trash API');

// Settings exposes working tabs and persists workspace preferences.
await click(doc.querySelector('.dock-button[data-app="settings"]'));
assert.equal(doc.querySelectorAll('.settings-page').length, 3, 'settings renders appearance, workspace, and about pages');
assert.equal(doc.querySelector('.settings-page[data-page="appearance"]').classList.contains('active'), true);
await click(doc.querySelector('.settings-nav button[data-page="workspace"]'));
assert.equal(doc.querySelector('.settings-page[data-page="workspace"]').classList.contains('active'), true, 'the workspace tab activates');
await click(doc.querySelector('.segment[data-size="14"]'));
assert.equal(window.localStorage.getItem('lumadesk.termFont'), '14', 'the terminal font size is stored');
await click(doc.querySelector('.hidden-switch'));
assert.equal(window.localStorage.getItem('lumadesk.showHidden'), '1', 'the hidden-file default is stored');
await click(doc.querySelector('.settings-nav button[data-page="about"]'));
assert.match(doc.querySelector('.settings-page[data-page="about"]').textContent, /LumaDesk OS 1\.1\.0/, 'the about page shows the reported version');

// Workspace search swaps the grid for result rows and clears back to the folder.
await click(doc.querySelector('.place-button[data-path="/"]'));
await settle(60);
assert.equal(doc.querySelectorAll('.file-entry').length, 2, 'the Files window is back in the home folder');
const searchField = doc.querySelector('.file-search');
searchField.value = 'notes';
searchField.dispatchEvent(new window.Event('input', {bubbles: true}));
await settle(320);
assert.equal(doc.querySelectorAll('.search-row').length, 2, 'search renders matching rows');
assert.match(doc.querySelector('.search-row .trash-meta span').textContent, /Workspace root/, 'the result shows its folder');
assert.ok(calls.some(call => call.includes('/api/files/search?q=notes')), 'the search query reaches the API');
await click(doc.querySelector('.file-search-clear'));
await settle(60);
assert.equal(doc.querySelectorAll('.file-entry').length, 2, 'clearing the search returns to the folder view');

// The terminal opens one tab and supports adding and closing tabs.
await click(doc.querySelector('.dock-button[data-app="terminal"]'));
assert.equal(doc.querySelectorAll('.terminal-tab').length, 1, 'the terminal opens with one tab');
assert.match(doc.querySelector('.terminal-tab span').textContent, /bash 1/);
await click(doc.querySelector('.terminal-add'));
assert.equal(doc.querySelectorAll('.terminal-tab').length, 2, 'a second terminal tab opens');
assert.equal(doc.querySelectorAll('.terminal-tab.active').length, 1, 'only one tab is active');
await click(doc.querySelector('.tab-close[data-close="0"]'));
assert.equal(doc.querySelectorAll('.terminal-tab').length, 1, 'closing a tab removes it');
assert.match(doc.querySelector('.terminal-tab span').textContent, /bash 2/, 'the remaining tab keeps its session');

console.log('frontend smoke test passed');
dom.window.close();
process.exit(0);
