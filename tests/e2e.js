#!/usr/bin/env node
// Runtime interaction tests against a running Obsidian through its CLI.
//
// Usage:
//   npm run e2e                 build, deploy, reload, run all scenarios
//   npm run e2e -- --no-deploy  test the plugin already loaded in Obsidian
//   npm run e2e -- --only search,focus
//   npm run e2e -- --slow       also run slow release checks (leak loop)
//
// Requires Obsidian running with its command line interface enabled. Every
// scenario works on temporary notes named __mapdown_e2e_* in 00-INBOX, which
// are removed at the end even when a scenario fails.

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VAULT = process.env.MAPDOWN_VAULT ||
  '/Users/ian/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian';
const PLUGIN_DIR = path.join(VAULT, '.obsidian/plugins/mapdown');
const INBOX = '00-INBOX';
const PREFIX = '__mapdown_e2e_';
const VIEW_TYPE = 'mindmapViewUpgraded';
const META = process.platform === 'darwin' ? 4 : 2; // CDP modifier for Cmd/Ctrl

const args = process.argv.slice(2);
const deploy = !args.includes('--no-deploy');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1].split(',') : null;
const includeSlow = args.includes('--slow');

// ---------------------------------------------------------------------------
// Obsidian CLI wrappers

function cli(cliArgs, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile('obsidian', cliArgs, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`obsidian ${cliArgs[0]} failed: ${err.killed ? 'timeout' : err.message}\n${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// Helpers available as `H` inside every evaluated snippet.
const PAGE_HELPERS = `
const H = {
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  frames: async (n = 2) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); },
  // Poll instead of sleeping a fixed time; returns false on timeout.
  async until(cond, timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try { if (cond()) return true; } catch (e) {}
      await H.wait(50);
    }
    return false;
  },
  view: () => app.workspace.activeLeaf.view,
  mm: () => app.workspace.activeLeaf.view.mindmap,
  nodes: () => { const r = []; const w = (n) => { r.push(n); n.children.forEach(w); }; w(app.workspace.activeLeaf.view.mindmap.root); return r; },
  find: (text) => H.nodes().find((n) => n.data.text === text),
  texts: () => H.nodes().map((n) => n.data.text),
  file: (p) => app.vault.getAbstractFileByPath(p),
  visible: (n) => { const a = n.containEl.getBoundingClientRect(), c = H.mm().containerEL.getBoundingClientRect(); return a.top >= c.top && a.bottom <= c.bottom && a.left >= c.left && a.right <= c.right; },
  select: (n) => { const m = H.mm(); m.clearSelectNode(); n.select(); m.isFocused = true; },
  // Notes are written from outside Obsidian; wait until the vault has indexed
  // the frontmatter, otherwise the file opens as plain Markdown.
  async indexed(p) {
    for (let i = 0; i < 50; i++) {
      const f = H.file(p);
      if (f && app.metadataCache.getFileCache(f)?.frontmatter?.['mindmap-plugin']) return f;
      await H.wait(100);
    }
    throw new Error('not indexed: ' + p);
  },
  async open(p) {
    await H.indexed(p);
    const leaf = app.workspace.getLeaf('tab');
    await leaf.openFile(H.file(p));
    app.workspace.setActiveLeaf(leaf, { focus: true });
    const v = leaf.view;
    if (v.getViewType() === 'mindmapViewUpgraded') {
      await H.until(() => v.mindmap && !v.isInitializingMindmap && v.mindmap.appEl.classList.contains('mm-ready'));
    }
    // Let the deferred focus and first layouts settle.
    await H.wait(200);
    await H.frames(2);
    return leaf;
  },
};
`;

async function evalJs(body, timeoutMs = 30000) {
  const code = `(async()=>{${PAGE_HELPERS}\nconst __r = await (async()=>{${body}})();return JSON.stringify(__r === undefined ? null : __r);})()`;
  const out = await cli(['eval', `code=${code}`], timeoutMs);
  const line = out.split('\n').find((l) => l.startsWith('=> ') || l.startsWith('Error'));
  if (!line || line.startsWith('Error')) {
    throw new Error(`eval failed: ${out}`);
  }
  const value = line.slice(3);
  return value === 'null' || value === 'undefined' ? null : JSON.parse(value);
}

async function cdp(method, params) {
  await cli(['dev:cdp', `method=${method}`, `params=${JSON.stringify(params)}`]);
}

async function cdpResult(method, params = {}) {
  return JSON.parse(await cli(['dev:cdp', `method=${method}`, `params=${JSON.stringify(params)}`]));
}

// Event listeners on the window, document and body, by type.
async function globalListeners() {
  const counts = {};
  for (const expression of ['window', 'document', 'document.body']) {
    const { result } = await cdpResult('Runtime.evaluate', { expression, objectGroup: 'mmE2e' });
    const { listeners } = await cdpResult('DOMDebugger.getEventListeners', { objectId: result.objectId });
    for (const l of listeners) {
      const key = `${expression}:${l.type}`;
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  await cdpResult('Runtime.releaseObjectGroup', { objectGroup: 'mmE2e' });
  return counts;
}

const KEYS = {
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Enter: 13, Escape: 27, Tab: 9, Delete: 46, Space: 32,
  KeyF: 70, KeyZ: 90, KeyY: 89, KeyA: 65,
};

async function press(code, modifiers = 0) {
  await ensureForeground();
  const key = { Space: ' ', KeyF: 'f', KeyZ: 'z', KeyY: 'y', KeyA: 'a' }[code] || code;
  const base = { key, code, windowsVirtualKeyCode: KEYS[code], modifiers };
  await cdp('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
  await cdp('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  // Focus tracking settles after 100 ms; layouts run in the next frames.
  await evalJs('await H.wait(150); await H.frames(2);');
}

async function typeText(text) {
  await cdp('Input.insertText', { text });
  await sleep(300);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll a condition from the runner side; returns false on timeout.
async function waitFor(check, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await check()) return true; } catch (e) {}
    await sleep(100);
  }
  return false;
}

// Animation frames pause while the window is hidden, which stalls layout.
async function ensureForeground() {
  for (let attempt = 0; attempt < 5; attempt++) {
    // Hidden windows pause animation frames; unfocused windows make editors
    // report no focus, which the text -> map sync relies on.
    const state = await evalJs('return { hidden: document.hidden, focused: document.hasFocus() };');
    if ((!state.hidden && state.focused) || process.platform !== 'darwin') {
      return;
    }
    execFileSync('open', ['-a', 'Obsidian']);
    // With several Obsidian windows open, activating the app may focus another one.
    await evalJs(`require('electron').remote?.getCurrentWindow?.().focus();`).catch(() => {});
    await sleep(1000);
  }
  throw new Error('Obsidian window stays hidden or unfocused; keep it in front while e2e runs');
}

// ---------------------------------------------------------------------------
// Temporary notes

function notePath(name) {
  return `${INBOX}/${PREFIX}${name}.md`;
}

function writeNote(name, body, state = '{"version":2,"collapsed":[]}') {
  const header = state === null
    ? '---\n\nmindmap-plugin: basic\n\n---\n\n'
    : `---\n\nmindmap-plugin: basic\nmindmark-state: ${state}\n\n---\n\n`;
  fs.writeFileSync(path.join(VAULT, notePath(name)), header + body);
  return notePath(name);
}

function readNote(relPath) {
  return fs.readFileSync(path.join(VAULT, relPath), 'utf8');
}

function listTempFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(VAULT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.name.includes(PREFIX)) {
        found.push(rel);
      } else if (entry.isDirectory() && rel.startsWith(INBOX)) {
        walk(rel);
      }
    }
  };
  walk(INBOX);
  return found;
}

// Backup, conflict and recovery copies are Mapdown's data-safety fallbacks;
// a scenario that produces one has hit an unexpected save path.
function safetyCopies() {
  return listTempFiles().filter((rel) => / Mapdown (backup|conflict|recovered) /.test(rel));
}

async function cleanup() {
  try {
    await evalJs(`
      for (const type of ['markdown', '${VIEW_TYPE}']) {
        app.workspace.getLeavesOfType(type)
          .filter((l) => l.view.file?.path?.includes('${PREFIX}'))
          .forEach((l) => l.detach());
      }
    `);
  } catch (err) {
    console.warn('cleanup: could not detach leaves:', err.message);
  }
  await sleep(500);
  // Delete files before folders so nested temp folders can be removed.
  const paths = listTempFiles().sort((a, b) => b.length - a.length);
  for (const rel of paths) {
    fs.rmSync(path.join(VAULT, rel), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Assertions

class AssertionFailure extends Error {}

function expect(condition, message, detail) {
  if (!condition) {
    throw new AssertionFailure(`${message}${detail === undefined ? '' : `\n      got: ${JSON.stringify(detail)}`}`);
  }
}

// ---------------------------------------------------------------------------
// Scenarios. Each runs on its own temporary note(s).

const scenarios = [];
// Slow scenarios run only with --slow or when named in --only.
function scenario(name, run, options = {}) {
  scenarios.push({ name, run, slow: Boolean(options.slow) });
}

scenario('smoke', async () => {
  const p = writeNote('smoke', '# Root\n\n## A\n\n### A1\n\n## B\n');
  const r = await evalJs(`
    const leaf = await H.open('${p}');
    return {
      type: leaf.view.getViewType(),
      nodes: leaf.view.contentEl.querySelectorAll('.mm-node').length,
      paths: leaf.view.contentEl.querySelectorAll('svg path').length,
    };
  `);
  expect(r.type === VIEW_TYPE, 'opens in mind map view', r);
  expect(r.nodes === 4, 'renders every node', r);
  expect(r.paths > 0, 'draws edges', r);
});

scenario('arrow-history', async () => {
  const p = writeNote('arrow', '# Root\n\n## A\n\n### A1\n\n## B\n');
  await evalJs(`await H.open('${p}'); H.select(H.find('A'));`);
  await press('ArrowRight');
  await press('ArrowRight');
  let r = await evalJs(`return { sel: H.mm().selectNode.data.text, undos: H.mm().exec.history.undos.length };`);
  expect(r.sel === 'A1' && r.undos === 0, 'arrow keys on expanded nodes and leaves add no history', r);

  await evalJs(`const a = H.find('A'); H.mm().clearSelectNode(); a.collapse(); H.mm().refresh(); H.select(a);`);
  await press('ArrowRight');
  r = await evalJs(`return { sel: H.mm().selectNode.data.text, undos: H.mm().exec.history.undos.length, expanded: H.find('A').isExpand };`);
  expect(r.expanded && r.undos === 1 && r.sel === 'A1', 'arrow on a collapsed node expands it once', r);
});

scenario('reveal-on-arrow', async () => {
  const body = '# Root\n\n' + Array.from({ length: 40 }, (_, i) => `## N${i + 1}\n`).join('\n');
  const p = writeNote('reveal', body);
  await evalJs(`await H.open('${p}'); H.select(H.find('N20'));`);
  // Scroll the selection off-screen, then navigate.
  await evalJs(`H.mm().containerEL.scrollTop += 1500;`);
  const trace = [];
  for (const key of ['ArrowUp', 'ArrowDown']) {
    await press(key);
    trace.push(await evalJs(`await H.wait(300); return { key: '${key}', sel: H.mm().selectNode.data.text, visible: H.visible(H.mm().selectNode), focused: H.mm().isFocused, active: document.activeElement === H.mm().selectNode.containEl, hidden: document.hidden, st: Math.round(H.mm().containerEL.scrollTop) };`));
  }
  const r = { ...trace[trace.length - 1], trace };
  expect(r.visible, 'keyboard navigation scrolls the new selection into view', r);
});

scenario('undo-while-editing', async () => {
  const p = writeNote('undo', '# Root\n\n## B\n');
  await evalJs(`await H.open('${p}'); H.select(H.find('B'));`);
  await press('Tab');
  await sleep(500);
  await typeText('abc');
  const before = await evalJs(`return H.mm().exec.history.undos.length;`);
  await press('KeyZ', META);
  const r = await evalJs(`return { editing: !!H.mm().editNode?.data.isEdit, kids: H.find('B').children.length, undos: H.mm().exec.history.undos.length };`);
  expect(r.editing && r.kids === 1 && r.undos === before, 'Cmd+Z while editing leaves the node and history alone', r);
  await press('Escape');
});

scenario('suggest-escape', async () => {
  const p = writeNote('suggest', '# Root\n\n## B\n');
  await evalJs(`await H.open('${p}'); H.select(H.find('B'));`);
  await press('Space');
  await typeText(' [[');
  await sleep(500);
  let r = await evalJs(`return { open: !!H.mm().fileSuggest?.isOpen };`);
  expect(r.open, 'typing [[ opens the file suggestion', r);
  await press('Escape');
  r = await evalJs(`return { open: !!H.mm().fileSuggest?.isOpen, editing: !!H.mm().editNode?.data.isEdit, text: H.mm().editNode?.contentEl.innerText };`);
  expect(!r.open && r.editing && r.text.endsWith('[['), 'Esc closes the suggestion and keeps the edit', r);
  await press('Escape');
});

scenario('replace-previous-text', async () => {
  const p = writeNote('replace', '# Root\n\n## B\n');
  await evalJs(`
    await H.open('${p}');
    const b = H.find('B');
    H.select(b);
    b.edit();
    b.contentEl.innerText = 'B2';
    H.mm().clearSelectNode();
    await H.wait(500);
    H.select(H.find('B2'));
  `);
  await cli(['command', 'id=mapdown:Replace by the previous text']);
  await sleep(600);
  let r = await evalJs(`return { b: !!H.find('B'), b2: !!H.find('B2') };`);
  expect(r.b && !r.b2, 'command restores the text before the last edit', r);
  await press('KeyZ', META);
  r = await evalJs(`await H.wait(1500); return { b2: !!H.find('B2') };`);
  expect(r.b2, 'the restore is undoable', r);
  expect(readNote(p).includes('## B2'), 'the result is saved to disk');
});

scenario('unsupported-state', async () => {
  const p = writeNote('badstate', '# Bad\n\n## X\n', '{"version":3,"collapsed":[]}');
  const original = readNote(p);
  const r = await evalJs(`
    await H.indexed('${p}');
    const leaf = app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: '${VIEW_TYPE}', state: { file: '${p}' } });
    await H.wait(1500);
    return { type: leaf.view.getViewType() };
  `);
  expect(r.type === 'markdown', 'unwritable mindmark-state falls back to Markdown', r);
  expect(readNote(p) === original, 'the file is left untouched');
});

scenario('focus-delete', async () => {
  const p = writeNote('focus', '# Root\n\n## A\n\n### A1\n\n## B\n');
  await evalJs(`await H.open('${p}'); H.select(H.find('A'));`);
  await press('KeyF');
  let r = await evalJs(`return { focused: H.mm().focusedNode?.data.text };`);
  expect(r.focused === 'A', 'F enters focus mode', r);
  await press('Delete');
  r = await evalJs(`
    await H.wait(500);
    const m = H.mm();
    return { focused: m.focusedNode?.data.text || null, dimmed: m.contentEL.querySelectorAll('.mm-node-dimmed').length, isFocused: m.isFocused };
  `);
  expect(!r.focused && r.dimmed === 0 && r.isFocused, 'deleting the focused node leaves focus mode and keeps keyboard focus', r);
  await press('KeyZ', META);
  r = await evalJs(`await H.wait(500); return { a: !!H.find('A') };`);
  expect(r.a, 'undo restores the deleted node', r);
});

scenario('undo-restores-collapse', async () => {
  const p = writeNote('undocollapse', '# Root\n\n## P ^p1\n\n- P child\n\n## Q\n\n## S\n', '{"version":2,"collapsed":["p1"]}');
  const STATE = `const m = H.mm(); const P = H.find('P'); return { collapsed: !P.isExpand, childShown: H.find('P child').isShow(), children: P.children.length };`;
  await evalJs(`await H.open('${p}'); H.select(H.find('P'));`);
  let r = await evalJs(STATE);
  expect(r.collapsed && !r.childShown, 'P starts collapsed', r);

  // Tab adds a child to the collapsed node: undo must collapse it again.
  await press('Tab');
  await sleep(500);
  r = await evalJs(`H.mm().clearSelectNode(); await H.wait(300); ${STATE}`);
  expect(!r.collapsed && r.children === 2, 'Tab opens P and adds a child', r);
  r = await evalJs(`H.mm().undo(); await H.wait(400); ${STATE}`);
  expect(r.collapsed && !r.childShown && r.children === 1, 'undo removes the child and collapses P again', r);
  r = await evalJs(`H.mm().redo(); await H.wait(400); H.mm().clearSelectNode(); ${STATE}`);
  expect(!r.collapsed && r.children === 2, 'redo opens P again', r);
  await evalJs(`H.mm().undo(); await H.wait(400);`);

  // Paste into the collapsed node.
  r = await evalJs(`
    const m = H.mm();
    const json = m.copyNode(H.find('Q'));
    H.select(H.find('P'));
    m.pasteNode(typeof json === 'string' ? json : JSON.stringify(json));
    await H.wait(400);
    const opened = H.find('P').isExpand && H.find('P').children.length === 2;
    m.undo();
    await H.wait(400);
    return { opened, ...(() => { ${STATE} })() };
  `);
  expect(r.opened && r.collapsed && r.children === 1, 'undoing a paste into a collapsed node collapses it again', r);

  // Dropping beside a collapsed node opens it; undo closes it.
  r = await evalJs(`
    const m = H.mm();
    m.moveNode(H.find('S'), H.find('P'), 'right');
    await H.wait(400);
    const opened = H.find('P').isExpand;
    m.undo();
    await H.wait(400);
    return { opened, sParent: H.find('S').parent.data.text, ...(() => { ${STATE} })() };
  `);
  expect(r.opened && r.collapsed && r.sParent === 'Root', 'undoing a drop beside a collapsed node collapses it again', r);
});

scenario('paste-redo', async () => {
  const p = writeNote('paste', '# Root\n\n## Src\n\n### Leaf\n\n## Dst\n');
  const r = await evalJs(`
    await H.open('${p}');
    const m = H.mm();
    const json = m.copyNode(H.find('Src'));
    H.select(H.find('Dst'));
    m.pasteNode(typeof json === 'string' ? json : JSON.stringify(json));
    await H.wait(800);
    const kids = () => H.find('Dst').children.map((c) => c.data.text + '[' + c.children.map((x) => x.data.text).join(',') + ']').join(' ');
    const trace = ['paste ' + kids()];
    const pasted = H.find('Dst').children[0];
    H.select(pasted);
    m.execute('addChildNode', { parent: pasted });
    await H.wait(800);
    trace.push('add ' + kids());
    m.clearSelectNode();
    m.undo(); m.undo();
    await H.wait(500);
    const stacks = () => ' undos=' + m.exec.history.undos.map((c) => c.name) + ' redos=' + m.exec.history.redos.map((c) => c.name);
    trace.push('undo ' + kids() + stacks());
    m.redo();
    trace.push('redo1 ' + kids() + stacks());
    m.redo();
    trace.push('redo2 ' + kids() + stacks());
    await H.wait(800);
    trace.push('redo ' + kids() + stacks());
    const all = H.nodes();
    const orphans = [...m.contentEL.querySelectorAll('.mm-node')].filter((e) => !all.some((n) => n.containEl === e)).length;
    return { kids: H.find('Dst').children[0].children.length, orphans, trace };
  `);
  expect(r.kids === 2 && r.orphans === 0, 'redo re-attaches the pasted subtree without orphans', r);
});

scenario('search-layout', async () => {
  const p = writeNote('search', '# Root\n\n## Branch ^b1\n\n### Zeta\n', '{"version":2,"collapsed":["b1"]}');
  const r = await evalJs(`
    await H.open('${p}');
    const m = H.mm();
    const hiddenBefore = !H.find('Zeta').isShow();
    m.openSearch();
    m.searchInput.value = 'Zeta';
    m.searchInput.dispatchEvent(new Event('input'));
    await H.wait(600);
    m.navigateSearch(1);
    await H.wait(800);
    const z = H.find('Zeta'), b = H.find('Branch');
    const during = {
      shown: z.isShow(),
      laidOut: z.getPosition().x > b.getPosition().x,
      edge: Object.keys(m.mmLayout.pathMap).some((k) => k.includes(z.getId())),
      stillCollapsed: !b.isExpand,
    };
    m.closeSearch();
    await H.wait(600);
    return { hiddenBefore, during, hiddenAfter: !z.isShow() };
  `);
  expect(r.hiddenBefore, 'collapsed child starts hidden', r);
  expect(r.during.shown && r.during.laidOut && r.during.edge && r.during.stillCollapsed,
    'search reveals, lays out and connects the match without saving the expansion', r);
  expect(r.hiddenAfter, 'closing search restores the collapse', r);
});

scenario('new-map', async () => {
  const r = await evalJs(`
    const before = new Set(app.vault.getFiles().map((f) => f.path));
    await app.plugins.plugins.mapdown.newMindMap(H.file('${INBOX}'));
    await H.until(() => H.mm()?.editNode?.data.isEdit, 6000);
    const m = H.mm();
    const editing = m.editNode;
    editing.contentEl.innerText = '${PREFIX}newmap';
    m.clearSelectNode();
    await H.until(() => H.file('${notePath('newmap')}') && !H.view().pendingSave && !H.view().hasUnprotectedChanges(), 8000);
    await H.wait(300);
    return { created: app.vault.getFiles().map((f) => f.path).filter((x) => !before.has(x)), rootExpanded: m.root.isExpand };
  `);
  expect(r.created.length === 1 && r.created[0] === notePath('newmap'),
    'first edit renames the new map and creates no backup', r);
  expect(r.rootExpanded, 'new root starts expanded', r);
  expect(readNote(notePath('newmap')).includes('"collapsed":[]'), 'nothing is saved as collapsed');
});

scenario('file-mode-per-file', async () => {
  const a = writeNote('mode_a', '# A\n\n## x\n');
  const b = writeNote('mode_b', '# B\n\n## y\n');
  const r = await evalJs(`
    const p = app.plugins.plugins.mapdown;
    await H.indexed('${b}');
    const leaf = await H.open('${a}');
    await p.setMarkdownView(leaf);
    await H.wait(500);
    await leaf.openFile(H.file('${b}'));
    await H.wait(1200);
    const other = leaf.view.getViewType();
    await leaf.openFile(H.file('${a}'));
    await H.wait(1200);
    return { other, again: leaf.view.getViewType() };
  `);
  expect(r.other === VIEW_TYPE && r.again === 'markdown', 'Markdown mode is remembered per file, not per tab', r);
});

scenario('external-edit-during-save', async () => {
  const p = writeNote('external', '# Root\n\n## child\n');
  const r = await evalJs(`
    await H.open('${p}');
    const v = H.view();
    const f = H.file('${p}');
    const orig = v.syncFilenameWithRootTitle.bind(v);
    let fired = false;
    v.syncFilenameWithRootTitle = async (s) => {
      if (!fired) {
        fired = true;
        const disk = await app.vault.read(f);
        await app.vault.modify(f, disk.trimEnd() + '\\n\\n## external\\n');
        await H.wait(800);
      }
      return orig(s);
    };
    const child = H.find('child');
    H.mm().execute('changeNodeText', { node: child, text: 'local', oldText: 'child' });
    await H.until(() => fired && H.texts().includes('local') && H.texts().includes('external') && !v.pendingSave && !v.hasUnprotectedChanges(), 8000);
    await H.wait(300);
    v.syncFilenameWithRootTitle = orig;
    return { fired, texts: H.texts() };
  `);
  expect(r.fired, 'external edit was injected mid-save', r);
  expect(r.texts.includes('local') && r.texts.includes('external'), 'view shows both the local and the external edit', r);
  const disk = readNote(p);
  expect(disk.includes('## local') && disk.includes('## external'), 'disk keeps both edits');
});

scenario('rename-sync', async () => {
  const p = writeNote('rename', '# Root\n\n## child\n');
  const dir = `${INBOX}/${PREFIX}dir`;
  const moved = `${dir}/${PREFIX}renamed.md`;
  const r = await evalJs(`
    if (!H.file('${dir}')) await app.vault.createFolder('${dir}');
    const leaf = await H.open('${p}');
    await app.fileManager.renameFile(H.file('${p}'), '${moved}');
    await H.wait(800);
    const v = leaf.view;
    return { file: v.file.path, mm: v.mindmap.path, bound: v.boundFilePath };
  `);
  expect(r.file === moved && r.mm === moved && r.bound === moved, 'view paths follow a move', r);
});

scenario('wheel-zoom-scope', async () => {
  const p = writeNote('wheel', '# Root\n\n## child\n');
  const rect = await evalJs(`
    await H.open('${p}');
    const r = H.mm().containerEL.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  `);
  const wheel = async (x, y) => {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: -120, modifiers: META });
    await sleep(300);
  };
  const start = await evalJs(`return H.mm().mindScale;`);
  await wheel(Math.max(5, rect.left - 100), rect.top + rect.height / 2);
  const outside = await evalJs(`return H.mm().mindScale;`);
  await wheel(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const inside = await evalJs(`return H.mm().mindScale;`);
  expect(outside === start, 'Ctrl+wheel outside the map does not zoom it', { start, outside });
  expect(inside > start, 'Ctrl+wheel over the map zooms it', { start, inside });
});

scenario('open-keyboard', async () => {
  const p = writeNote('openkb', '# Root\n\n## A\n');
  // No H.select: keyboard shortcuts must work right after opening.
  await evalJs(`await H.open('${p}'); await H.wait(300);`);
  await press('Tab');
  const r = await evalJs(`await H.wait(400); return { kids: H.mm().root.children.length, editing: !!H.mm().editNode?.data.isEdit };`);
  expect(r.kids === 2 && r.editing, 'Tab adds a child right after opening the map', r);
  await press('Escape');
});

// Opens the map in a tab and the same file as Markdown in a split, with the
// editor focused and the cursor at the end.
async function openSplit(p) {
  await evalJs(`
    const leaf = await H.open('${p}');
    window.__mmE2eMap = leaf;
    const md = app.workspace.getLeaf('split', 'vertical');
    app.plugins.plugins.mapdown.setFileMode(md, '${p}', 'markdown');
    await md.openFile(H.file('${p}'), { active: true });
    await H.until(() => md.view.getViewType() === 'markdown' && md.view.file?.path === '${p}' && md.view.editor);
    await H.wait(300);
    window.__mmE2eMd = md;
    const e = md.view.editor;
    e.focus();
    const last = e.lineCount() - 1;
    e.setCursor({ line: last, ch: e.getLine(last).length });
    await H.wait(300);
  `);
}

const SPLIT_STATE = `
  const map = window.__mmE2eMap.view, e = window.__mmE2eMd.view.editor;
  const texts = []; const w = (n) => { texts.push(n.data.text); n.children.forEach(w); }; w(map.mindmap.root);
`;

scenario('split-typing-keeps-focus', async () => {
  const p = writeNote('splitfocus', '# Root\n\n## A\n\n## B\n');
  await openSplit(p);
  await typeText('x');
  await sleep(1500);
  let r = await evalJs(`${SPLIT_STATE} return { editorFocus: e.hasFocus(), mapFocused: map.mindmap.isFocused, texts };`);
  expect(r.editorFocus && !r.mapFocused, 'typing in Markdown keeps focus in the editor after the map rebuilds', r);
  await press('Tab');
  await press('Enter');
  await sleep(1200);
  r = await evalJs(`${SPLIT_STATE} return { editorFocus: e.hasFocus(), nodes: texts.length, undos: map.mindmap.exec.history.undos.length };`);
  expect(r.editorFocus && r.undos === 0, 'Tab and Enter typed in Markdown are not handled by the map', r);
});

scenario('split-type-then-map-edit', async () => {
  const p = writeNote('splitedit', '# Root\n\n## A\n\n## B\n');
  await openSplit(p);
  await evalJs(`
    const e = window.__mmE2eMd.view.editor;
    const last = e.lineCount() - 1;
    e.replaceRange('\\n\\n## Typed', { line: last, ch: e.getLine(last).length });
  `);
  // Edit in the map as soon as it shows the typing, before Obsidian autosaves it.
  await evalJs(`
    let map;
    for (let i = 0; i < 40; i++) {
      map = window.__mmE2eMap.view;
      const seen = []; const w = (n) => { seen.push(n.data.text); n.children.forEach(w); }; w(map.mindmap.root);
      if (seen.includes('Typed')) break;
      await H.wait(50);
    }
    const all = []; const walk = (n) => { all.push(n); n.children.forEach(walk); }; walk(map.mindmap.root);
    const a = all.find((n) => n.data.text === 'A');
    map.mindmap.execute('changeNodeText', { node: a, text: 'A edited', oldText: 'A' });
  `);
  await waitFor(() => { const d = readNote(p); return d.includes('## A edited') && d.includes('## Typed'); }, 9000);
  await sleep(300);
  const r = await evalJs(`${SPLIT_STATE} return { texts, editor: e.getValue() };`);
  const disk = readNote(p);
  expect(disk.includes('## A edited') && disk.includes('## Typed'), 'disk keeps both the typed text and the map edit', disk);
  expect(r.texts.includes('A edited') && r.texts.includes('Typed'), 'map shows both edits', r.texts);
  expect(r.editor.includes('## A edited') && r.editor.includes('## Typed'), 'editor shows both edits', r.editor);
});

// Every node's file line must hold that node, after opening, after a map edit,
// and after typing in the Markdown split.
const CHECK_SOURCE_LINES = `
  const checkLines = (view, text) => {
    const lines = text.split('\\n');
    const bad = [];
    const w = (n) => {
      const line = lines[view.getFileLineOfNode(n)] || '';
      const first = n.data.text.split('\\n')[0];
      if (first && !line.includes(first)) bad.push({ node: first, line });
      n.children.forEach(w);
    };
    w(view.mindmap.root);
    return bad;
  };
`;

scenario('source-lines', async () => {
  const p = writeNote('lines', '# Root\n\n## A\n\n- item\n    - sub\n\n## B\n');
  let r = await evalJs(`
    ${CHECK_SOURCE_LINES}
    await H.open('${p}');
    const v = H.view();
    const opened = checkLines(v, await app.vault.read(v.file));
    const m = H.mm();
    m.execute('changeNodeText', { node: H.find('A'), text: 'A renamed', oldText: 'A' });
    H.select(H.find('B'));
    m.execute('addChildNode', { parent: H.find('B') });
    await H.wait(300);
    m.clearSelectNode();
    await H.wait(300);
    await H.until(() => !v.pendingSave && !v.hasUnprotectedChanges(), 6000);
    const disk = await app.vault.read(v.file);
    return { opened, edited: checkLines(v, disk), current: v.isSourceMapCurrent(disk) };
  `);
  expect(r.opened.length === 0, 'node lines match the file after opening', r.opened);
  expect(r.edited.length === 0 && r.current, 'node lines match the file after editing the map', r);

  await openSplit(p);
  await typeText('\n\n## Typed');
  await evalJs(`await H.until(() => { ${SPLIT_STATE} return texts.includes('Typed') && map.isSourceMapCurrent(e.getValue()); }, 6000); await H.wait(200);`);
  r = await evalJs(`
    ${CHECK_SOURCE_LINES}
    const map = window.__mmE2eMap.view, e = window.__mmE2eMd.view.editor;
    const text = e.getValue();
    const typedLine = text.split('\\n').findIndex((l) => l === '## Typed');
    return {
      bad: checkLines(map, text),
      current: map.isSourceMapCurrent(text),
      atTyped: map.getNodeAtFileLine(typedLine)?.data.text,
      inFrontmatter: map.getNodeAtFileLine(1),
    };
  `);
  expect(r.current && r.bad.length === 0, 'node lines match the editor text after typing in Markdown', r);
  expect(r.atTyped === 'Typed', 'cursor line resolves to the node on that line', r);
  expect(r.inFrontmatter === null, 'frontmatter lines resolve to no node', r);
});

// State of the Markdown split relative to the map's selection.
const SYNC_STATE = `
  const map = window.__mmE2eMap.view, md = window.__mmE2eMd.view, e = md.editor, cm = e.cm;
  const sel = map.mindmap.selectNode;
  const nodeLine = map.getFileLineOfNode(sel);
  const cursorLine = e.getCursor().line;
  const lineBox = cm.coordsAtPos(cm.state.doc.line(nodeLine + 1).from);
  const scroller = cm.scrollDOM.getBoundingClientRect();
  const state = {
    sel: sel.data.text,
    nodeLine,
    cursorLine,
    lineVisible: !!lineBox && lineBox.top >= scroller.top && lineBox.bottom <= scroller.bottom,
    flashed: !!cm.contentDOM.querySelector('.mapdown-sync-line'),
    focusInMap: map.containerEl.contains(document.activeElement),
    editorFocused: e.hasFocus(),
  };
`;

function syncNote(name) {
  const body = '# Root\n\n' + Array.from({ length: 30 }, (_, i) => `## N${i + 1}\n\nParagraph ${i + 1}\n`).join('\n');
  return writeNote(name, body);
}

async function focusMap(text) {
  await evalJs(`
    const leaf = window.__mmE2eMap;
    app.workspace.setActiveLeaf(leaf, { focus: true });
    await H.wait(200);
    const m = leaf.view.mindmap;
    const all = []; const w = (n) => { all.push(n); n.children.forEach(w); }; w(m.root);
    m.clearSelectNode();
    all.find((n) => n.data.text === '${text}').select();
    m.isFocused = true;
  `);
}

scenario('sync-map-to-text', async () => {
  const p = syncNote('syncmap');
  await openSplit(p);
  await focusMap('N25');
  await sleep(500);
  let r = await evalJs(`${SYNC_STATE} return state;`);
  expect(r.cursorLine === r.nodeLine && r.lineVisible, 'selecting a node moves the Markdown cursor to its line and scrolls it into view', r);
  expect(r.flashed, 'the line is briefly highlighted', r);
  expect(r.focusInMap && !r.editorFocused, 'focus stays in the map', r);

  await press('ArrowDown');
  await sleep(500);
  r = await evalJs(`${SYNC_STATE} return state;`);
  expect(r.sel !== 'N25' && r.cursorLine === r.nodeLine && r.lineVisible, 'keyboard navigation in the map follows in Markdown', r);

  // A node added in the map is followed once the editor has the saved text.
  await press('Tab');
  await press('Escape');
  r = await evalJs(`
    await H.until(() => { ${SYNC_STATE} return state.cursorLine === state.nodeLine && e.getLine(state.cursorLine).includes(state.sel); }, 6000);
    ${SYNC_STATE} return { ...state, lineText: e.getLine(state.cursorLine) };
  `);
  expect(r.cursorLine === r.nodeLine && r.lineText.includes(r.sel), 'a new node is followed after the editor catches up', r);
});

// Real mouse clicks, not select(): clicks used to assign the selection before
// selecting, which hid the change from the sync.
scenario('sync-map-click', async () => {
  const p = syncNote('syncclick');
  await openSplit(p);
  await focusMap('N2');
  await sleep(500);
  const click = async (text, button = 'left', settle = 700) => {
    const at = await evalJs(`
      const m = window.__mmE2eMap.view.mindmap;
      const all = []; const w = (n) => { all.push(n); n.children.forEach(w); }; w(m.root);
      const node = all.find((n) => n.data.text === '${text}');
      m.centerOnNode(node);
      await H.wait(400);
      const b = node.contentEl.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };`);
    const buttons = button === 'left' ? 1 : 2;
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button, buttons, clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button, buttons: 0, clickCount: 1 });
    await sleep(settle);
  };

  await click('N12', 'left', 0);
  let r = await evalJs(`
    const flashed = await H.until(() => window.__mmE2eMd.view.editor.cm.contentDOM.querySelector('.mapdown-sync-line'), 1500);
    await H.wait(200);
    ${SYNC_STATE} return { ...state, flashed };`);
  expect(r.sel === 'N12' && r.cursorLine === r.nodeLine && r.lineVisible, 'clicking a node moves the Markdown cursor to its line', r);
  expect(r.flashed, 'the clicked node\'s line is highlighted', r);

  // Clicking the node that is already selected does not sync again.
  await evalJs(`
    const view = window.__mmE2eMap.view;
    window.__mmE2eSyncs = 0;
    const original = view.onMapSelectionChanged;
    view.onMapSelectionChanged = function () { window.__mmE2eSyncs++; return original.call(this); };
    window.__mmE2eRestoreSync = () => { view.onMapSelectionChanged = original; };`);
  await click('N12');
  r = await evalJs(`const syncs = window.__mmE2eSyncs; window.__mmE2eRestoreSync(); return { syncs, sel: window.__mmE2eMap.view.mindmap.selectNode.data.text };`);
  expect(r.sel === 'N12' && r.syncs === 0, 'clicking the selected node again does not sync again', r);

  await click('N20', 'right');
  r = await evalJs(`${SYNC_STATE} const menu = window.__mmE2eMap.view.mindmap._menuDom.style.display; window.__mmE2eMap.view.mindmap._menuDom.style.display = 'none'; return { ...state, menu };`);
  expect(r.sel === 'N20' && r.menu === 'flex' && r.cursorLine === r.nodeLine, 'right-clicking a node selects it and syncs', r);
});

scenario('sync-map-to-text-modes', async () => {
  const p = syncNote('syncmodes');
  await openSplit(p);

  // Reading mode: scroll to the line.
  await evalJs(`
    const md = window.__mmE2eMd;
    await md.setViewState({ type: 'markdown', state: { ...md.view.getState(), mode: 'preview' } });
    await H.wait(800);
  `);
  await focusMap('N28');
  await sleep(800);
  let r = await evalJs(`
    const map = window.__mmE2eMap.view, md = window.__mmE2eMd.view;
    // The reading view reports no scroll until it has rendered.
    for (let i = 0; i < 20 && md.currentMode.getScroll() == null; i++) await H.wait(100);
    return { mode: md.getMode(), scroll: md.currentMode.getScroll(), nodeLine: map.getFileLineOfNode(map.mindmap.selectNode) };
  `);
  expect(r.mode === 'preview' && Math.abs(r.scroll - r.nodeLine) <= 3, 'reading mode scrolls to the node line', r);

  // Disabled: nothing moves.
  await evalJs(`
    const md = window.__mmE2eMd;
    await md.setViewState({ type: 'markdown', state: { ...md.view.getState(), mode: 'source' } });
    await H.wait(800);
    const e = md.view.editor;
    e.setCursor({ line: e.lineCount() - 1, ch: 0 });
    await H.wait(500);
    app.plugins.plugins.mapdown.settings.syncSelection = false;
  `);
  try {
    const before = await evalJs(`return window.__mmE2eMd.view.editor.getCursor().line;`);
    await focusMap('N10');
    await sleep(500);
    r = await evalJs(`return { cursorLine: window.__mmE2eMd.view.editor.getCursor().line };`);
    expect(r.cursorLine === before, 'with sync turned off the Markdown cursor stays put', { before, ...r });
  } finally {
    await evalJs(`app.plugins.plugins.mapdown.settings.syncSelection = true;`);
  }
});

scenario('sync-text-to-map', async () => {
  const body = '# Root\n\n' +
    Array.from({ length: 12 }, (_, i) => `## N${i + 1}\n\nParagraph ${i + 1}\n`).join('\n') +
    '\n## Folded ^f1\n\n### Hidden\n';
  const p = writeNote('synctext', body, '{"version":2,"collapsed":["f1"]}');
  await openSplit(p);

  const cursorTo = async (text, ch = 2) => { await ensureForeground(); return evalJs(`
    const e = window.__mmE2eMd.view.editor;
    const line = e.getValue().split('\\n').findIndex((l) => l === ${JSON.stringify(text)});
    e.setCursor({ line, ch: ${ch} });
    await H.wait(400);
  `); };
  const STATE = `
    const map = window.__mmE2eMap.view, e = window.__mmE2eMd.view.editor;
    const sel = map.mindmap.selectNode;
    const a = sel.containEl.getBoundingClientRect(), c = map.mindmap.containerEL.getBoundingClientRect();
    return {
      sel: sel.data.text,
      visible: a.top >= c.top && a.bottom <= c.bottom && a.left >= c.left && a.right <= c.right,
      editorFocused: e.hasFocus(),
      mapFocused: map.mindmap.isFocused,
      cursor: e.getCursor(),
    };
  `;

  await cursorTo('## N9');
  let r = await evalJs(STATE);
  expect(r.sel === 'N9' && r.visible, 'cursor on a heading selects that node and reveals it', r);
  expect(r.editorFocused && !r.mapFocused, 'focus stays in the editor', r);
  expect(r.cursor.ch === 2, 'map selection does not echo back and move the cursor', r);

  await cursorTo('Paragraph 4', 5);
  r = await evalJs(STATE);
  expect(r.sel === 'Paragraph 4', 'a paragraph line selects its own node', r);

  await cursorTo('## N7', 0);
  for (let i = 0; i < 4; i++) {
    await press('ArrowDown');
  }
  r = await evalJs(STATE);
  expect(r.sel === 'N8' && r.editorFocused, 'arrow keys in the editor move the map selection', r);

  await cursorTo('### Hidden');
  r = await evalJs(`${STATE.replace('return {', 'return { foldedCollapsed: !window.__mmE2eMap.view.mindmap.root.children.find((n) => n.data.text === "Folded").isExpand,')}`);
  expect(r.sel === 'Folded' && r.foldedCollapsed, 'a hidden node resolves to its visible ancestor without expanding it', r);

  await evalJs(`window.__mmE2eMd.view.editor.setCursor({ line: 2, ch: 0 }); await H.wait(400);`);
  r = await evalJs(STATE);
  expect(r.sel === 'Folded', 'frontmatter lines leave the selection unchanged', r);
});

const SYNC_PAIR = `
  const map = window.__mmE2eMap.view, e = window.__mmE2eMd.view.editor;
  const pair = () => ({ sel: map.mindmap.selectNode?.data.text, cursor: e.getCursor(), editorFocused: e.hasFocus(), lineText: e.getLine(e.getCursor().line) });
`;

scenario('sync-typing-keeps-selection', async () => {
  const p = syncNote('synctyping');
  await openSplit(p);
  await ensureForeground();
  await evalJs(`
    const e = window.__mmE2eMd.view.editor;
    const line = e.getValue().split('\\n').findIndex((l) => l === '## N5');
    e.setCursor({ line, ch: 5 });
    await H.wait(400);
  `);
  let r = await evalJs(`${SYNC_PAIR} return pair();`);
  expect(r.sel === 'N5', 'cursor on N5 selects it', r);
  const startLine = r.cursor.line;

  // Type a character at a time; the cursor must never be moved by the sync.
  const samples = [];
  for (const ch of ' edit') {
    await typeText(ch);
    await sleep(250);
    samples.push(await evalJs(`${SYNC_PAIR} return pair();`));
  }
  expect(samples.every((s) => s.cursor.line === startLine && s.editorFocused), 'typing keeps the cursor on its line and focus in the editor', samples);
  await evalJs(`await H.until(() => { ${SYNC_PAIR} return pair().sel === 'N5 edit'; }, 6000); await H.wait(200);`);
  r = await evalJs(`${SYNC_PAIR} return pair();`);
  expect(r.sel === 'N5 edit' && r.cursor.ch === 10, 'after the map rebuilds it still selects the node being typed', r);

  // A heading typed on a new line becomes the selected node.
  await press('Enter');
  await press('Enter');
  await typeText('## Fresh');
  await evalJs(`await H.until(() => { ${SYNC_PAIR} return pair().sel === 'Fresh'; }, 6000); await H.wait(200);`);
  r = await evalJs(`${SYNC_PAIR} return pair();`);
  expect(r.sel === 'Fresh' && r.editorFocused, 'a newly typed heading is selected in the map', r);
});

scenario('sync-no-ping-pong', async () => {
  const p = syncNote('syncpingpong');
  await openSplit(p);
  await ensureForeground();
  // Select in the map, then move to the editor before the delayed sync runs.
  await evalJs(`
    const mapLeaf = window.__mmE2eMap, mdLeaf = window.__mmE2eMd;
    app.workspace.setActiveLeaf(mapLeaf, { focus: true });
    const m = mapLeaf.view.mindmap;
    const all = []; const w = (n) => { all.push(n); n.children.forEach(w); }; w(m.root);
    m.clearSelectNode();
    all.find((n) => n.data.text === 'N20').select();
    app.workspace.setActiveLeaf(mdLeaf, { focus: true });
    const e = mdLeaf.view.editor;
    e.focus();
    const line = e.getValue().split('\\n').findIndex((l) => l === 'Paragraph 3');
    e.setCursor({ line, ch: 4 });
  `);
  const samples = [];
  for (let i = 0; i < 5; i++) {
    await sleep(300);
    samples.push(await evalJs(`${SYNC_PAIR} return pair();`));
  }
  expect(samples.every((s) => s.lineText === 'Paragraph 3' && s.cursor.ch === 4),
    'a pending map selection never pulls the cursor away from where the user clicked', samples);
  expect(samples.every((s) => s.sel === 'Paragraph 3'), 'the map settles on the node at the cursor and stays there', samples);
});

scenario('sync-focus-and-toggle', async () => {
  const p = writeNote('syncfocus', '# Root\n\n## A\n\n### A1\n\n### A2\n\n## B\n\n### B1\n');
  await openSplit(p);
  const cursorTo = async (text) => { await ensureForeground(); return evalJs(`
    const e = window.__mmE2eMd.view.editor;
    e.focus();
    const line = e.getValue().split('\\n').findIndex((l) => l === ${JSON.stringify(text)});
    e.setCursor({ line, ch: 2 });
    await H.wait(400);
  `); };
  const STATE = `
    const map = window.__mmE2eMap.view, e = window.__mmE2eMd.view.editor;
    return { sel: map.mindmap.selectNode?.data.text, focused: map.mindmap.focusedNode?.data.text || null, cursorLine: e.getCursor().line, lineText: e.getLine(e.getCursor().line) };
  `;

  // Focus mode: lines outside the focused branch leave the map alone.
  await focusMap('A');
  await press('KeyF');
  let r = await evalJs(STATE);
  expect(r.focused === 'A', 'F enters focus mode on A', r);
  await cursorTo('### A2');
  r = await evalJs(STATE);
  expect(r.sel === 'A2' && r.focused === 'A', 'a line inside the focused branch selects its node', r);
  await cursorTo('### B1');
  r = await evalJs(STATE);
  expect(r.sel === 'A2' && r.focused === 'A', 'a line outside the focused branch keeps the selection and focus mode', r);
  await evalJs(`window.__mmE2eMap.view.mindmap.exitFocusMode(); await H.wait(300);`);

  // The command turns sync off; both directions are then independent.
  const command = async () => evalJs(`
    app.commands.executeCommandById('mapdown:toggle-selection-sync');
    await H.wait(300);
    const plugin = app.plugins.plugins.mapdown;
    return { setting: plugin.settings.syncSelection, saved: (await plugin.loadData()).syncSelection };
  `);
  try {
    r = await command();
    expect(r.setting === false && r.saved === false, 'the command turns sync off and saves it', r);
    await cursorTo('### B1');
    r = await evalJs(STATE);
    expect(r.sel !== 'B1', 'with sync off the Markdown cursor does not select in the map', r);
    await focusMap('A1');
    await sleep(500);
    r = await evalJs(STATE);
    expect(r.lineText === '### B1', 'with sync off map selection does not move the Markdown cursor', r);
    r = await command();
    expect(r.setting === true && r.saved === true, 'running the command again turns sync back on', r);
    await cursorTo('## B');
    r = await evalJs(STATE);
    expect(r.sel === 'B', 'sync works again after turning it back on', r);
  } finally {
    await evalJs(`
      const plugin = app.plugins.plugins.mapdown;
      if (!plugin.settings.syncSelection) { plugin.settings.syncSelection = true; await plugin.saveSettings(); }
    `);
  }
});

scenario('patch-in-place', async () => {
  const p = writeNote('patch', '# Root\n\n## A\n\n- a1\n- a2\n\n## B ^b1\n\n- b1 child\n\n## C\n\n- c1\n', '{"version":2,"collapsed":["b1"]}');
  await openSplit(p);
  // Mark every element so a rebuild (new elements) is detectable.
  const MARK = `
    const map = window.__mmE2eMap.view, e = window.__mmE2eMd.view.editor;
    const nodes = []; const w = (n) => { nodes.push(n); n.children.forEach(w); }; w(map.mindmap.root);
    const byText = (t) => nodes.find((n) => n.data.text === t);
  `;
  await evalJs(`${MARK} window.__mmE2eMind = map.mindmap; nodes.forEach((n) => n.containEl.__mmKeep = n.data.text);`);
  await ensureForeground();
  await evalJs(`
    const e = window.__mmE2eMd.view.editor;
    const line = e.getValue().split('\\n').findIndex((l) => l === '- a1');
    e.focus();
    e.setCursor({ line, ch: 4 });
    await H.wait(400);
  `);
  await typeText(' typed');
  await sleep(1200);
  let r = await evalJs(`${MARK}
    return {
      sameMap: map.mindmap === window.__mmE2eMind,
      kept: nodes.filter((n) => n.containEl.__mmKeep).map((n) => n.data.text),
      sel: map.mindmap.selectNode?.data.text,
      editorFocused: e.hasFocus(),
    };
  `);
  expect(r.sameMap, 'typing updates the existing map instead of rebuilding it', r);
  expect(['Root', 'A', 'a1 typed', 'a2', 'B', 'b1 child', 'C', 'c1'].every((t) => r.kept.includes(t)), 'every node keeps its element, including the edited one', r);
  expect(r.sel === 'a1 typed' && r.editorFocused, 'the edited node stays selected and focus stays in the editor', r);

  // Insert a bullet and delete a heading's child through the editor.
  await evalJs(`
    const e = window.__mmE2eMd.view.editor;
    const lines = e.getValue().split('\\n');
    const a2 = lines.findIndex((l) => l === '- a2');
    e.replaceRange('\\n- a3 new', { line: a2, ch: 4 });
    await H.wait(900);
    const c1 = e.getValue().split('\\n').findIndex((l) => l === '- c1');
    e.replaceRange('', { line: c1 - 1, ch: e.getLine(c1 - 1).length }, { line: c1, ch: 4 });
    await H.wait(900);
  `);
  r = await evalJs(`${MARK}
    const lines = e.getValue().split('\\n');
    return {
      sameMap: map.mindmap === window.__mmE2eMind,
      texts: nodes.map((n) => n.data.text),
      keptA2: !!byText('a2')?.containEl.__mmKeep,
      newHasElement: !!byText('a3 new') && map.mindmap.contentEL.contains(byText('a3 new').containEl),
      removedGone: !map.mindmap.contentEL.querySelector('[data-id]') ? false : ![...map.mindmap.contentEL.querySelectorAll('.mm-node')].some((el) => el.textContent.trim() === 'c1'),
      lines: nodes.filter((n) => !n.data.isRoot).map((n) => ({ t: n.data.text, ok: (lines[map.getFileLineOfNode(n)] || '').includes(n.data.text.replace(/ typed$/, '')) })),
      bCollapsed: !byText('B').isExpand && !byText('b1 child').isShow(),
      edges: map.mindmap.contentEL.querySelectorAll('svg path').length,
    };
  `);
  expect(r.sameMap && r.keptA2 && r.newHasElement && r.removedGone, 'inserted and deleted lines add and remove only those nodes', r);
  expect(r.lines.every((l) => l.ok), 'every node maps to its line after the edits', r);
  expect(r.bCollapsed, 'a collapsed branch stays collapsed', r);
  expect(r.texts.length === 8 && r.edges >= 5, 'the tree and its edges match the text', r);

  // Changing the state metadata still rebuilds, so collapse state follows it.
  await evalJs(`
    const e = window.__mmE2eMd.view.editor;
    e.setValue(e.getValue().replace('"collapsed":["b1"]', '"collapsed":[]'));
    await H.wait(1500);
  `);
  r = await evalJs(`${MARK} return { sameMap: map.mindmap === window.__mmE2eMind, bExpanded: byText('B').isExpand && byText('b1 child').isShow() };`);
  expect(!r.sameMap && r.bExpanded, 'a frontmatter change falls back to a full rebuild', r);
});

// Composition through CDP's IME API: Enter while a candidate is open belongs
// to the input method, not to the map or the search box.
async function composeThenCommit(composing, committed) {
  await ensureForeground();
  await cdp('Input.imeSetComposition', { text: composing, selectionStart: composing.length, selectionEnd: composing.length });
  await sleep(150);
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'Enter', windowsVirtualKeyCode: 229 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(200);
  const during = await evalJs(`const m = H.mm(); return { editing: !!m.editNode?.data.isEdit, composing: m.isComposing, searchFocused: document.activeElement === m.searchInput };`);
  await cdp('Input.insertText', { text: committed });
  await sleep(200);
  return during;
}

scenario('ime-composition', async () => {
  const p = writeNote('ime', '# Root\n\n## Alpha\n\n## 你好 node\n\n## Beta\n');
  await evalJs(`await H.open('${p}'); H.select(H.find('Alpha'));`);
  await press('Space');
  let r = await evalJs(`return { editing: !!H.mm().editNode?.data.isEdit };`);
  expect(r.editing, 'Space starts editing the node', r);
  const during = await composeThenCommit('ni', '你');
  expect(during.editing, 'Enter during composition does not commit the node', during);
  r = await evalJs(`return { editing: !!H.mm().editNode?.data.isEdit, text: H.mm().editNode?.contentEl.innerText };`);
  expect(r.editing && r.text.endsWith('你'), 'the composed text lands in the node and editing continues', r);
  await press('Enter');
  r = await evalJs(`return { editing: !!H.mm().editNode?.data.isEdit, found: !!H.find('Alpha你') };`);
  expect(!r.editing && r.found, 'Enter after composition commits the node', r);

  // Search box: Enter while composing must not jump to a result.
  await evalJs(`const m = H.mm(); H.select(H.find('Beta')); m.openSearch(); await H.wait(200); m.searchInput.focus();`);
  const searchDuring = await composeThenCommit('ni', '你');
  const SEARCH = `const m = H.mm(); const cur = m.currentSearchMatchId ? m.getNodeById(m.currentSearchMatchId)?.data.text : null;`;
  r = await evalJs(`await H.wait(400); ${SEARCH} return { query: m.searchInput.value, cur, searchFocused: document.activeElement === m.searchInput };`);
  expect(searchDuring.searchFocused && r.searchFocused, 'focus stays in the search box while composing', { searchDuring, r });
  expect(r.query === '你' && !r.cur, 'Enter during composition does not navigate to a result', r);
  await press('Enter');
  r = await evalJs(`await H.wait(300); ${SEARCH} m.closeSearch(); return { cur };`);
  expect(!!r.cur && r.cur.includes('你'), 'Enter after composition goes to a match', r);
});

// REG-13: open, type and relayout at 100/500/1000 nodes, plain and rich text.
function benchBody(nodes, rich) {
  const fmt = (i) => rich ? `Item ${i} **bold** [[Note ${i % 7}]] \`code ${i}\`` : `Item ${i} plain text`;
  let body = '# Root\n\n', n = 1;
  for (let a = 1; n < nodes; a++) {
    body += `## ${fmt(n++)}\n\n`;
    for (let b = 1; b <= 6 && n < nodes; b++) {
      body += `### ${fmt(n++)}\n\n`;
      for (let c = 1; c <= 3 && n < nodes; c++) body += `- ${fmt(n++)}\n`;
      body += '\n';
    }
  }
  return body;
}

scenario('perf-benchmark', async () => {
  const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return `${s[Math.floor(s.length / 2)]}/${s[s.length - 1]}`; };
  const rows = [];
  for (const size of [100, 500, 1000]) {
    for (const rich of [false, true]) {
      const p = writeNote(`bench_${size}_${rich ? 'rich' : 'plain'}`, benchBody(size, rich));
      const runs = [];
      for (let run = 0; run < 5; run++) {
        runs.push(await evalJs(`
          await H.indexed('${p}');
          const tasks = [];
          const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => tasks.push(e.duration)));
          po.observe({ type: 'longtask' });
          const t0 = performance.now();
          const leaf = app.workspace.getLeaf('tab');
          await leaf.openFile(H.file('${p}'));
          const v = leaf.view;
          let refreshes = 0;
          await H.until(() => v.mindmap, 10000);
          const orig = v.mindmap.refresh.bind(v.mindmap);
          v.mindmap.refresh = () => { refreshes++; orig(); };
          await H.until(() => !v.isInitializingMindmap && v.mindmap.appEl.classList.contains('mm-ready'), 30000);
          await H.frames(2);
          const open = performance.now() - t0;
          await H.wait(300);
          const openTasks = tasks.splice(0);
          const openRefreshes = refreshes;
          // Typing in a node (in-place update) and a full relayout.
          const t1 = performance.now();
          v.onEditorPreview(v.file, v.data.replace('Item 3 ', 'Item 3 typed '));
          await H.frames(2);
          const type = performance.now() - t1;
          await H.wait(200);
          const typeTasks = tasks.splice(0);
          const t2 = performance.now();
          v.mindmap.refresh();
          await H.frames(1);
          const layout = performance.now() - t2;
          po.disconnect();
          leaf.detach();
          await H.wait(300);
          const sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0));
          return { open: Math.round(open), openLong: openTasks.length, openLongMs: sum(openTasks), openRefreshes,
            type: Math.round(type), typeLongMs: sum(typeTasks), layout: Math.round(layout) };
        `, 120000));
      }
      const col = (k) => stats(runs.map((r) => r[k]));
      rows.push({ nodes: size, kind: rich ? 'rich' : 'plain', 'open ms': col('open'), 'open long tasks': col('openLong'),
        'open long ms': col('openLongMs'), 'open refreshes': col('openRefreshes'), 'type ms': col('type'),
        'type long ms': col('typeLongMs'), 'layout ms': col('layout') });
    }
  }
  console.log('      median/max over 5 runs');
  console.table(rows);
  expect(rows.length === 6, 'benchmark ran for every size and kind', rows);
}, { slow: true });

scenario('popout-window', async () => {
  const p = writeNote('popout', '# Root\n\n## A\n\n## B\n');
  const r = await evalJs(`
    const f = await H.indexed('${p}');
    const leaf = app.workspace.openPopoutLeaf();
    try {
      await leaf.openFile(f);
      const v = leaf.view;
      await H.until(() => v.mindmap && !v.isInitializingMindmap && v.mindmap.appEl.classList.contains('mm-ready'), 8000);
      const doc = v.containerEl.ownerDocument, win = doc.defaultView;
      const all = []; const w = (n) => { all.push(n); n.children.forEach(w); }; w(v.mindmap.root);
      const a = all.find((n) => n.data.text === 'A');
      v.mindmap.clearSelectNode();
      a.select();
      a.edit();
      await H.wait(100);
      const sel = win.getSelection();
      let caretInNode = false;
      if (sel.rangeCount && a.contentEl.contains(sel.anchorNode)) {
        const pre = sel.getRangeAt(0).cloneRange();
        pre.selectNodeContents(a.contentEl);
        pre.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
        caretInNode = sel.isCollapsed && pre.toString().length === a.contentEl.innerText.length;
      }

      // Typing [[ opens the file suggestions in the same window.
      a.contentEl.innerText = 'see [[';
      const range = doc.createRange();
      range.selectNodeContents(a.contentEl);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      a.contentEl.dispatchEvent(new win.Event('input', { bubbles: true }));
      await H.wait(100);
      const box = v.mindmap.fileSuggest.containerEl;
      const suggestInPopout = box.ownerDocument === doc && box.isConnected && box.style.display === 'block';
      v.mindmap.fileSuggest.close();
      a.cancelEdit();
      return { popout: win !== window, caretInNode, suggestInPopout };
    } finally {
      leaf.detach();
      await H.wait(300);
    }
  `);
  expect(r.popout, 'the map opened in a separate window', r);
  expect(r.caretInNode, 'editing a node in a popout puts the caret at the end of that node', r);
  expect(r.suggestInPopout, 'link suggestions open in the popout window', r);
});

scenario('leak-loop', async () => {
  // REG-14: repeat search, collapse, edit and close; nothing may keep growing.
  const p = writeNote('leak', '# Root\n\n## Alpha\n\n- a1\n- a2\n\n## Beta\n\n- b1\n\n## Gamma **bold** [[link]]\n');
  const cycle = async (i) => evalJs(`
    const leaf = await H.open('${p}');
    const m = H.mm();
    m.openSearch();
    m.searchInput.value = 'a';
    m.searchInput.dispatchEvent(new Event('input'));
    await H.wait(200);
    m.closeSearch();
    H.find('Alpha').collapse();
    H.find('Alpha').expand();
    m.execute('changeNodeText', { node: H.find('Beta'), text: 'Beta ${i}', oldText: H.find('Beta').data.text });
    await H.wait(100);
    m.execute('changeNodeText', { node: H.find('Beta ${i}'), text: 'Beta', oldText: 'Beta ${i}' });
    await H.until(() => !leaf.view.pendingSave && !leaf.view.hasUnprotectedChanges(), 6000);
    leaf.detach();
    await H.wait(150);
  `);
  const snapshot = async () => {
    await cdpResult('HeapProfiler.collectGarbage');
    const page = await evalJs(`
      return {
        bodyChildren: document.body.children.length,
        mindmaps: document.querySelectorAll('.mm-mindmap').length,
        panels: document.querySelectorAll('.mm-control-panel').length,
        heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
      };
    `);
    return { ...page, listeners: await globalListeners() };
  };
  for (let i = 0; i < 2; i++) await cycle(i);
  const before = await snapshot();
  for (let i = 2; i < 22; i++) await cycle(i);
  const after = await snapshot();
  const grown = Object.keys(after.listeners).filter((k) => (after.listeners[k] || 0) > (before.listeners[k] || 0))
    .map((k) => `${k}: ${before.listeners[k] || 0} -> ${after.listeners[k]}`);
  console.log(`      heap ${before.heapMB} MB -> ${after.heapMB} MB after 20 cycles`);
  expect(grown.length === 0, 'no global event listeners accumulate', grown);
  expect(after.bodyChildren <= before.bodyChildren && after.mindmaps === before.mindmaps && after.panels === before.panels,
    'no orphaned DOM accumulates', { before, after });
  expect(after.heapMB - before.heapMB < 20, 'heap does not keep growing', { before: before.heapMB, after: after.heapMB });
}, { slow: true });

scenario('pointer-basics', async () => {
  const p = writeNote('pointer', '# Root\n\n## A\n\n## B\n');
  const center = (text) => evalJs(`
    const r = H.find('${text}').containEl.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `);
  const mouse = async (type, x, y, extra = {}) => {
    await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  };
  await evalJs(`await H.open('${p}'); H.mm().clearSelectNode();`);
  await ensureForeground();

  const b = await center('B');
  await mouse('mousePressed', b.x, b.y);
  await mouse('mouseReleased', b.x, b.y);
  await sleep(400);
  let r = await evalJs(`return { sel: H.mm().selectNode?.data.text };`);
  expect(r.sel === 'B', 'clicking a node selects it', r);

  await mouse('mousePressed', b.x, b.y, { clickCount: 2 });
  await mouse('mouseReleased', b.x, b.y, { clickCount: 2 });
  await sleep(400);
  r = await evalJs(`return { editing: !!H.find('B').data.isEdit };`);
  expect(r.editing, 'double-clicking a node edits it', r);
  await press('Escape');

  // Pan from a spot on the bare canvas: not a node and not the control panel.
  const empty = await evalJs(`
    const m = H.mm();
    const c = m.containerEL.getBoundingClientRect();
    for (const fx of [0.15, 0.3, 0.5, 0.7]) {
      for (const fy of [0.85, 0.7, 0.15]) {
        const x = Math.round(c.left + c.width * fx), y = Math.round(c.top + c.height * fy);
        const el = document.elementFromPoint(x, y);
        if (el && m.appEl.contains(el) && !el.closest('.mm-node')) {
          return { x, y, st: m.containerEL.scrollTop };
        }
      }
    }
    return null;
  `);
  expect(empty, 'found an empty canvas point to drag');
  // Left drag on the canvas box-selects and leaves the view where it was.
  await mouse('mousePressed', empty.x, empty.y);
  await mouse('mouseMoved', empty.x - 60, empty.y - 120);
  await mouse('mouseReleased', empty.x - 60, empty.y - 120);
  await sleep(300);
  r = await evalJs(`return { st: H.mm().containerEL.scrollTop, drag: !!H.mm().drag, boxes: document.querySelectorAll('.mm-marquee').length };`);
  expect(r.st === empty.st && !r.drag && r.boxes === 0, 'left-dragging empty canvas box-selects instead of panning', { before: empty.st, ...r });

  // Right and middle drag pan, and releasing after a pan opens no menu.
  for (const [button, buttons] of [['right', 2], ['middle', 4]]) {
    const before = await evalJs(`return H.mm().containerEL.scrollTop;`);
    await mouse('mousePressed', empty.x, empty.y, { button, buttons });
    await mouse('mouseMoved', empty.x - 60, empty.y - 120, { button, buttons });
    await mouse('mouseReleased', empty.x - 60, empty.y - 120, { button, buttons: 0 });
    await sleep(300);
    r = await evalJs(`return { st: H.mm().containerEL.scrollTop, drag: !!H.mm().drag, menu: H.mm()._menuDom.style.display };`);
    expect(r.st !== before && !r.drag && r.menu !== 'flex', `${button}-dragging empty canvas pans and then stops`, { before, ...r });
  }
});

scenario('multi-select', async () => {
  const p = writeNote('multi', '# Root\n\n## A\n\n- A1\n\n## B\n\n- B1\n\n## C\n\n## D\n');
  const center = (text) => evalJs(`
    const r = H.find('${text}').containEl.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `);
  const click = async (text, modifiers = 0) => {
    const c = await center(text);
    const base = { x: c.x, y: c.y, button: 'left', clickCount: 1, modifiers };
    await cdp('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
    await cdp('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
    await sleep(250);
  };
  const SEL = `const m = H.mm(); return {
    sel: m.selectedList().map((n) => n.data.text), primary: m.selectNode?.data.text || null,
    secondary: H.nodes().filter((n) => n.containEl.classList.contains('mm-node-select-secondary')).map((n) => n.data.text),
    ringed: H.nodes().filter((n) => n.containEl.classList.contains('mm-node-select')).length };`;
  // Counts saves of the map to its file.
  const COUNT_SAVES = `const v = H.view(); v.__saves = 0; if (!v.__countSaves) { const save = v.mindMapChange.bind(v); v.mindMapChange = () => { v.__saves++; save(); }; v.__countSaves = true; }`;
  const select = (texts) => `H.select(H.find('${texts[0]}')); ${texts.slice(1).map((t) => `H.find('${t}').addToSelection(true);`).join(' ')}`;
  await evalJs(`await H.open('${p}'); H.mm().clearSelectNode();`);
  await ensureForeground();

  // Cmd/Ctrl+click adds; the last clicked node is primary, the others lighter.
  await click('B');
  await click('D', META);
  let r = await evalJs(SEL);
  expect(r.sel.join() === 'B,D' && r.primary === 'D' && r.secondary.join() === 'B' && r.ringed === 2,
    'Cmd/Ctrl+click adds a node to the selection', r);
  await click('B', META);
  r = await evalJs(SEL);
  expect(r.sel.join() === 'D' && r.primary === 'D' && r.ringed === 1, 'Cmd/Ctrl+click on a selected node removes it', r);

  // Shift+click selects the sibling range; a plain click returns to one node.
  await click('B');
  await click('D', 8);
  r = await evalJs(SEL);
  expect(r.sel.join() === 'B,C,D' && r.primary === 'D', 'Shift+click selects the sibling range', r);
  await click('C');
  r = await evalJs(SEL);
  expect(r.sel.join() === 'C' && r.ringed === 1, 'a plain click inside the selection keeps only that node', r);

  // Esc clears; Cmd/Ctrl+A selects every visible node.
  await press('Escape');
  r = await evalJs(SEL);
  expect(r.sel.length === 0 && r.ringed === 0, 'Esc clears the selection', r);
  await evalJs(`${select(['C'])}`);
  await press('KeyA', META);
  r = await evalJs(SEL);
  expect(r.sel.length === 7 && r.primary === 'C', 'Cmd/Ctrl+A selects every visible node', r);

  // Arrow keys move a single selection from the primary node.
  await evalJs(`${select(['C', 'A'])}`);
  await press('ArrowDown');
  r = await evalJs(SEL);
  expect(r.sel.join() === 'B' && r.ringed === 1, 'an arrow key collapses the selection and moves from the primary', r);

  // Deleting several nodes is one save and one undo step.
  r = await evalJs(`${select(['A1', 'C', 'D'])} ${COUNT_SAVES}`);
  await press('Delete');
  r = await evalJs(`await H.wait(300); return { texts: H.texts(), saves: H.view().__saves, sel: H.mm().selectNode?.data.text };`);
  expect(r.texts.join() === 'Root,A,B,B1' && r.saves === 1, 'Delete removes every selected node with one save', r);
  expect(await waitFor(() => !/## C|- A1/.test(readNote(p))), 'the deletion reaches the file', readNote(p));
  await press('KeyZ', META);
  r = await evalJs(`await H.wait(300); ${SEL.replace('return {', 'return { texts: H.texts(), saves: H.view().__saves,')}`);
  expect(r.texts.join() === 'Root,A,A1,B,B1,C,D' && r.saves === 2, 'one undo restores every deleted node in order', r);
  expect(r.sel.join() === 'A1,C,D' && r.primary === 'D', 'undo restores the selection', r);
  r = await evalJs(`H.mm().redo(); await H.wait(300); return { texts: H.texts(), saves: H.view().__saves };`);
  expect(r.texts.join() === 'Root,A,B,B1' && r.saves === 3, 'redo deletes them again', r);
  await evalJs(`H.mm().undo(); await H.wait(300);`);

  // A selected parent covers its selected child; the root is never deleted.
  await evalJs(`${select(['A', 'A1'])}`);
  await press('Delete');
  r = await evalJs(`await H.wait(300); return { texts: H.texts() };`);
  expect(r.texts.join() === 'Root,B,B1,C,D', 'deleting a parent with its selected child', r);
  await press('KeyZ', META);
  await evalJs(`await H.wait(300); ${select(['C'])}`);
  await press('KeyA', META);
  await press('Delete');
  r = await evalJs(`await H.wait(300); return { texts: H.texts() };`);
  expect(r.texts.join() === 'Root', 'Cmd/Ctrl+A then Delete keeps only the root', r);
  await press('KeyZ', META);
  r = await evalJs(`await H.wait(300); return { texts: H.texts() };`);
  expect(r.texts.join() === 'Root,A,A1,B,B1,C,D', 'undo brings the whole map back', r);

  // Formatting and collapsing apply to every selected node as one step.
  r = await evalJs(`${select(['B', 'C'])} ${COUNT_SAVES}
    app.commands.executeCommandById("mapdown:Bold the node's text");
    await H.wait(300);
    return { b: H.nodes()[3].data.text, c: H.nodes()[5].data.text, saves: H.view().__saves, sel: H.mm().selectedList().length };`);
  expect(r.b === '**B**' && r.c === '**C**' && r.saves === 1 && r.sel === 2, 'bold applies to every selected node', r);
  r = await evalJs(`H.mm().undo(); await H.wait(300); return { texts: H.texts() };`);
  expect(r.texts.join() === 'Root,A,A1,B,B1,C,D', 'one undo removes the bold from both', r);
  r = await evalJs(`${select(['A', 'B'])}
    app.commands.executeCommandById('mapdown:Toggle expand/collapse node');
    await H.wait(400);
    const collapsed = !H.find('A').isExpand && !H.find('B').isExpand && !H.find('A1').isShow();
    const sel = H.mm().selectedList().map((n) => n.data.text).join();
    H.mm().undo();
    await H.wait(400);
    return { collapsed, sel, restored: H.find('A').isExpand && H.find('B').isExpand && H.find('B1').isShow() };`);
  expect(r.collapsed && r.sel === 'A,B' && r.restored, 'collapse applies to every selected node and undoes in one step', r);

  // A modifier click while editing ends the edit instead of extending the selection.
  await evalJs(`${select(['B'])} H.find('B').edit(); H.mm().editNode = H.find('B'); await H.wait(200);`);
  await click('C', META);
  r = await evalJs(`await H.wait(200); return { editing: H.nodes().some((n) => n.data.isEdit), sel: H.mm().selectedList().map((n) => n.data.text).join(), texts: H.texts() };`);
  expect(!r.editing && r.sel === 'C' && r.texts.join() === 'Root,A,A1,B,B1,C,D', 'Cmd/Ctrl+click while editing commits the edit and selects one node', r);
});

scenario('multi-select-move', async () => {
  const p = writeNote('multimove', '# Root\n\n## A\n\n- A1\n\n## B\n\n- B1\n\n## C\n\n## D\n');
  const TREE = `const t = (n) => n.data.text + (n.children.length ? '(' + n.children.map(t).join(' ') + ')' : ''); return t(H.mm().root);`;
  const select = (texts) => `H.select(H.find('${texts[0]}')); ${texts.slice(1).map((t) => `H.find('${t}').addToSelection(true);`).join(' ')}`;
  await evalJs(`await H.open('${p}'); H.mm().clearSelectNode();`);
  await ensureForeground();

  // Copying several nodes pastes every subtree, in order, as one undo step.
  let r = await evalJs(`${select(['A', 'C'])}
    const m = H.mm();
    const json = m.copyNode(m.clipboardNodes());
    H.select(H.find('B1'));
    m.pasteNode(json);
    await H.wait(400);
    const pasted = (() => { ${TREE} })();
    m.undo();
    await H.wait(400);
    return { pasted, undone: (() => { ${TREE} })() };`);
  expect(r.pasted === 'Root(A(A1) B(B1(A(A1) C)) C D)', 'pasting a multiple selection inserts every subtree', r);
  expect(r.undone === 'Root(A(A1) B(B1) C D)', 'one undo removes every pasted subtree', r);

  // Dragging a selected node drags the whole selection.
  const drag = (from, to, type, ctrl = false) => `
    const m = H.mm();
    const src = H.find('${from}').containEl, dst = H.find('${to}').containEl;
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const b = dst.getBoundingClientRect();
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 }));
    m._dragType = '${type}';
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ctrlKey: ${ctrl} }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    await H.wait(400);`;
  r = await evalJs(`${select(['C', 'D'])} ${drag('C', 'A1', 'down')}
    const moved = (() => { ${TREE} })();
    const sel = H.mm().selectedList().map((n) => n.data.text).join();
    H.mm().undo();
    await H.wait(400);
    return { moved, sel, undone: (() => { ${TREE} })() };`);
  expect(r.moved === 'Root(A(A1 C D) B(B1))' && r.sel === 'C,D', 'dropping moves every selected node after the target, in order', r);
  expect(r.undone === 'Root(A(A1) B(B1) C D)', 'one undo moves them all back', r);

  r = await evalJs(`${select(['A1', 'D'])} ${drag('D', 'B', 'child-right')}
    const moved = (() => { ${TREE} })();
    H.mm().undo();
    await H.wait(400);
    return { moved };`);
  expect(r.moved === 'Root(A B(B1 A1 D) C)', 'dropping onto a node makes the selection its children', r);

  r = await evalJs(`${select(['A', 'B'])} ${drag('A', 'A1', 'down')} return { tree: (() => { ${TREE} })() };`);
  expect(r.tree === 'Root(A(A1) B(B1) C D)', 'dropping a selection inside itself changes nothing', r);

  r = await evalJs(`${select(['C', 'D'])} ${drag('C', 'B1', 'down', true)}
    const copied = (() => { ${TREE} })();
    H.mm().undo();
    await H.wait(400);
    return { copied };`);
  expect(r.copied === 'Root(A(A1) B(B1(C D)) C D)', 'Ctrl+drop copies every selected node', r);

  r = await evalJs(`H.select(H.find('A')); ${drag('C', 'D', 'down')} return { tree: (() => { ${TREE} })(), sel: H.mm().selectedList().map((n) => n.data.text).join() };`);
  expect(r.tree === 'Root(A(A1) B(B1) D C)' && r.sel !== 'A', 'dragging an unselected node moves it alone', r);
  await evalJs(`H.mm().undo(); await H.wait(300);`);

  // Dragging on the canvas selects the nodes inside the box.
  const boxSelect = async (texts, modifiers) => {
    const rect = await evalJs(`
      const rs = [${texts.map((t) => `'${t}'`).join(',')}].map((t) => H.find(t).containEl.getBoundingClientRect());
      return { left: Math.min(...rs.map((r) => r.left)) - 12, top: Math.min(...rs.map((r) => r.top)) - 12,
        right: Math.max(...rs.map((r) => r.right)) + 12, bottom: Math.max(...rs.map((r) => r.bottom)) + 12 };`);
    const at = (x, y, type, buttons) => cdp('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons, clickCount: 1, modifiers });
    await at(rect.left, rect.top, 'mousePressed', 1);
    await at((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2, 'mouseMoved', 1);
    await at(rect.right, rect.bottom, 'mouseMoved', 1);
    await at(rect.right, rect.bottom, 'mouseReleased', 0);
    await sleep(300);
    return evalJs(`return { sel: H.mm().selectedList().map((n) => n.data.text).join(), boxes: document.querySelectorAll('.mm-marquee').length };`);
  };
  for (const scale of [100, 50]) {
    await evalJs(`H.mm().clearSelectNode(); H.mm().scale(${scale}); await H.wait(400); H.mm().centerOnNode(H.find('C')); await H.wait(400);`);
    r = await boxSelect(['C', 'D'], 0);
    expect(r.sel === 'C,D' && r.boxes === 0, `dragging on the canvas selects the boxed nodes at ${scale}%`, r);
  }
  await evalJs(`H.mm().scale(100); await H.wait(300); H.select(H.find('A1'));`);
  r = await boxSelect(['C', 'D'], 8);
  expect(r.sel === 'A1,C,D', 'Shift+drag adds the boxed nodes', r);
  await evalJs(`H.select(H.find('B1'));`);
  r = await boxSelect(['C', 'D'], META);
  expect(r.sel === 'B1,C,D', 'Cmd/Ctrl+drag adds the boxed nodes', r);

  // A box that only crosses the nodes selects them too: start on the canvas
  // right of C and end inside D.
  const cross = await evalJs(`
    const c = H.find('C').contentEl.getBoundingClientRect(), d = H.find('D').contentEl.getBoundingClientRect();
    return { x1: Math.max(c.right, d.right) + 20, y1: c.top + c.height / 2, x2: d.left + d.width / 2, y2: d.top + d.height / 2 };`);
  await evalJs(`H.mm().clearSelectNode();`);
  for (const [type, x, y, buttons] of [['mousePressed', cross.x1, cross.y1, 1], ['mouseMoved', cross.x2, cross.y2, 1], ['mouseReleased', cross.x2, cross.y2, 0]]) {
    await cdp('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons, clickCount: 1 });
  }
  await sleep(300);
  r = await evalJs(`return { sel: H.mm().selectedList().map((n) => n.data.text).join() };`);
  expect(r.sel === 'C,D', 'a box crossing nodes selects them without enclosing them', r);
});

// ---------------------------------------------------------------------------
// XMind import. Archives are built here and handed to the page as base64.

async function xmindBase64(files) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  Object.entries(files).forEach(([name, text]) => zip.file(name, text));
  return zip.generateAsync({ type: 'base64' });
}

const ZEN_SHEETS = [{
  title: 'Main',
  rootTopic: {
    id: 'r', title: 'X Root',
    children: {
      attached: [
        { id: 'a', title: 'Alpha', href: 'https://example.com', notes: { plain: { content: 'remember' } } },
        { id: 'b', title: 'Beta', branch: 'folded', children: { attached: [{ id: 'b1', title: 'Beta child' }] } },
      ],
      detached: [{ id: 'f', title: 'Floating' }],
    },
  },
  relationships: [{ id: 'rel', end1Id: 'a', end2Id: 'b' }],
}];

const LEGACY_XML = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0">
<sheet id="s1"><topic id="t0"><title>Legacy Root</title><children><topics type="attached">
<topic id="t1" xlink:href="https://example.com/old"><title>Linked</title><notes><plain>Note &amp; more</plain></notes></topic>
<topic id="t2" branch="folded"><title>Folded</title><children><topics type="attached"><topic id="t3"><title>Inner</title></topic></topics></children></topic>
</topics><topics type="detached"><topic id="t4"><title>Free</title></topic></topics></children></topic><title>Sheet 1</title>
<relationships><relationship id="r1" end1="t1" end2="t2"/></relationships></sheet></xmap-content>`;

// Page snippet: imports base64 data under a name and reports the result.
function importSnippet(b64, name) {
  return `
    const bytes = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0));
    const folder = app.vault.getAbstractFileByPath('${INBOX}');
    const files = await app.plugins.plugins.mapdown.importXmind(bytes.buffer, '${name}', folder);
    await H.wait(600);
    return files.map((f) => f.path);`;
}

// What the open map shows, and whether saving it would change the file.
const IMPORTED_STATE = `
  const view = H.view();
  const before = await app.vault.read(view.file);
  view.serializeMindMap();
  return {
    type: view.getViewType(), path: view.file.path,
    texts: H.texts(),
    collapsed: H.nodes().filter((n) => !n.isExpand).map((n) => n.data.text),
    unchanged: view.data === before,
  };`;

scenario('plain-note-convert', async () => {
  const p = `${INBOX}/${PREFIX}plain.md`;
  const body = '---\ntags: [demo]\n---\n\n# Plan\n\nBackground text.\nSecond line.\n\n## Goals\n\n1. First\n2. Second\n\n## Tasks\n\n- [ ] Open\n- [x] Done\n\n> Quoted\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nClosing words.\n';
  fs.writeFileSync(path.join(VAULT, p), body);
  // Opens the note as Markdown, runs the toggle command and presses a dialog button.
  const choose = (button) => evalJs(`
    for (let i = 0; i < 50 && !H.file('${p}'); i++) await H.wait(100);
    const leaf = app.workspace.getLeaf(true);
    await leaf.openFile(H.file('${p}'));
    app.workspace.setActiveLeaf(leaf, { focus: true });
    await H.wait(300);
    app.commands.executeCommandById('mapdown:Toggle to markdown or mindmap');
    await H.until(() => document.querySelector('.modal-container .modal button'), 3000);
    const buttons = document.querySelectorAll('.modal-container .modal button');
    const count = buttons.length;
    buttons[${button}].click();
    await H.wait(1500);
    return { count, type: H.view().getViewType(), path: H.view().file?.path };`);

  let r = await choose(0);
  expect(r.count === 3 && r.type === 'markdown' && r.path === p, 'cancelling keeps the note in Markdown', r);

  r = await choose(1);
  expect(r.type === VIEW_TYPE && r.path !== p && r.path.startsWith(`${INBOX}/${PREFIX}plain`), 'saving as a new map opens a new note', r);
  const copy = await evalJs(`
    const view = H.view();
    const before = await app.vault.read(view.file);
    view.serializeMindMap();
    const table = H.nodes().find((n) => n.data.text.startsWith('| A'));
    return { texts: H.texts(), unchanged: view.data === before, tags: before.startsWith('---\\ntags: [demo]\\n'),
      tableRendered: !!table?.contentEl.querySelector('table') };`);
  expect(JSON.stringify(copy.texts) === JSON.stringify(['Plan', 'Background text.\nSecond line.', 'Goals', 'First', 'Second', 'Tasks', '[ ] Open', '[x] Done', '> Quoted', '| A | B |\n| --- | --- |\n| 1 | 2 |', 'Closing words.']),
    'paragraphs, lists, quote and table become nodes', copy.texts);
  expect(copy.unchanged && copy.tags, 'the new map keeps the properties and saves stably', copy);
  expect(copy.tableRendered, 'a table node renders as a table', copy);
  expect(readNote(p) === body, 'saving as a new map leaves the note unchanged');

  r = await choose(2);
  expect(r.type === VIEW_TYPE && r.path === p, 'converting opens the note itself as a map', r);
  const inPlace = await evalJs(`return H.texts().length;`);
  expect(inPlace === copy.texts.length && readNote(p) === body, 'converting in place keeps every block and writes nothing before an edit', inPlace);
});

scenario('xmind-import-drop', async () => {
  const p = writeNote('xmind_target', '# Target\n\n## keep\n');
  const original = readNote(p);
  const b64 = await xmindBase64({ 'content.json': JSON.stringify(ZEN_SHEETS) });
  await evalJs(`await H.open('${p}');`);
  await evalJs(`
    const bytes = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], '${PREFIX}dropped.xmind'));
    H.mm().appEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await H.until(() => H.view().file?.basename === '${PREFIX}dropped' && H.mm()?.root, 8000);
    await H.wait(600);`);
  const r = await evalJs(IMPORTED_STATE);
  expect(r.type === VIEW_TYPE && r.path === `${INBOX}/${PREFIX}dropped.md`, 'a dropped .xmind opens as a new map note', r);
  expect(JSON.stringify(r.texts) === JSON.stringify(['X Root', '[Alpha](https://example.com)', '📝 remember', 'Beta', 'Beta child', 'Floating']),
    'topics, link, note and floating topic are imported', r.texts);
  expect(JSON.stringify(r.collapsed) === '["Beta"]', 'a folded topic stays collapsed', r.collapsed);
  expect(r.unchanged, 'saving the imported note changes nothing', r);
  expect(readNote(p) === original, 'the map it was dropped on is unchanged');
});

scenario('xmind-import-command', async () => {
  const zen = await xmindBase64({ 'content.json': JSON.stringify(ZEN_SHEETS) });
  let r = await evalJs(importSnippet(zen, `${PREFIX}dup.xmind`));
  r = r.concat(await evalJs(importSnippet(zen, `${PREFIX}dup.xmind`)));
  expect(JSON.stringify(r) === JSON.stringify([`${INBOX}/${PREFIX}dup.md`, `${INBOX}/${PREFIX}dup 1.md`]),
    'importing the same name twice adds a number instead of overwriting', r);

  const two = await xmindBase64({ 'content.json': JSON.stringify([...ZEN_SHEETS, { title: 'Second', rootTopic: { id: 's', title: 'S' } }]) });
  r = await evalJs(importSnippet(two, `${PREFIX}multi.xmind`));
  expect(JSON.stringify(r) === JSON.stringify([`${INBOX}/${PREFIX}multi - Main.md`, `${INBOX}/${PREFIX}multi - Second.md`]),
    'each sheet becomes its own note', r);

  r = await evalJs(importSnippet(await xmindBase64({ 'content.xml': LEGACY_XML }), `${PREFIX}legacy.xmind`));
  expect(r.length === 1, 'an XMind 8 file imports', r);
  r = await evalJs(IMPORTED_STATE);
  expect(JSON.stringify(r.texts) === JSON.stringify(['Legacy Root', '[Linked](https://example.com/old)', '📝 Note & more', 'Folded', 'Inner', 'Free']),
    'XMind 8 titles, links, notes and floating topics are imported', r.texts);
  expect(JSON.stringify(r.collapsed) === '["Folded"]' && r.unchanged, 'XMind 8 folding is kept and the note is stable', r);

  const before = listTempFiles().length;
  r = await evalJs(importSnippet(Buffer.from('not a zip').toString('base64'), `${PREFIX}broken.xmind`));
  r = r.concat(await evalJs(importSnippet(await xmindBase64({ 'readme.txt': 'x' }), `${PREFIX}unknown.xmind`)));
  expect(r.length === 0 && listTempFiles().length === before, 'broken or unknown files create no notes', r);
});

scenario('xmind-export', async () => {
  const p = writeNote('xexport', '# Export Root\n\n## [Linked site](https://example.com) `tag`\n\n- 📝 a note\n\n## Folded ^xf1\n\n- hidden child\n\n## Plain\n', '{"version":2,"collapsed":["xf1"]}');
  const original = readNote(p);
  const r = await evalJs(`
    await H.open('${p}');
    const before = { texts: H.texts(), collapsed: H.nodes().filter((n) => !n.isExpand).map((n) => n.data.text) };
    const run = async () => {
      app.commands.executeCommandById('mapdown:export-xmind');
      const count = app.vault.getFiles().filter((f) => f.extension === 'xmind' && f.basename.startsWith('${PREFIX}xexport')).length;
      await H.until(() => app.vault.getFiles().filter((f) => f.extension === 'xmind' && f.basename.startsWith('${PREFIX}xexport')).length > count, 5000);
    };
    await run();
    await run();
    const exported = app.vault.getFiles().filter((f) => f.extension === 'xmind' && f.basename.startsWith('${PREFIX}xexport')).map((f) => f.path).sort();
    const data = await app.vault.readBinary(H.file('${INBOX}/${PREFIX}xexport.xmind'));
    const folder = app.vault.getAbstractFileByPath('${INBOX}');
    await app.plugins.plugins.mapdown.importXmind(data, '${PREFIX}xreimport.xmind', folder);
    await H.until(() => H.view().file?.basename === '${PREFIX}xreimport' && H.mm()?.root, 5000);
    await H.wait(500);
    const after = { texts: H.texts(), collapsed: H.nodes().filter((n) => !n.isExpand).map((n) => n.data.text) };
    return { exported, before, after };`);
  expect(JSON.stringify(r.exported) === JSON.stringify([`${INBOX}/${PREFIX}xexport 1.xmind`, `${INBOX}/${PREFIX}xexport.xmind`]),
    'export writes next to the note and numbers a second export', r.exported);
  expect(JSON.stringify(r.before) === JSON.stringify(r.after), 'importing the exported file gives back the same map', r);
  expect(readNote(p) === original, 'exporting leaves the note unchanged');
});

scenario('export-commits-edit', async () => {
  const p = writeNote('export', '# Root\n\n## child\n');
  const r = await evalJs(`
    await H.open('${p}');
    const n = H.find('child');
    H.select(n);
    n.edit();
    n.contentEl.innerText = '**bold edit**';
    await H.view().exportImage('png', 1);
    await H.wait(500);
    return {
      editing: n.data.isEdit,
      text: n.data.text,
      png: !!H.file('${INBOX}/${PREFIX}export.png'),
    };
  `, 60000);
  expect(!r.editing && r.text === '**bold edit**', 'export commits the active edit first', r);
  expect(r.png, 'export writes the image next to the note', r);
});

scenario('export-missing-and-close', async () => {
  // A missing embedded image must not block the export.
  const p = writeNote('exportmissing', '# Root\n\n## child ![[__mapdown_e2e_missing.png]]\n\n## other\n');
  let r = await evalJs(`
    await H.open('${p}');
    await H.view().exportImage('png', 1);
    await H.wait(300);
    return { png: !!H.file('${INBOX}/${PREFIX}exportmissing.png') };
  `, 60000);
  expect(r.png, 'export completes when an embedded image is missing', r);

  // Closing the map while the export is running cancels it quietly.
  const q = writeNote('exportclose', '# Root\n\n## child\n');
  r = await evalJs(`
    const leaf = await H.open('${q}');
    const errors = [];
    const origError = console.error;
    console.error = (...a) => { errors.push(a.map((x) => String(x?.stack || x)).join(' | ').slice(0, 600)); origError(...a); };
    try {
      const pending = leaf.view.exportImage('png', 2);
      leaf.detach();
      await pending;
      await H.wait(800);
    } finally {
      console.error = origError;
    }
    return { png: !!H.file('${INBOX}/${PREFIX}exportclose.png'), errors };
  `, 60000);
  expect(!r.png, 'closing the map during export writes no image', r);
  expect(r.errors.length === 0, 'a cancelled export is not reported as an error', r);
});

// ---------------------------------------------------------------------------

async function main() {
  if (deploy) {
    console.log('Building and deploying…');
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
    for (const file of ['main.js', 'styles.css']) {
      fs.copyFileSync(path.join(ROOT, file), path.join(PLUGIN_DIR, file));
    }
    await cli(['plugin:reload', 'id=mapdown']);
    await sleep(1500);
  }

  await cleanup();
  await cli(['dev:errors', 'clear']);
  await cli(['dev:debug', 'on']);

  const selected = only
    ? scenarios.filter((s) => only.includes(s.name))
    : scenarios.filter((s) => includeSlow || !s.slow);
  const failures = [];
  for (const s of selected) {
    const started = Date.now();
    try {
      await ensureForeground();
      await s.run();
      await sleep(500);
      const copies = safetyCopies();
      expect(copies.length === 0, 'no backup, conflict or recovery copies are created', copies);
      console.log(`  ✓ ${s.name} (${Date.now() - started} ms)`);
    } catch (err) {
      failures.push(s.name);
      console.log(`  ✗ ${s.name}\n      ${err.message}`);
    } finally {
      await cleanup();
    }
  }

  const errors = await cli(['dev:errors']);
  await cli(['dev:debug', 'off']).catch(() => {});
  const runtimeErrorsFree = /No errors captured/.test(errors);
  if (!runtimeErrorsFree) {
    console.log(`  ✗ runtime errors captured:\n${errors}`);
  }

  const leftovers = listTempFiles();
  if (leftovers.length) {
    console.log(`  ✗ temporary files left behind: ${leftovers.join(', ')}`);
  }

  const passed = selected.length - failures.length;
  console.log(`\n${passed}/${selected.length} scenarios passed`);
  if (failures.length || !runtimeErrorsFree || leftovers.length) {
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exitCode = 1;
});
