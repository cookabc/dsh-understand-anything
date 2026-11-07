import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFileKey, fetchFigmaDocument, buildDesignGraph,
} from '../lib/figma.mjs';

const KEY = 'TestFileKey0001';
// A deliberately fake value: no real credential, and no vendor token prefix
// that would trip secret scanners on a public repository.
const TOKEN = 'fake-test-token-not-a-credential';

/* ------------------------------------------------------------------ *
 * parseFileKey
 * ------------------------------------------------------------------ */

test('parseFileKey: full URLs (file/design), query/fragment, scheme-less host and bare key', () => {
  assert.equal(parseFileKey(`https://www.figma.com/file/${KEY}/My%20Design`), KEY);
  assert.equal(parseFileKey(`https://www.figma.com/design/${KEY}/Title`), KEY);
  assert.equal(
    parseFileKey(`https://www.figma.com/design/${KEY}/Title?node-id=0-1&t=xyz#frame`), KEY,
  );
  assert.equal(parseFileKey(`https://www.figma.com/file/${KEY}`), KEY);
  assert.equal(parseFileKey(`www.figma.com/file/${KEY}/Title`), KEY);
  assert.equal(parseFileKey(`https://www.figma.com/proto/${KEY}/Prototype`), KEY);
  assert.equal(parseFileKey(KEY), KEY);
  assert.equal(parseFileKey(`   ${KEY}   `), KEY);
  // Another realistic key with a hyphen.
  assert.equal(parseFileKey('https://www.figma.com/file/Key-With-Hyphen-42/Name'), 'Key-With-Hyphen-42');
});

test('parseFileKey: rejects empty, malformed, non-figma and injection inputs', () => {
  const bad = [
    '', '   ', null, undefined, 42, {},
    'short',                                   // too short (< 10)
    `${KEY}/../../etc/passwd`,                 // path injection
    `${KEY}?x=1`,                              // query injection as bare key
    `${KEY}#frag`,                             // fragment injection as bare key
    '../etc/passwd',
    'abc.def.ghi.jkl',                         // dots not allowed
    'https://evil.example.com/file/SomeKey12345/Title',       // wrong host
    'https://www.figma.com.evil.example.com/file/SomeKey12345/Title', // lookalike host
    'https://www.figma.com@evil.example.com/file/SomeKey12345/Title',  // userinfo trick
    'ftp://www.figma.com/file/SomeKey12345/Title',           // non-http scheme
    'javascript://www.figma.com/file/SomeKey12345/Title',
    'https://www.figma.com/file/short/Title',              // short key in URL
    'https://www.figma.com/file/abc.def.ghi/Title',        // dotted key in URL
    'https://www.figma.com/no-marker/SomeKey12345/Title',    // no /file/ or /design/
  ];
  for (const value of bad) {
    assert.throws(() => parseFileKey(value), /INVALID_FIGMA_KEY/, `should reject ${String(value)}`);
  }
});

/* ------------------------------------------------------------------ *
 * fetchFigmaDocument
 * ------------------------------------------------------------------ */

test('fetchFigmaDocument: missing token returns FIGMA_TOKEN_MISSING without calling fetch', async () => {
  const saved = process.env.FIGMA_TOKEN;
  delete process.env.FIGMA_TOKEN;
  try {
    let called = false;
    const result = await fetchFigmaDocument(KEY, {
      fetchImpl: async () => { called = true; throw new Error('should not run'); },
    });
    assert.equal(called, false);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'FIGMA_TOKEN_MISSING');
  } finally {
    if (saved === undefined) delete process.env.FIGMA_TOKEN;
    else process.env.FIGMA_TOKEN = saved;
  }
});

test('fetchFigmaDocument: mock success builds the right URL/headers and returns doc', async () => {
  const fakeDoc = { name: 'Design', version: '42', document: { children: [] } };
  const controller = new AbortController();
  let call;
  const fetchImpl = async (url, init) => {
    call = { url, init };
    return {
      status: 200,
      ok: true,
      text: async () => '',
      json: async () => fakeDoc,
    };
  };
  const result = await fetchFigmaDocument(`https://www.figma.com/design/${KEY}/Title`, {
    token: TOKEN,
    fetchImpl,
    signal: controller.signal,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.doc, fakeDoc);
  assert.equal(call.url, `https://api.figma.com/v1/files/${KEY}?depth=6`);
  assert.equal(call.init.method, 'GET');
  assert.deepEqual(call.init.headers, {
    'X-Figma-Token': TOKEN,
    Accept: 'application/json',
  });
  assert.equal(call.init.signal, controller.signal);
  // Token must never appear in the returned value.
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('fetchFigmaDocument: non-2xx returns FIGMA_API_ERROR and never leaks the token', async () => {
  const fetchImpl = async () => ({
    status: 403,
    ok: false,
    // Deliberately echo the token in the body to prove redaction.
    text: async () => `Forbidden: invalid auth ${TOKEN} supplied`,
    json: async () => ({}),
  });
  const result = await fetchFigmaDocument(KEY, { token: TOKEN, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'FIGMA_API_ERROR');
  assert.equal(result.status, 403);
  assert.equal(typeof result.message, 'string');
  assert.ok(!result.message.includes(TOKEN));
  assert.ok(!JSON.stringify(result).includes(TOKEN), 'token must not leak anywhere in the result');
});

test('fetchFigmaDocument: network failure returns FIGMA_NETWORK_ERROR without token', async () => {
  const fetchImpl = async () => { throw new Error(`socket hang up while using ${TOKEN}`); };
  const result = await fetchFigmaDocument(KEY, { token: TOKEN, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'FIGMA_NETWORK_ERROR');
  assert.ok(!result.message.includes(TOKEN));
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('fetchFigmaDocument: invalid key is reported before any request is made', async () => {
  let called = false;
  const result = await fetchFigmaDocument('bad key!!', {
    token: TOKEN,
    fetchImpl: async () => { called = true; return { status: 200, json: async () => ({}) }; },
  });
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'INVALID_FIGMA_KEY');
});

/* ------------------------------------------------------------------ *
 * buildDesignGraph
 * ------------------------------------------------------------------ */

function smallDoc() {
  return {
    name: 'My Design',
    version: '123456789',
    styles: {
      'S:fill-1': { name: 'Primary Fill', styleType: 'FILL' },
      'S:text-1': { name: 'Heading', styleType: 'TEXT' },
    },
    document: {
      id: '0:0', type: 'DOCUMENT', name: 'Document',
      children: [
        {
          id: '1:1', type: 'CANVAS', name: 'Home',
          children: [
            {
              id: '2:1', type: 'FRAME', name: 'Home Screen',
              styles: { fill: 'S:fill-1' },
              children: [
                { id: '3:1', type: 'COMPONENT', name: 'Button', styles: { text: 'S:text-1' } },
                {
                  id: '3:2', type: 'INSTANCE', name: 'Button Instance',
                  componentId: '3:1', styles: { fill: 'S:fill-1' },
                },
                { id: '3:3', type: 'TEXT', name: 'Label', styles: { fill: 'S:fill-1' } },
              ],
            },
            {
              id: '2:2', type: 'SECTION', name: 'Cards',
              children: [{ id: '3:4', type: 'COMPONENT_SET', name: 'Card Set' }],
            },
          ],
        },
        {
          id: '1:2', type: 'CANVAS', name: 'Settings',
          children: [{ id: '2:3', type: 'FRAME', name: 'Settings Screen' }],
        },
      ],
    },
  };
}

test('buildDesignGraph: nodes, edges, layers, tour, project and integrity', () => {
  const graph = buildDesignGraph(smallDoc(), KEY);

  // Top-level identity.
  assert.equal(graph.kind, 'design');
  assert.equal(graph.figmaVersion, '123456789');
  assert.equal(graph.project.name, 'My Design');
  assert.equal(graph.project.description, 'Figma design file');
  assert.deepEqual(graph.project.languages, ['figma']);
  assert.deepEqual(graph.project.frameworks, []);
  assert.equal(graph.project.gitCommitHash, '');
  assert.match(graph.project.analyzedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(graph.meta.generator, 'dsh-understand-anything');
  assert.equal(graph.meta.kind, 'design');

  // Node ids and shapes.
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const id of [
    'page:1:1', 'page:1:2',
    'screen:2:1', 'screen:2:2', 'screen:2:3',
    'component:3:1', 'componentSet:3:4', 'instance:3:2',
    'token:S:fill-1', 'token:S:text-1',
  ]) assert.ok(ids.has(id), `missing node ${id}`);
  assert.equal(graph.nodes.length, 10);
  // A transparent TEXT node must NOT become a graph node.
  assert.ok(!ids.has('text:3:3'));

  const screen = graph.nodes.find((n) => n.id === 'screen:2:1');
  assert.equal(screen.type, 'screen');
  assert.equal(screen.name, 'Home Screen');
  assert.equal(screen.filePath, null);
  assert.equal(screen.summary, '');
  assert.deepEqual(screen.tags, []);
  assert.equal(screen.complexity, 1);
  assert.equal(screen.layer, 'Home');
  assert.deepEqual(screen.figmaMeta, { nodeId: '2:1', pageName: 'Home', figmaType: 'FRAME' });

  const token = graph.nodes.find((n) => n.id === 'token:S:fill-1');
  assert.equal(token.type, 'token');
  assert.equal(token.name, 'Primary Fill');
  assert.ok(token.tags.includes('Primary Fill'));
  assert.ok(token.tags.includes('FILL'));

  // Edges: all three kinds, specific instances, plus integrity.
  const types = new Set(graph.edges.map((e) => e.type));
  assert.ok(types.has('contains'));
  assert.ok(types.has('instance_of'));
  assert.ok(types.has('uses_token'));
  const has = (s, t, type) => graph.edges.some(
    (e) => e.source === s && e.target === t && e.type === type,
  );
  assert.ok(has('page:1:1', 'screen:2:1', 'contains'));
  assert.ok(has('screen:2:1', 'component:3:1', 'contains'));
  assert.ok(has('screen:2:2', 'componentSet:3:4', 'contains'));
  assert.ok(has('page:1:2', 'screen:2:3', 'contains'));
  assert.ok(has('instance:3:2', 'component:3:1', 'instance_of'));
  assert.ok(has('screen:2:1', 'token:S:fill-1', 'uses_token'));
  assert.ok(has('component:3:1', 'token:S:text-1', 'uses_token'));
  assert.ok(has('instance:3:2', 'token:S:fill-1', 'uses_token'));

  const nodeIdSet = new Set(graph.nodes.map((n) => n.id));
  const keys = new Set();
  for (const e of graph.edges) {
    assert.ok(nodeIdSet.has(e.source), `dangling source ${e.source}`);
    assert.ok(nodeIdSet.has(e.target), `dangling target ${e.target}`);
    assert.notEqual(e.source, e.target, 'no self-loops');
    const key = `${e.source}|${e.target}|${e.type}`;
    assert.ok(!keys.has(key), `duplicate edge ${key}`);
    keys.add(key);
  }
  assert.equal(graph.edges.length, 10);

  // Stats.
  const s = graph.meta.stats;
  assert.equal(s.pages, 2);
  assert.equal(s.screens, 3);
  assert.equal(s.components, 1);
  assert.equal(s.componentSets, 1);
  assert.equal(s.instances, 1);
  assert.equal(s.tokens, 2);
  assert.equal(s.edges, graph.edges.length);
  assert.equal(s.truncated, false);

  // Layers grouped by page, tour in page order.
  assert.equal(graph.layers.length, 2);
  assert.deepEqual(graph.layers.map((l) => l.name), ['Home', 'Settings']);
  assert.deepEqual(graph.tour.map((t) => t.order), [1, 2]);
  assert.ok(graph.tour[0].nodeIds.length > 0);
  assert.deepEqual(graph.tour[0].nodeIds, graph.layers[0].nodeIds);
  for (const layer of graph.layers) {
    assert.ok(layer.nodeIds.every((id) => nodeIdSet.has(id)));
  }
  // Tokens must never carry the access token into the graph.
  assert.ok(!JSON.stringify(graph).includes(TOKEN));
});

test('buildDesignGraph: falls back to fileKey for project.name and empty doc is safe', () => {
  const doc = {
    version: 'v1',
    document: { id: '0:0', type: 'DOCUMENT', children: [
      { id: 'p:1', type: 'CANVAS', name: 'Only', children: [] },
    ] },
  };
  const graph = buildDesignGraph(doc, KEY);
  assert.equal(graph.project.name, KEY);
  assert.equal(graph.meta.stats.pages, 1);
  assert.equal(graph.meta.stats.screens, 0);

  const empty = buildDesignGraph({ document: { children: [] } }, KEY);
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.edges.length, 0);
  assert.equal(empty.layers.length, 0);
  assert.equal(empty.tour.length, 0);
});

test('buildDesignGraph: recursion depth cap stops runaway deep trees', () => {
  let node = { id: 'deep:leaf', type: 'COMPONENT', name: 'Deep Component' };
  for (let i = 20; i >= 1; i--) {
    node = { id: `n:${i}`, type: 'FRAME', name: `Level ${i}`, children: [node] };
  }
  const doc = {
    name: 'Deep', version: '',
    document: { id: '0:0', type: 'DOCUMENT', children: [
      { id: 'p:1', type: 'CANVAS', name: 'P', children: [node] },
    ] },
  };
  const graph = buildDesignGraph(doc, KEY);
  // The top-level FRAME becomes a screen (depth 1); the leaf COMPONENT lies
  // well beyond MAX_DEPTH and must never be reached.
  assert.ok(graph.nodes.some((n) => n.id === 'screen:n:1'));
  assert.ok(!graph.nodes.some((n) => n.id === 'component:deep:leaf'));
  assert.equal(graph.truncated, true);
  assert.equal(graph.meta.stats.truncated, true);
  assert.ok(graph.nodes.length < 10);
});

test('buildDesignGraph: node cap of 5000 stops traversal and records truncated', () => {
  const doc = {
    name: 'Big', version: '',
    document: { id: '0:0', type: 'DOCUMENT', children: [
      {
        id: 'p:1', type: 'CANVAS', name: 'P',
        children: Array.from({ length: 6000 }, (_, i) => ({
          id: `c:${i}`, type: 'COMPONENT', name: `C${i}`,
        })),
      },
    ] },
  };
  const graph = buildDesignGraph(doc, KEY);
  assert.equal(graph.nodes.length, 5000);
  assert.equal(graph.truncated, true);
  assert.equal(graph.meta.stats.truncated, true);
  assert.ok(graph.skippedNodes > 0);
  assert.equal(graph.meta.stats.components, 4999);
  const nodeIdSet = new Set(graph.nodes.map((n) => n.id));
  assert.ok(graph.edges.every(
    (e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target) && e.source !== e.target,
  ));
});
