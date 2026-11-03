const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const ts = require('typescript');

function transpile(file) {
  return ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
}

function load(file, dependencies = {}) {
  const exports = {};
  const context = {
    exports,
    require: (id) => dependencies[id] || {},
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => callback(),
    cancelAnimationFrame: () => {},
    window: { setTimeout, clearTimeout },
    document: {},
    HTMLElement: class {},
    Blob,
    Uint8Array,
    atob,
  };
  vm.runInNewContext(transpile(file), context, { filename: file });
  return exports;
}

const transformer = require('../src/markmapLib/markmap-lib/dist/browser/index.js');
const constants = load('src/constants.ts');
const utils = load('src/utils.ts');

function parseYamlForTests(yaml) {
  const inline = /^mindmark-state:\s*(\{.*\}|null|\[.*\])\s*$/m.exec(yaml);
  if (inline) {
    return {
      'mindmark-state': inline[1] === 'null' ? null : JSON.parse(inline[1]),
    };
  }
  if (!/^mindmark-state:\s*$/m.test(yaml)) {
    return {};
  }

  const version = /^\s+version:\s*(\d+)\s*$/m.exec(yaml);
  const collapsedBlock = /^\s+collapsed:\s*\n((?:\s+-.*\n?)*)/m.exec(yaml);
  const collapsed = collapsedBlock
    ? Array.from(collapsedBlock[1].matchAll(/^\s+-\s*(.+)\s*$/gm), (match) => match[1])
    : [];
  return {
    'mindmark-state': {
      version: version ? Number(version[1]) : undefined,
      collapsed,
    },
  };
}

const viewModule = load('src/MindMapView.ts', {
  obsidian: {
    TextFileView: class {},
    Notice: class {},
    Platform: {},
    parseYaml: parseYamlForTests,
  },
  './constants': constants,
  './markmapLib/markmap-lib': transformer,
  './lang/helpers': {
    t: (value) => value,
    tf: (value, ...args) => value.replace(/\{(\d+)\}/g, (match, index) => String(args[Number(index)] ?? match)),
  },
  './utils': utils,
  './mindmap/outline': load('src/mindmap/outline.ts'),
});
const mindmapDeps = {
  '../utils': utils,
  obsidian: { Notice: class {}, Platform: {} },
  'src/lang/helpers': { t: (value) => value },
  './outline': load('src/mindmap/outline.ts'),
};
// MindMap delegates to these modules; load them with the same mocks.
for (const name of ['search', 'keyboard', 'navigation', 'pointer', 'serialize', 'viewport']) {
  mindmapDeps[`./${name}`] = load(`src/mindmap/${name}.ts`, mindmapDeps);
}
const mindmapModule = load('src/mindmap/mindmap.ts', mindmapDeps);
const nodeModule = load('src/mindmap/INode.ts', {
  obsidian: {},
  '../lang/helpers': { t: (value) => value },
});
const layoutModule = load('src/mindmap/Layout.ts', {
  './INode': nodeModule,
  './mindmap': {},
});

const MindMapView = viewModule.MindMapView;
const MindMap = mindmapModule.default;
const Layout = layoutModule.default;

function makeNode(data, parent = null) {
  const node = {
    data,
    parent,
    isExpand: data.expanded !== false,
    children: [],
    getId() { return this.data.id; },
    getData() { return JSON.parse(JSON.stringify(this.data)); },
    getLevel() { return this.parent ? this.parent.getLevel() + 1 : 0; },
  };
  node.children = (data.children || []).map((child) => makeNode(child, node));
  return node;
}

function serialize(data, headLevel = 1) {
  const map = Object.create(MindMap.prototype);
  map.root = makeNode(data);
  map.setting = { headLevel };
  return map.getMarkdown();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeSaveView({ diskData, process, create }) {
  const files = new Map();
  const directories = new Set();
  const file = {
    path: 'Maps/Release.md',
    basename: 'Release',
    parent: { path: 'Maps' },
  };
  const adapter = {
    exists: async (path) => directories.has(path) || files.has(path),
    mkdir: async (path) => directories.add(path),
    read: async (path) => files.get(path),
    write: async (path, data) => files.set(path, data),
    remove: async (path) => files.delete(path),
  };
  const renames = [];
  const vault = {
    configDir: '.obsidian',
    adapter,
    read: async () => diskData,
    process: process || (async (_file, updater) => updater(diskData)),
    create: create || (async (path, data) => {
      files.set(path, data);
      return { path };
    }),
    getAbstractFileByPath: (path) => files.has(path) ? { path } : null,
  };
  const view = Object.create(MindMapView.prototype);
  Object.assign(view, {
    app: {
      vault,
      fileManager: {
        renameFile: async (target, path) => {
          renames.push(path);
          target.path = path;
          target.basename = path.split('/').pop().replace(/\.md$/, '');
        },
      },
    },
    plugin: { settings: { headLevel: 1 }, getRecoveryDraftDirectory: () => '.obsidian/plugins/mapdown/recovery' },
    file,
    mindmap: {
      root: { data: { text: 'Release' } },
      editNode: null,
      commitActiveEdit: () => false,
      getCollapsedBlockIds: () => [],
      clear: () => {},
    },
    contentEl: { innerHTML: '' },
    data: diskData,
    currentSnapshot: diskData,
    yamlString: '',
    pendingSave: null,
    saveRequestedWhilePending: false,
    localRevision: 0,
    savedRevision: 0,
    recoveredRevision: 0,
    savedBaseData: diskData,
    recentOwnWrites: [],
    externalConflictData: null,
    externalConflictGeneration: 0,
    fileSessionGeneration: 1,
    boundFilePath: file.path,
    lastSaveError: null,
    draftWriteChain: Promise.resolve(),
    queuedDraftSession: -1,
    queuedDraftRevision: -1,
    pendingRootTitle: null,
    stateNeedsMigration: false,
    migrationBackupSession: -1,
    savingSnapshot: null,
    isClosed: false,
    exportGeneration: 0,
    exportSnapshots: new Set(),
  });
  view.serializeMindMap = function serializeCurrentSnapshot() {
    this.data = this.currentSnapshot;
    return true;
  };
  return { view, file, files, vault, renames };
}

function testMindMarkState() {
  const view = Object.create(MindMapView.prototype);
  const frontmatter = '---\nmindmap-plugin: basic\n---\n\n';
  const updated = view.updateMindMarkState(frontmatter, ['stable-id']);
  const state = view.getMindMarkState(updated);
  assert.equal(state.version, 2);
  assert.equal(state.writable, true);
  assert.deepEqual(Array.from(state.collapsed), ['stable-id']);

  const multiline = [
    '---',
    'mindmap-plugin: basic',
    'mindmark-state:',
    '  version: 2',
    '  collapsed:',
    '    - branch-a',
    'other-field: keep-me',
    '---',
    '',
    '',
  ].join('\n');
  const multilineState = view.getMindMarkState(multiline);
  assert.equal(multilineState.version, 2);
  assert.deepEqual(Array.from(multilineState.collapsed), ['branch-a']);
  const rewritten = view.updateMindMarkState(multiline, ['branch-b']);
  assert(rewritten.includes('mindmark-state: {"version":2,"collapsed":["branch-b"]}'));
  assert(rewritten.includes('other-field: keep-me'));
  assert.equal(rewritten.includes('  version: 2'), false);

  const unknown = '---\nmindmark-state: {"version":99,"collapsed":[],"future":true}\n---\n\n';
  assert.equal(view.getMindMarkState(unknown).writable, false);
  assert.throws(() => view.updateMindMarkState(unknown, []), /Unsupported/);

  view.file = { basename: 'Bound note' };
  const expanded = view.mdToData('# Root\n\n- Branch ^stable-id', {
    version: 2,
    collapsed: new Set(),
  });
  assert.equal(expanded.children[0].expanded, true);
  assert.equal(expanded.children[0].blockId, 'stable-id');

  const collapsed = view.mdToData('# Root\n\n- Branch ^stable-id', {
    version: 2,
    collapsed: new Set(['stable-id']),
  });
  assert.equal(collapsed.children[0].expanded, false);
}

function testMarkdownSerialization() {
  const output = serialize({
    id: 'root',
    text: 'Root',
    expanded: true,
    children: [{
      id: 'branch',
      blockId: 'stable-id',
      text: 'Branch',
      expanded: true,
      children: [],
    }, {
      id: 'code',
      blockId: 'code-id',
      text: '```python\nif True:\n    print("nested")\n```',
      expanded: true,
      children: [],
    }, {
      id: 'tilde-code',
      blockId: 'tilde-code-id',
      text: '~~~~js\nconst fence = "```";\n~~~~',
      expanded: true,
      children: [],
    }],
  }, 2);
  assert(output.includes('- Branch ^stable-id'));
  assert(output.includes('      print("nested")'));
  assert(output.includes('  ^code-id'));
  assert.equal(output.includes('``` ^code-id'), false);

  const view = Object.create(MindMapView.prototype);
  view.file = { basename: 'Roundtrip' };
  const roundtrip = view.mdToData(output, {
    version: 2,
    collapsed: new Set(),
  });
  assert.equal(roundtrip.children[1].blockId, 'code-id');
  assert.equal(roundtrip.children[1].text.trim(), '```python\nif True:\n    print("nested")\n```');
  assert.equal(roundtrip.children[2].blockId, 'tilde-code-id');
  assert.equal(roundtrip.children[2].text.trim(), '~~~~js\nconst fence = "```";\n~~~~');
}

// Node line numbers must point at the line the node occupies in the file,
// both after parsing a file and after serializing the map.
function testSourceLineMapping() {
  const view = Object.create(MindMapView.prototype);
  view.file = { basename: 'Lines' };
  const state = { version: 2, collapsed: new Set() };
  const firstLine = (text) => text.split('\n')[0].replace(/ \^[a-z0-9-]+$/i, '');

  function parsedNodes(file) {
    const data = view.mdToData(view.getMdText(file), state);
    const offset = view.getBodyLineOffset(file);
    const nodes = [];
    const walk = (n) => { nodes.push(n); (n.children || []).forEach(walk); };
    walk(data);
    return { data, offset, nodes, lines: file.split(/\r?\n/) };
  }

  const files = [
    '---\n\nmindmap-plugin: basic\nmindmark-state: {"version":2,"collapsed":[]}\n\n---\n\n# Root\n\n## A\n\n- item 1\n    - sub 1\n- item 2 ^abc\n\n## B\n\n> quote\n',
    'Intro paragraph\n\n## X\n\n## Y\n',
    '---\nmindmap-plugin: basic\n---\n\n\n\n# Spaced Root\n\n## Child\n',
    '---\r\nmindmap-plugin: basic\r\n---\r\n\r\n# CRLF Root\r\n\r\n## Child\r\n',
  ];
  for (const file of files) {
    const { offset, nodes, lines } = parsedNodes(file);
    for (const node of nodes) {
      if (!node.sourceRange) continue;
      const line = lines[offset + node.sourceRange.start];
      assert(line.includes(firstLine(node.text).replace(/^> /, '')),
        `parsed "${node.text}" maps to line "${line}" in ${JSON.stringify(file.slice(0, 30))}`);
    }
  }

  // Serialized output: every node, including lists, multi-line and code nodes.
  const tree = {
    id: 'root', text: 'Root', children: [
      { id: 'a', text: 'A', children: [
        { id: 'deep', text: 'Deep item', children: [{ id: 'deeper', text: 'Deeper', children: [] }] },
      ] },
      { id: 'multi', text: 'Line one\nLine two', children: [] },
      { id: 'code', text: '```js\nx = 1\n```', children: [] },
      { id: 'empty', text: '', children: [] },
      { id: 'after', text: 'After code', children: [] },
    ],
  };
  const map = Object.create(MindMap.prototype);
  map.root = makeNode(tree);
  map.setting = { headLevel: 2 };
  const output = map.getMarkdown();
  const outLines = output.split('\n');
  map.traverseDF((n) => {
    const range = n.data.sourceRange;
    assert(range, `serialized "${n.data.text}" has a range`);
    const line = outLines[range.start];
    if (n.data.text.startsWith('```')) {
      assert.equal(line.trim(), '-', 'code node starts at its list marker');
      assert.equal(outLines[range.start + 1].trim(), '```js');
    } else if (n.data.text === '') {
      assert.equal(line.trim(), '-');
    } else {
      assert(line.includes(firstLine(n.data.text)), `serialized "${n.data.text}" maps to "${line}"`);
    }
    assert(range.end > range.start, 'ranges are non-empty');
  }, map.root, true);

  // Lookup: blank lines and lines inside a node resolve to the node above.
  assert.equal(map.getNodeAtBodyLine(0).data.id, 'root');
  const code = map.root.children.find((c) => c.data.id === 'code');
  assert.equal(map.getNodeAtBodyLine(code.data.sourceRange.start + 2).data.id, 'code');
  const after = map.root.children.find((c) => c.data.id === 'after');
  assert.equal(map.getNodeAtBodyLine(after.data.sourceRange.start).data.id, 'after');
  assert.equal(map.getNodeAtBodyLine(9999).data.id, 'after');

  // Round trip: parsing the serialized output gives the same ranges.
  const file = '---\nmindmap-plugin: basic\n---\n\n' + output;
  const parsed = parsedNodes(file);
  const serializedRanges = [];
  map.traverseDF((n) => serializedRanges.push(n.data.sourceRange.start), map.root, true);
  const parsedRanges = parsed.nodes.filter((n) => n.sourceRange).map((n) => n.sourceRange.start);
  assert.deepEqual(parsedRanges, serializedRanges, 'parse and serialize agree on node lines');
  assert.equal(parsed.offset, 4);
}

function testTemporarySearchExpansionIsNotPersisted() {
  const map = Object.create(MindMap.prototype);
  map.root = makeNode({
    id: 'root',
    text: 'Root',
    expanded: true,
    children: [{
      id: 'branch',
      blockId: 'stable-branch',
      text: 'Branch',
      expanded: true,
      children: [{ id: 'match', text: 'Hidden match', expanded: true, children: [] }],
    }],
  });
  map.searchTemporarilyExpandedIds = new Set(['branch']);
  assert.deepEqual(Array.from(map.getCollapsedBlockIds()), ['stable-branch']);
}

function testClipboardIds() {
  const input = [
    { id: 'parent', pid: null, text: 'Parent' },
    { id: 'child', pid: 'parent', text: 'Child' },
  ];
  const first = utils.remapNodeIds(input);
  const second = utils.remapNodeIds(input);
  assert.notEqual(first[0].id, second[0].id);
  assert.equal(first[1].pid, first[0].id);
  assert.equal(second[1].pid, second[0].id);
}

function testSearchTextNormalization() {
  assert.equal(utils.normalizeSearchText('**Roadmap** [[Plan|Q4 plan]]'), 'Roadmap Q4 plan');
  assert.equal(utils.normalizeSearchText('```js\nconst ready = true;\n```'), 'const ready = true;');
  assert.equal(utils.normalizeSearchText('[Visible label](https://example.com)'), 'Visible label');
  assert.equal(utils.normalizeSearchText('foo_bar'), 'foo_bar');
  assert.equal(utils.normalizeSearchText('a < b > c'), 'a < b > c');
  assert.equal(utils.normalizeSearchText('#'), '#');
}

function testTemporarySearchVisibilityDoesNotMutateCollapseState() {
  function visibilityNode(id, expanded, parent = null) {
    const node = {
      data: { id },
      parent,
      children: [],
      isExpand: expanded,
      isHide: false,
      getId: () => id,
      isShow() { return !this.isHide; },
      show() { this.isHide = false; },
      hide() { this.isHide = true; },
      refreshBox() {},
      clearCacheData() {},
    };
    return node;
  }

  const root = visibilityNode('root', true);
  const collapsed = visibilityNode('collapsed', false, root);
  const target = visibilityNode('target', true, collapsed);
  root.children = [collapsed];
  collapsed.children = [target];
  const map = Object.create(MindMap.prototype);
  map.root = root;
  map.searchTemporarilyExpandedIds = new Set();

  map.updateEffectiveNodeVisibility();
  assert.equal(target.isShow(), false);
  map.searchTemporarilyExpandedIds.add('collapsed');
  map.updateEffectiveNodeVisibility();
  assert.equal(target.isShow(), true);
  assert.equal(collapsed.isExpand, false);
  map.searchTemporarilyExpandedIds.clear();
  map.updateEffectiveNodeVisibility();
  assert.equal(target.isShow(), false);
  assert.equal(collapsed.isExpand, false);
}

function testFailedCommandKeepsRedo() {
  const History = load('src/mindmap/History.ts').default;
  const history = new History();
  const redoMarker = { name: 'redo' };
  history.redos = [redoMarker];
  history.execute({ execute: () => false });
  assert.equal(history.redos[0], redoMarker);
}

function testPlainTextFastPathGuard() {
  assert.equal(nodeModule.isPlainNodeText('Quarterly planning'), true);
  assert.equal(nodeModule.isPlainNodeText('中文普通节点'), true);
  assert.equal(nodeModule.isPlainNodeText('**bold**'), false);
  assert.equal(nodeModule.isPlainNodeText('[[Linked note]]'), false);
  assert.equal(nodeModule.isPlainNodeText('https://example.com'), false);
  assert.equal(nodeModule.isPlainNodeText('`code`'), false);
  assert.equal(nodeModule.isPlainNodeText('Price &amp; tax'), false);
  assert.equal(nodeModule.isPlainNodeText('==highlight=='), false);
  assert.equal(nodeModule.isPlainNodeText('key=value'), false);
}

function testLevelStyleChangesAlwaysInvalidateNodeSize() {
  const classes = new Set(['mm-node', 'mm-node-second']);
  const classList = {
    contains: (value) => classes.has(value),
    add: (...values) => values.forEach((value) => classes.add(value)),
    remove: (...values) => values.forEach((value) => classes.delete(value)),
  };
  let level = 2;
  let refreshCount = 0;
  let clearCount = 0;
  const scheduled = [];
  const node = {
    stroke: '',
    direct: '',
    isSelect: false,
    isExpand: true,
    data: {},
    children: [],
    mindmap: { selectNode: null },
    containEl: { classList },
    getLevel: () => level,
    isLeaf: () => true,
    refreshBox: () => refreshCount++,
    clearCacheData: () => clearCount++,
  };
  const layout = Object.create(Layout.prototype);
  layout.mind = { scheduleNodeRemeasure: (target) => scheduled.push(target) };

  layout._setDirect(node, 'right');
  assert.equal(classes.has('mm-node-second'), false);
  assert.equal(refreshCount, 1);
  assert.equal(clearCount, 1);
  assert.equal(scheduled.length, 1);

  level = 1;
  layout._setDirect(node, 'right');
  assert.equal(classes.has('mm-node-second'), true);
  assert.equal(refreshCount, 2);
  assert.equal(clearCount, 2);
  assert.equal(scheduled.length, 2);
}

function testExportOnlyFreezesSingleLineNodeContent() {
  const view = Object.create(MindMapView.prototype);
  const style = {
    lineHeight: '27px',
    paddingTop: '14px',
    paddingBottom: '14px',
    borderTopWidth: '1px',
    borderBottomWidth: '1px',
  };
  const content = {
    offsetHeight: 57,
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => style,
      },
    },
  };

  assert.equal(view.isSingleLineNodeContent(content), true);
  content.offsetHeight = 84;
  assert.equal(view.isSingleLineNodeContent(content), false);
}

async function testExportGuards() {
  const view = Object.create(MindMapView.prototype);
  view.app = {
    vault: {
      adapter: {
        exists: async (path) => path === 'Maps/Release.png' || path === 'Maps/Release 1.png',
      },
    },
  };
  view.sanitizeFilename = (value) => value;

  const path = await view.getAvailableExportFilePath('Maps/Release.md', '.png', 'Release');
  assert.equal(path, 'Maps/Release 2.png');
  assert.doesNotThrow(() => view.assertExportSize({ width: 1000, height: 800 }, 4));
  assert.throws(
    () => view.assertExportSize({ width: 5000, height: 5000 }, 2),
    /too large/,
  );
}

async function testExportQueueAndNoOverwriteRetry() {
  const firstMayFinish = deferred();
  const firstStarted = deferred();
  const order = [];
  const occupied = new Set();
  const created = [];
  const vault = {
    adapter: {
      exists: async (path) => occupied.has(path),
    },
    createBinary: async (path) => {
      if (path === 'Maps/Release.png' && !occupied.has(path)) {
        occupied.add(path);
        throw new Error('occupied by another writer');
      }
      if (occupied.has(path)) {
        throw new Error('already exists');
      }
      occupied.add(path);
      created.push(path);
    },
  };
  const firstView = Object.create(MindMapView.prototype);
  firstView.app = { vault };
  firstView.sanitizeFilename = (value) => value;
  const secondView = Object.create(MindMapView.prototype);
  secondView.app = { vault };
  secondView.sanitizeFilename = (value) => value;

  const first = firstView.enqueueExport(async () => {
    order.push('first-start');
    firstStarted.resolve();
    await firstMayFinish.promise;
    order.push('first-end');
  });
  await firstStarted.promise;
  const second = secondView.enqueueExport(async () => {
    order.push('second-start');
  });
  await Promise.resolve();
  assert.deepEqual(order, ['first-start']);
  firstMayFinish.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);

  const path = await firstView.createUniqueExportFile(
    'Maps/Release.md',
    '.png',
    'Release',
    new ArrayBuffer(1),
  );
  assert.equal(path, 'Maps/Release 1.png');
  assert.deepEqual(created, ['Maps/Release 1.png']);
}

async function testSaveFailureKeepsRecoverableStateOnClose() {
  const { view, files } = makeSaveView({
    diskData: 'BASE',
    process: async () => {
      throw new Error('disk is read-only');
    },
  });
  let clearCount = 0;
  view.mindmap.clear = () => clearCount++;
  view.currentSnapshot = 'LOCAL L1';

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    view.mindMapChange();
    await view.onClose();
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(clearCount, 0);
  assert.notEqual(view.mindmap, null);
  assert.equal(view.localRevision, 1);
  assert.equal(view.savedRevision, 0);
  assert.match(view.lastSaveError.message, /read-only/);
  const drafts = Array.from(files.entries()).filter(([path]) => path.endsWith('.json'));
  assert.equal(drafts.length, 1);
  assert.equal(JSON.parse(drafts[0][1]).data, 'LOCAL L1');
}

async function testConflictRecoveryKeepsNewerLocalAndExternalRevisions() {
  const firstRecoveryStarted = deferred();
  const releaseFirstRecovery = deferred();
  const recoveries = [];
  let diskData = 'EXTERNAL E1';
  let createCount = 0;
  const { view, file, files } = makeSaveView({
    diskData: 'BASE',
    process: async (_file, updater) => updater(diskData),
    create: async (path, data) => {
      createCount++;
      recoveries.push({ path, data });
      files.set(path, data);
      if (createCount === 1) {
        firstRecoveryStarted.resolve();
        await releaseFirstRecovery.promise;
      }
      return { path };
    },
  });
  view.applyExternalData = function applyExternalData(data) {
    this.data = data;
    this.currentSnapshot = data;
    this.savedBaseData = data;
    this.localRevision = 0;
    this.savedRevision = 0;
    this.recoveredRevision = 0;
    this.externalConflictData = null;
  };

  view.currentSnapshot = 'LOCAL L1';
  view.mindMapChange();
  const saveTask = view.pendingSave;
  await firstRecoveryStarted.promise;

  view.currentSnapshot = 'LOCAL L2';
  view.mindMapChange();
  diskData = 'EXTERNAL E2';
  view.onQuickPreview(file, diskData);
  releaseFirstRecovery.resolve();
  await saveTask;

  assert.deepEqual(recoveries.map(({ data }) => data), ['LOCAL L1', 'LOCAL L2']);
  assert.equal(diskData, 'EXTERNAL E2');
  assert.equal(view.data, 'EXTERNAL E2');
  assert.equal(view.externalConflictData, null);
  assert.equal(view.localRevision, 0);
  assert.equal(view.savedRevision, 0);
}

async function testPersistedDraftBecomesVisibleRecoveryNote() {
  const { view, file, files } = makeSaveView({ diskData: 'DISK' });
  const draftPath = view.getRecoveryDraftPath(file.path);
  files.set(draftPath, JSON.stringify({
    version: 1,
    sourcePath: file.path,
    revision: 3,
    data: 'RECOVERED LOCAL DATA',
    updatedAt: new Date().toISOString(),
  }));

  await view.recoverPersistedDraft(file);

  const recovered = Array.from(files.entries()).find(([path]) => path.includes('Mapdown recovered'));
  assert(recovered);
  assert.equal(recovered[1], 'RECOVERED LOCAL DATA');
  assert.equal(files.has(draftPath), false);
}

async function testOnlyRootTextChangesRenameTheFile() {
  const childSave = makeSaveView({ diskData: 'BASE' });
  childSave.view.currentSnapshot = 'CHILD EDIT';
  childSave.view.mindMapChange();
  await childSave.view.pendingSave;
  assert.deepEqual(childSave.renames, []);
  assert.equal(childSave.file.path, 'Maps/Release.md');

  const rootSave = makeSaveView({ diskData: 'BASE' });
  rootSave.view.markRootTitleChange('Renamed root');
  rootSave.view.currentSnapshot = 'ROOT EDIT';
  rootSave.view.mindMapChange();
  await rootSave.view.pendingSave;
  assert.deepEqual(rootSave.renames, ['Maps/Renamed root.md']);
  assert.equal(rootSave.file.path, 'Maps/Renamed root.md');
}

async function testStateMigrationCreatesBackupBeforeSave() {
  const { view, files } = makeSaveView({ diskData: 'LEGACY ORIGINAL' });
  view.stateNeedsMigration = true;
  view.currentSnapshot = 'MIGRATED CONTENT';

  view.mindMapChange();
  await view.pendingSave;

  const backup = Array.from(files.entries()).find(([path]) => path.includes('Mapdown backup'));
  assert(backup);
  assert.equal(backup[1], 'LEGACY ORIGINAL');
  assert.equal(view.stateNeedsMigration, false);
}

function testInPlacePatchPlan() {
  const { matchSiblings, planPatch } = load('src/mindmap/patch.ts');
  const adapter = { text: (n) => n.text, blockId: (n) => n.blockId, children: (n) => n.children || [] };
  const node = (text, children = [], blockId) => ({ text, children, blockId });
  const data = (text, children = [], blockId) => ({ id: text, text, children, blockId });
  // Values from the sandboxed module belong to another realm.
  const same = (actual, expected) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected);

  // Matching by text, then by position between matches.
  same(matchSiblings(adapter, ['A', 'B', 'C'].map((t) => node(t)), ['A', 'Bx', 'C'].map((t) => data(t))), [0, 1, 2]);
  same(matchSiblings(adapter, ['A', 'C'].map((t) => node(t)), ['A', 'X', 'C'].map((t) => data(t))), [0, -1, 1]);
  same(matchSiblings(adapter, ['A', 'B', 'C'].map((t) => node(t)), ['A', 'C'].map((t) => data(t))), [0, 2]);
  same(matchSiblings(adapter, ['A', 'A', 'B'].map((t) => node(t)), ['A', 'B'].map((t) => data(t))), [0, 2]);
  // Different block ids never pair by position.
  same(matchSiblings(adapter, [node('A', [], 'x1')], [data('B', [], 'y1')]), [-1]);
  same(matchSiblings(adapter, [node('A', [], 'x1')], [data('A2', [], 'x1')]), [0]);

  const oldRoot = node('Root', [node('A', [node('A1')]), node('B', [node('B1')]), node('C')]);
  // Typing in one node: everything is reused, one text change.
  let { plan, summary } = planPatch(adapter, oldRoot, data('Root', [data('A', [data('A1 typed')]), data('B', [data('B1')]), data('C')]));
  same(summary, { created: 0, changed: 1, removed: 0 });
  assert.strictEqual(plan.children[0].children[0].node, oldRoot.children[0].children[0]);
  assert.strictEqual(plan.children[0].children[0].textChanged, true);
  assert.strictEqual(plan.children[1].node, oldRoot.children[1]);

  // Demoting heading B under A: B is recreated with its child, the rest stays.
  ({ plan, summary } = planPatch(adapter, oldRoot, data('Root', [data('A', [data('A1'), data('B', [data('B1')])]), data('C')])));
  same(summary, { created: 2, changed: 0, removed: 2 });
  assert.strictEqual(plan.children[1].node, oldRoot.children[2]);
  assert.strictEqual(plan.removed.length, 1);
  assert.strictEqual(plan.removed[0], oldRoot.children[1]);

  // No change at all, and a renamed root that keeps its node.
  ({ summary } = planPatch(adapter, oldRoot, data('Root', [data('A', [data('A1')]), data('B', [data('B1')]), data('C')])));
  same(summary, { created: 0, changed: 0, removed: 0 });
  ({ plan, summary } = planPatch(adapter, oldRoot, data('New root', [data('A', [data('A1')]), data('B', [data('B1')]), data('C')])));
  assert.strictEqual(plan.node, oldRoot);
  same(summary, { created: 0, changed: 1, removed: 0 });
}

function createSelectionMind() {
  const selection = load('src/mindmap/selection.ts');
  const mind = { selectedNodes: new Set(), selectNode: null, refreshSuspended: 0, refreshPending: false, saves: 0 };
  ['isSelectableNode', 'selectedList', 'topmostSelected', 'toggleSelection', 'selectRange',
    'collapseSelectionTo', 'selectAllVisible', 'pruneSelection', 'captureSelection', 'restoreSelection']
    .forEach((name) => { mind[name] = (...args) => selection[name].apply(mind, args); });
  mind.isNodeInTree = (node) => {
    for (let n = node; n; n = n.parent) {
      if (n === mind.root) return true;
      if (!n.parent || !n.parent.children.includes(n)) return false;
    }
    return false;
  };
  mind.isNodeWithinFocus = () => true;
  mind.clearSelectNode = () => {
    mind.selectNode?.unSelect();
    mind.selectNode = null;
    mind.collapseSelectionTo();
  };
  mind.emit = (name) => { if (name === 'mindMapChange') mind.saves++; };
  mind.removeNode = (node) => {
    const index = node.parent.children.indexOf(node);
    node.parent.children.splice(index, 1);
    return index;
  };
  mind.addNode = (node, parent, index = -1) => {
    parent.children.splice(index > -1 ? index : parent.children.length, 0, node);
    node.parent = parent;
  };
  mind.node = (text, children = [], isRoot = false) => {
    const n = {
      data: { text, isRoot }, children, parent: null, isSelect: false, mindmap: mind,
      isShow: () => true, clearCacheData() {}, refreshBox() {},
      select() { mind.collapseSelectionTo(n); n.addToSelection(true); },
      addToSelection(primary) {
        n.isSelect = true;
        mind.selectedNodes.add(n);
        if (primary || !mind.selectNode) mind.selectNode = n;
      },
      unSelect() { n.isSelect = false; mind.selectedNodes.delete(n); },
    };
    children.forEach((c) => { c.parent = n; });
    return n;
  };
  return mind;
}

async function testMultipleSelectionAndBatchDelete() {
  const mind = createSelectionMind();
  const a1 = mind.node('A1');
  const [a, b, c, d] = [mind.node('A', [a1]), mind.node('B'), mind.node('C'), mind.node('D')];
  mind.root = mind.node('Root', [a, b, c, d], true);
  const texts = (nodes) => nodes.map((n) => n.data.text).join(',');

  // Selection order follows the document; a selected ancestor hides its descendants.
  c.select();
  mind.toggleSelection(a1);
  mind.toggleSelection(a);
  assert.equal(texts(mind.selectedList()), 'A,A1,C');
  assert.equal(texts(mind.topmostSelected()), 'A,C');
  assert.equal(mind.selectNode, a);
  mind.toggleSelection(a);
  assert.equal(mind.selectNode, c);
  b.select();
  mind.selectRange(d);
  assert.equal(texts(mind.selectedList()), 'B,C,D');
  assert.equal(mind.selectNode, d);

  // Deleting three siblings and the root is one undo step and one save.
  const exec = new (load('src/mindmap/Execute.ts', {
    './History': load('src/mindmap/History.ts'),
    './Cmds': load('src/mindmap/Cmds.ts'),
    '../utils': { uuid: () => 'id' },
    '../lang/helpers': { t: (s) => s },
  }).default)();
  mind.root.addToSelection(false);
  const targets = mind.topmostSelected();
  assert.equal(texts(targets), 'B,C,D');
  const recorded = exec.batch(mind, () => [mind.root, ...targets].forEach((node) => exec.execute('deleteNodeAndChild', { node })));
  assert.equal(recorded, true);
  assert.equal(exec.history.undos.length, 1);
  assert.equal(exec.history.undos[0].commands.length, 3);
  assert.equal(texts(mind.root.children), 'A');
  assert.equal(mind.saves, 1);

  exec.undo();
  assert.equal(texts(mind.root.children), 'A,B,C,D');
  assert.equal(mind.saves, 2);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(texts(mind.selectedList()), 'Root,B,C,D');
  assert.equal(mind.selectNode, d);

  exec.redo();
  assert.equal(texts(mind.root.children), 'A');
  assert.equal(mind.saves, 3);

  // A batch whose commands all fail records nothing.
  assert.equal(exec.batch(mind, () => exec.execute('deleteNodeAndChild', { node: mind.root })), false);
  assert.equal(exec.history.undos.length, 1);
  assert.equal(mind.saves, 3);
}

function testPasteSeveralSubtrees() {
  const mind = createSelectionMind();
  class FakeNode {
    constructor(data, mindmap) { this.data = data; this.children = []; this.parent = null; this.mindmap = mindmap; }
    getId() { return this.data.id; }
    setPosition() {}
    refreshBox() {}
    clearCacheData() {}
    collapse() { this.collapsed = true; }
  }
  const { PasteNode } = load('src/mindmap/Cmds.ts', { './INode': { __esModule: true, default: FakeNode } });
  const target = mind.node('T', [mind.node('Old')]);
  target.getId = () => 'T';
  target.isExpand = true;
  mind.root = mind.node('Root', [target], true);
  const names = () => target.children.map((n) => `${n.data.text}(${n.children.map((c) => c.data.text).join()})`).join(' ');

  const paste = new PasteNode(target, [
    { id: 'a', pid: null, text: 'A' }, { id: 'a1', pid: 'a', text: 'A1' },
    { id: 'b', pid: null, text: 'B', expanded: false }, { id: 'b1', pid: 'b', text: 'B1' },
  ]);
  assert.equal(paste.execute(), true);
  assert.equal(names(), 'Old() A(A1) B(B1)');
  assert.equal(target.children[2].collapsed, true);
  paste.undo();
  assert.equal(names(), 'Old()');
  paste.redo();
  assert.equal(names(), 'Old() A(A1) B(B1)');

  // Clipboard data from before multiple selection: one root whose pid is set.
  const single = new PasteNode(target, [{ id: 'c', pid: 'x', text: 'C' }, { id: 'c1', pid: 'c', text: 'C1' }]);
  single.execute();
  assert.equal(names(), 'Old() A(A1) B(B1) C(C1)');
}

// XMind import: topic tree, skipped-content counts, errors, and a note the
// map would save unchanged.
async function testXmindImport() {
  const JSZip = require('jszip');
  const xmind = load('src/mindmap/import/xmind.ts', {
    jszip: { __esModule: true, default: JSZip },
    '../../utils': utils,
    '../../constants': constants,
    '../outline': load('src/mindmap/outline.ts'),
  });
  const zip = async (files) => {
    const z = new JSZip();
    Object.entries(files).forEach(([name, text]) => z.file(name, text));
    return z.generateAsync({ type: 'uint8array' });
  };
  const topic = (title, extra = {}) => ({ id: title, title, ...extra });
  const sheets = [{
    title: 'Main',
    rootTopic: topic('Root', {
      children: {
        attached: [
          topic('A', {
            href: 'https://example.com/a',
            notes: { plain: { content: 'line 1\r\nline 2' } },
            labels: ['tag'],
            markers: [{ markerId: 'priority-1' }, { markerId: 'task-done' }, { markerId: 'flag-red' }],
          }),
          topic('B', {
            branch: 'folded',
            children: { attached: [topic('B1')], callout: [topic('note')] },
            summaries: [{ id: 's', range: '(0,0)', topicId: 'x' }],
            boundaries: [{ id: 'b', range: '(0,0)' }],
          }),
          topic('Jump', { href: 'xmind:#abc', image: { src: 'xap:resources/a.png' } }),
          topic('Two\nlines'),
        ],
        detached: [topic('Floating')],
      },
    }),
    relationships: [{ id: 'r', end1Id: 'A', end2Id: 'B' }],
  }, { title: 'Other/Sheet', rootTopic: topic('Second') }];

  const doc = await xmind.readXmind(await zip({ 'content.json': JSON.stringify(sheets) }));
  assert.equal(doc.sheets.length, 2);
  assert.equal(doc.topicCount, 8);
  assert.deepEqual(JSON.parse(JSON.stringify(doc.skipped)), { summary: 1, boundary: 1, relationship: 1, callout: 1, image: 1 });
  assert.deepEqual(Array.from(xmind.sheetNoteNames('Plan', doc.sheets)), ['Plan - Main', 'Plan - Other Sheet']);
  assert.deepEqual(Array.from(xmind.sheetNoteNames('Plan', doc.sheets.slice(0, 1))), ['Plan']);

  const note = xmind.sheetToNote(doc.sheets[0], 1);
  const blockId = doc.sheets[0].root.children[1].blockId;
  assert.match(blockId, /^[a-z0-9-]+$/);
  const expectedBody = [
    '# Root',
    `- (P1) ✅ [A](https://example.com/a) \`tag\``,
    '    - 📝 line 1<br>line 2',
    `- B ^${blockId}`,
    '    - B1',
    '- Jump',
    '- Two<br>lines',
    '- Floating',
  ].join('\n');
  assert.equal(note, '---\n\nmindmap-plugin: basic\n\n'
    + `mindmark-state: {"version":2,"collapsed":["${blockId}"]}\n---\n\n` + expectedBody);

  // Opening the note and saving it again changes nothing.
  const view = Object.create(MindMapView.prototype);
  view.file = { basename: 'Plan' };
  const state = view.getMindMarkState(view.getFrontMatter(note));
  assert.equal(state.needsMigration, false);
  const data = view.mdToData(view.getMdText(note), state);
  assert.equal(data.children[1].expanded, false);
  assert.equal(serialize(data, 1), expectedBody);
  assert.equal(view.updateMindMarkState(view.getFrontMatter(note), [blockId]) + expectedBody, note);

  const failure = async (bytes) => {
    try {
      await xmind.readXmind(bytes);
    } catch (err) {
      return err.code;
    }
    return 'none';
  };
  assert.equal(await failure(new TextEncoder().encode('not a zip')), 'parse');
  assert.equal(await failure(await zip({ 'other.txt': 'x' })), 'unrecognized');
  assert.equal(await failure(await zip({ 'content.json': '{oops' })), 'parse');
  assert.equal(await failure(await zip({ 'content.json': JSON.stringify([{ title: 'Empty' }]) })), 'parse');
  assert.equal(await failure(await zip({ 'content.json': '[]' })), 'parse');
}

// XMind export: title mapping, archive layout, and export -> import giving
// back the same note.
async function testXmindExport() {
  const JSZip = require('jszip');
  const outline = load('src/mindmap/outline.ts');
  const xmind = load('src/mindmap/import/xmind.ts', {
    jszip: { __esModule: true, default: JSZip },
    '../../utils': utils,
    '../../constants': constants,
    '../outline': outline,
  });
  const exporter = load('src/mindmap/export/xmind.ts', {
    jszip: { __esModule: true, default: JSZip },
    '../../utils': utils,
    '../import/xmind': xmind,
  });
  const plain = (value) => JSON.parse(JSON.stringify(value));

  assert.deepEqual(plain(exporter.parseTitle('(P2) ✅ See [the **docs**](https://x.y/a) `a` `b`')),
    { title: 'See the docs', href: 'https://x.y/a', labels: ['a', 'b'], markers: ['priority-2', 'task-done'] });
  assert.deepEqual(plain(exporter.parseTitle('[[Note|Alias]] and [[Other]] ==hi== ~~no~~ *it* ![[pic.png]]')),
    { title: 'Alias and Other hi no it ![[pic.png]]', href: '', labels: [], markers: [] });
  assert.equal(exporter.parseTitle('`only code`').title, '`only code`');
  assert.equal(exporter.parseTitle('a<br>b').title, 'a\nb');

  const note = '---\n\nmindmap-plugin: basic\n\nmindmark-state: {"version":2,"collapsed":["fold-1"]}\n---\n\n' + [
    '# Root',
    '- (P1) ✅ [A](https://example.com/a) `tag`',
    '    - 📝 line 1<br>line 2',
    '- B ^fold-1',
    '    - B1',
    '- Two<br>lines',
  ].join('\n');
  const view = Object.create(MindMapView.prototype);
  view.file = { basename: 'Plan' };
  const data = view.mdToData(view.getMdText(note), view.getMindMarkState(view.getFrontMatter(note)));
  const toMapNode = (n) => ({ text: n.text, collapsed: n.expanded === false, children: n.children.map(toMapNode) });
  const sheet = exporter.mapToXmindSheet(toMapNode(data), 'Plan', 'right');
  assert.equal(sheet.rootTopic.structureClass, 'org.xmind.ui.logic.right');
  const a = sheet.rootTopic.children.attached[0];
  assert.deepEqual(plain({ title: a.title, href: a.href, labels: a.labels, markers: a.markers, notes: a.notes, children: a.children }),
    { title: 'A', href: 'https://example.com/a', labels: ['tag'], markers: [{ markerId: 'priority-1' }, { markerId: 'task-done' }],
      notes: { plain: { content: 'line 1\nline 2' } } });
  assert.equal(sheet.rootTopic.children.attached[1].branch, 'folded');

  const archive = await exporter.buildXmindArchive(sheet, '1.0');
  const files = Object.keys((await JSZip.loadAsync(archive)).files).sort();
  assert.deepEqual(files, ['content.json', 'manifest.json', 'metadata.json']);

  const doc = await xmind.readXmind(archive);
  const back = xmind.sheetToNote(doc.sheets[0], 1);
  const withoutIds = (text) => text.replace(/\^[a-z0-9-]+/g, '^id').replace(/"collapsed":\["[^"]+"\]/, '"collapsed":["id"]');
  assert.equal(withoutIds(back), withoutIds(note));
}

// A plain note keeps its paragraphs, embeds and tables as nodes, drops list
// numbering and task-list wrappers, and saves stably afterwards.
function testPlainMarkdownConversion() {
  const view = Object.create(MindMapView.prototype);
  view.file = { basename: 'Plain' };
  const state = { version: 2, collapsed: new Set() };
  const md = [
    '# 项目计划', '', '这是背景。', '第二行。', '',
    '## 目标', '', '1. 第一个目标', '2. 第二个目标', '   - 子要点', '',
    '## 任务', '', '- [ ] 未完成', '- [x] 已完成', '',
    '### 细节', '', '> 引用', '', '| 列1 | 列2 |', '| --- | --- |', '| a | b |', '', '---', '',
    '![[图片.png]]', '', '#### 第四级', '', '正文二', '## 结论', '总结。',
  ].join('\n');
  const tree = (n, d = 0) => [`${'  '.repeat(d)}${n.text}`].concat(n.children.flatMap((c) => tree(c, d + 1)));
  const data = view.mdToData(md, state);
  assert.deepEqual(tree(data), [
    '项目计划',
    '  这是背景。\n第二行。',
    '  目标',
    '    第一个目标',
    '    第二个目标',
    '      子要点',
    '  任务',
    '    [ ] 未完成',
    '    [x] 已完成',
    '    细节',
    '      > 引用',
    '      | 列1 | 列2 |\n| --- | --- |\n| a | b |',
    '      ![[图片.png]]',
    '      第四级',
    '        正文二',
    '  结论',
    '    总结。',
  ]);
  const saved = serialize(data, 2);
  const again = serialize(view.mdToData(saved, state), 2);
  assert.equal(again, saved);
  assert.deepEqual(tree(view.mdToData(saved, state)), tree(data));

  // Saving as a new map keeps the note's properties.
  const copy = viewModule.plainNoteAsMindMap('---\ntags: [a]\nmindmap-plugin: old\n---\n\n# T\n\nText.\n', 'T', 2);
  assert.equal(copy, '---\ntags: [a]\nmindmap-plugin: basic\nmindmark-state: {"version":2,"collapsed":[]}\n---\n\n# T\n\n## Text.');
  assert.equal(viewModule.plainNoteAsMindMap('Just text', 'Note', 2),
    '---\nmindmap-plugin: basic\nmindmark-state: {"version":2,"collapsed":[]}\n---\n\n# Just text');

  // A table indented under a list item.
  const nested = view.mdToData('# R\n\n- 前\n-\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |\n  | 3 | 4 |\n- 后', state);
  assert.deepEqual(tree(nested), ['R', '  前', '  | a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |', '  后']);
}

async function main() {
  testMindMarkState();
  testMarkdownSerialization();
  testPlainMarkdownConversion();
  testSourceLineMapping();
  testInPlacePatchPlan();
  await testMultipleSelectionAndBatchDelete();
  testPasteSeveralSubtrees();
  await testXmindImport();
  await testXmindExport();
  testTemporarySearchExpansionIsNotPersisted();
  testClipboardIds();
  testSearchTextNormalization();
  testTemporarySearchVisibilityDoesNotMutateCollapseState();
  testFailedCommandKeepsRedo();
  testPlainTextFastPathGuard();
  testLevelStyleChangesAlwaysInvalidateNodeSize();
  testExportOnlyFreezesSingleLineNodeContent();
  await testExportGuards();
  await testExportQueueAndNoOverwriteRetry();
  await testSaveFailureKeepsRecoverableStateOnClose();
  await testConflictRecoveryKeepsNewerLocalAndExternalRevisions();
  await testPersistedDraftBecomesVisibleRecoveryNote();
  await testOnlyRootTextChangesRenameTheFile();
  await testStateMigrationCreatesBackupBeforeSave();
  console.log('Mapdown regression tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
