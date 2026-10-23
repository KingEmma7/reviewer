'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// As in staged-ui.test.js, exercise the page's functions with a small DOM.
function lift(name, context) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const end = source.indexOf('\n}', start) + 2;
  const prefix = source.slice(start - 6, start) === 'async ' ? 'async ' : '';
  return vm.runInNewContext(`${prefix}${source.slice(start, end)}\n${name}`, context);
}

function element() {
  return {
    textContent: '', innerHTML: '', value: '/work/repo', style: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    replaceChildren() { this.textContent = ''; },
    append(...parts) { this.textContent += parts.join(''); }
  };
}

function dom() {
  const elements = new Map();
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelector() { return this.getElementById('fullContext'); },
    querySelectorAll() { return []; },
    createElement: element
  };
}

function loadContext(data) {
  const document = dom();
  const context = {
    document, stagedByDefault: false, untrackedByDefault: false, API_BASE: '/api',
    currentFile: null, currentFiles: [], commitContext: null, comments: [],
    showStatus() {}, clearStatus() {}, hidePicker() {}, showPicker() {}, setRepoButton() {},
    refreshCommitContext: async () => {}, loadRefs: async () => {},
    renderScope() {}, renderCommitList() {}, updateCommentsSidebar() {},
    displayFiles() {}, showEmptyFileList() {}, clearCodePane() {}, offerHelpOnce() {},
    loadCommentsFromBackend: async () => [], loadFile() {},
    plural: (n, word) => `${n} ${word}`,
    fetch: async (url, options) => {
      context.request = JSON.parse(options.body);
      return { ok: true, json: async () => data };
    }
  };
  return context;
}

test('the page carries untracked=0 into its load request and clears an empty tracked view', async () => {
  const configured = vm.runInNewContext(
    source.slice(0, source.indexOf('let currentRepoId')) + '\nuntrackedByDefault',
    { window: { location: { origin: 'http://localhost', search: '?untracked=0' } }, URLSearchParams }
  );
  assert.equal(configured, false);
  const context = loadContext({ repoId: 'one', mode: 'working', untracked: false, files: [] });
  let emptied = false;
  let message;
  context.clearCodePane = () => { emptied = true; };
  context.showEmptyFileList = text => { message = text; };
  await lift('loadRepo', context)();
  assert.equal(context.request.untracked, false);
  assert.equal(message, 'No tracked changes.');
  assert.equal(emptied, true);
});

test('the scope note keeps the names and counts of folded directories visible', () => {
  const document = dom();
  const render = lift('renderScope', {
    document, currentRefs: null, commitContext: null, plural: (n, word) => `${n} ${word}`
  });
  const message = 'Found 2 changed file(s). dd/ holds 3,000 untracked files; individual files are not listed.';
  render({ mode: 'working', files: [
    { path: 'dd/', directory: true, fileCount: 3000 }, { path: 'app.js' }
  ], message });
  assert.equal(document.getElementById('scopeNote').textContent, message);
});

test('a folded directory row shows its count and escapes the folder name', () => {
  const document = dom();
  const display = lift('displayFiles', {
    document, updateCommentsSidebar() {}, fileStatusClass: () => 'status-added',
    FILE_STATUS_NAMES: { A: 'Added' },
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
  });
  display([{ path: 'café<folder>/', status: 'A', directory: true, fileCount: 3000 }]);
  const html = document.getElementById('filesList').innerHTML;
  assert.match(html, /3,000 files/);
  assert.match(html, /café&lt;folder>/);
  assert.doesNotMatch(html, /café<folder>/);
});

test('opening a folded directory shows an explanation without requesting a diff or full context', async () => {
  const document = dom();
  const context = {
    document, currentRepoId: 'one', currentFiles: [{ path: 'dd/', directory: true, fileCount: 3000 }],
    currentDiffLines: [{ content: 'old diff' }], comments: [],
    escapeHtml: String, updateFullContextButton() {},
    showStatus(message) { assert.fail(message); },
    fetch() { assert.fail('a folded directory must not be read as a file'); }
  };
  await lift('loadFile', context)('dd/', 0);
  assert.equal(document.getElementById('currentFile').textContent, 'dd/');
  assert.match(document.getElementById('codeViewer').innerHTML, /3,000 untracked files/);
  assert.equal(context.currentDiffLines.length, 0);
  await lift('showFullContext', context)();
});

test('a folded first row does not hide the first reviewable file on load', async () => {
  const context = loadContext({ repoId: 'one', mode: 'working', files: [
    { path: 'dd/', directory: true, fileCount: 3000 }, { path: 'app.js', status: 'M' }
  ] });
  let opened;
  context.loadFile = file => { opened = file; };
  await lift('loadRepo', context)();
  assert.equal(opened, 'app.js');
});

test('a pending file response cannot replace a newly selected folded directory', async () => {
  const results = [];
  for (const kind of ['diff', 'full context']) {
    const document = dom();
    let finish;
    const response = new Promise(resolve => { finish = resolve; });
    const context = {
      document, API_BASE: '/api', currentRepoId: 'one', currentFile: 'app.js',
      currentFiles: [{ path: 'app.js', status: 'M' }, { path: 'dd/', directory: true, fileCount: 3000 }],
      currentDiffLines: [{ content: 'old diff' }], comments: [], isFullContextMode: false,
      updateFullContextButton() {},
      showStatus(message) { assert.fail(message); },
      fetch: () => response,
      displayCode(filePath, lines) {
        document.getElementById('currentFile').textContent = filePath;
        document.getElementById('codeViewer').innerHTML = 'file diff';
        context.currentDiffLines = lines;
      },
      displayFullContext(filePath) {
        document.getElementById('currentFile').textContent = filePath;
        document.getElementById('codeViewer').innerHTML = 'full file';
      }
    };
    const loadFile = lift('loadFile', context);
    const pending = kind === 'diff'
      ? loadFile('app.js', 0)
      : lift('showFullContext', context)();
    await loadFile('dd/', 1);
    finish({ ok: true, json: async () => ({
      filePath: 'app.js', diffLines: [{ content: 'tracked line' }], lines: ['tracked line']
    }) });
    await pending;
    results.push({
      kind,
      selected: context.currentFile,
      displayed: document.getElementById('currentFile').textContent,
      folderNotice: document.getElementById('codeViewer').innerHTML.includes('3,000 untracked files'),
      diffLines: context.currentDiffLines.length,
      fullContext: context.isFullContextMode
    });
  }
  assert.deepEqual(results, ['diff', 'full context'].map(kind => ({
    kind, selected: 'dd/', displayed: 'dd/', folderNotice: true, diffLines: 0, fullContext: false
  })));
});
