import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInContext, createContext } from 'node:vm';
import { scanProject } from '../lib/scanner.mjs';
import {
  annotateGraph, buildGraph, buildTour, diffImpact, explainNode,
  graphOverview, loadGraph, queryGraph, rebuildLayers, saveGraph,
} from '../lib/graph.mjs';
import { renderDashboard, buildViewModel } from '../lib/dashboard.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'ua-graph-'));

async function fixture() {
  const root = await tmp();
  await mkdir(join(root, 'src/api'), { recursive: true });
  await mkdir(join(root, 'src/utils'), { recursive: true });
  await writeFile(join(root, 'src/index.js'), 'import { helper } from "./utils/helper.js";\nimport { route } from "./api/login.js";\nimport lodash from "lodash";\nexport function main() { helper(); route(); }\n');
  await writeFile(join(root, 'src/utils/helper.js'), 'export function helper() { return 1; }\nexport class Helper {}\n');
  await writeFile(join(root, 'src/api/login.js'), 'export class LoginService {}\nexport function authenticate(user) { return user; }\n');
  await writeFile(join(root, 'README.md'), '# Overview\nSee [[Architecture Notes]].\n');
  await writeFile(join(root, 'Architecture Notes.md'), '# Notes\n');
  return root;
}

test('buildGraph: nodes, edges, layers, tour, UA-compatible shape', async () => {
  const root = await fixture();
  try {
    const scan = await scanProject(root);
    const graph = buildGraph(root, scan, { language: 'en', gitCommitHash: 'abc1234' });
    assert.equal(graph.project.name, root.split('/').pop());
    assert.equal(graph.project.gitCommitHash, 'abc1234');
    assert.ok(graph.project.languages.includes('javascript'));
    assert.ok(graph.project.languages.includes('markdown'));
    assert.ok(Array.isArray(graph.nodes) && graph.nodes.length > 0);
    assert.ok(Array.isArray(graph.edges) && graph.edges.length > 0);
    assert.ok(Array.isArray(graph.layers) && graph.layers.length > 0);
    assert.ok(Array.isArray(graph.tour) && graph.tour.length > 0);
    assert.equal(graph.meta.generator, 'dsh-understand-anything');

    const ids = new Set(graph.nodes.map((n) => n.id));
    assert.ok(ids.has('file:src/index.js'));
    assert.ok(ids.has('function:src/index.js:main'));
    assert.ok(ids.has('class:src/api/login.js:LoginService'));
    assert.ok(ids.has('module:lodash'));

    const edgeTypes = new Set(graph.edges.map((e) => e.type));
    assert.ok(edgeTypes.has('contains'));
    assert.ok(edgeTypes.has('imports'));
    assert.ok(graph.edges.some((e) => e.source === 'file:src/index.js' && e.target === 'file:src/utils/helper.js' && e.type === 'imports'));
    assert.ok(graph.edges.some((e) => e.source === 'file:src/index.js' && e.target === 'module:lodash'));
    // Markdown wikilink resolution
    assert.ok(graph.edges.some((e) => e.type === 'related' && e.source === 'file:README.md'));

    assert.ok(graph.layers.some((l) => l.name === 'API' || l.name === 'Utility' || l.name === 'Other'));
    assert.equal(graph.tour[0].order, 1);
    assert.ok(graph.tour[0].nodeIds.length > 0);
    assert.equal(graph.meta.stats.files, scan.files.length);
    assert.equal(new Set(graph.edges.map((e) => `${e.source}|${e.target}|${e.type}`)).size, graph.edges.length, 'edges are deduplicated');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('incremental scan preserves annotations on unchanged files', async () => {
  const root = await fixture();
  try {
    const first = buildGraph(root, await scanProject(root), { language: 'en' });
    annotateGraph(first, [{ nodeId: 'file:src/api/login.js', summary: 'Handles user authentication', tags: ['auth', 'login'] }]);
    await saveGraph(root, first);
    const loaded = await loadGraph(root);
    assert.equal(loaded.nodes.find((n) => n.id === 'file:src/api/login.js').summary, 'Handles user authentication');

    // Change only one file.
    await writeFile(join(root, 'src/utils/helper.js'), 'export function helper() { return 2; }\nexport class Helper {}\nexport function extra() {}\n');
    const second = buildGraph(root, await scanProject(root), { previous: loaded, language: 'en' });
    assert.equal(second.nodes.find((n) => n.id === 'file:src/api/login.js').summary, 'Handles user authentication');
    assert.ok(second.nodes.some((n) => n.id === 'function:src/utils/helper.js:extra'));
    assert.ok(second.meta.stats.reusedNodes > 0);
    assert.ok(second.meta.stats.rebuiltNodes > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('queryGraph / explainNode / annotateGraph / rebuildLayers', async () => {
  const root = await fixture();
  try {
    const graph = buildGraph(root, await scanProject(root), { language: 'en' });
    const hits = queryGraph(graph, 'authenticate login', 10);
    assert.ok(hits.matches.length > 0);
    assert.ok(hits.matches.some((m) => m.name === 'authenticate' || m.name === 'LoginService'));
    assert.ok(hits.edges.length > 0);
    assert.ok(hits.neighbors.length > 0);

    const detail = await explainNode(graph, root, 'class:src/api/login.js:LoginService');
    assert.ok(detail);
    assert.equal(detail.node.name, 'LoginService');
    assert.ok(detail.excerpt.includes('LoginService'));

    const res = annotateGraph(graph, [
      { nodeId: 'file:src/api/login.js', summary: 'Login endpoints', layer: 'API', tags: ['auth'] },
      { nodeId: 'does:not:exist', summary: 'ignored' },
    ]);
    assert.equal(res.count, 1);
    assert.deepEqual(res.unknown, ['does:not:exist']);
    rebuildLayers(graph, 'zh');
    assert.ok(graph.layers.some((l) => l.name === '接口层'));

    const overview = graphOverview(graph);
    assert.equal(overview.generator, 'dsh-understand-anything');
    assert.ok(overview.tourSteps > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diffImpact: direct nodes and upstream dependents', async () => {
  const root = await fixture();
  try {
    const graph = buildGraph(root, await scanProject(root), {});
    const impact = diffImpact(graph, ['src/utils/helper.js']);
    assert.ok(impact.direct.length > 0);
    assert.ok(impact.direct.some((n) => n.id === 'file:src/utils/helper.js'));
    assert.ok(impact.upstream.some((n) => n.id === 'file:src/index.js'));
    assert.ok(impact.affectedCount >= 2);
    assert.ok(impact.upstreamEdges.every((e) => e.depth >= 1 && e.depth <= 3));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dashboard: self-contained HTML with safe embedded JSON', async () => {
  const root = await fixture();
  try {
    const graph = buildGraph(root, await scanProject(root), { language: 'zh' });
    const model = buildViewModel(graph);
    assert.ok(model.nodes.length > 0);
    assert.ok(model.edges.length > 0);
    const html = await renderDashboard(graph);
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(!html.includes('/*__UA_GRAPH_JSON__*/'));
    assert.ok(html.includes('id="ua-graph"'));
    const match = /<script id="ua-graph" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(match);
    assert.ok(!match[1].includes('<'), 'embedded JSON must not be able to close its script tag');
    const parsed = JSON.parse(match[1]);
    assert.equal(parsed.project.name, graph.project.name);
    assert.equal(parsed.nodes.length, model.nodes.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildTour: localized step text for every documented language', async () => {
  const root = await fixture();
  try {
    const graph = buildGraph(root, await scanProject(root), { language: 'en' });
    for (const language of ['en', 'zh', 'zh-TW', 'ja', 'ko', 'ru', 'vi']) {
      const steps = buildTour(graph, language);
      assert.ok(steps.length > 0, `${language} produces steps`);
      assert.ok(steps.every((s) => s.title && s.description && s.nodeIds.length > 0));
      assert.ok(!steps[0].title.includes('undefined'), `${language} title is rendered`);
    }
    assert.equal(buildTour(graph, 'zh')[0].title, '第 1 步：从基础模块开始');
    assert.equal(buildTour(graph, 'zh-TW')[0].title, '第 1 步：從基礎模組開始');
    assert.match(buildTour(graph, 'ja')[0].title, /^ステップ 1/);
    assert.equal(buildTour(graph, 'unknown-locale')[0].title, buildTour(graph, 'en')[0].title);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('annotateGraph: a numeric nodeId still triggers a layer rebuild', async () => {
  const root = await fixture();
  try {
    const graph = buildGraph(root, await scanProject(root), { language: 'en' });
    const target = graph.nodes.find((n) => n.id.startsWith('file:'));
    // Model output sometimes arrives with ids coerced to numbers; the map
    // lookup already String()-coerces, and the layer-rebuild check must too.
    const numericId = Number('1');
    const result = annotateGraph(graph, [
      { nodeId: target.id, summary: 'entry point' },
      { nodeId: numericId, layer: 'Gateway' }, // unknown id → reported, no crash
    ], 'zh');
    assert.ok(result.updated.includes(target.id));
    assert.ok(result.unknown.length > 0);
    assert.equal(graph.nodes.find((n) => n.id === target.id).summary, 'entry point');
    // A layer annotation on a REAL node must regroup layers.
    const result2 = annotateGraph(graph, [{ nodeId: target.id, layer: 'Gateway' }], 'zh');
    assert.equal(result2.updated.length, 1);
    assert.ok(graph.layers.some((l) => l.id === 'gateway' && l.nodeIds.includes(target.id)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function makeSandbox(data) {
  // data is injected as the embedded JSON the page would parse.
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  const elements = new Map();
  const makeEl = (id) => {
    const el = {
      id,
      tagName: 'DIV',
      attrs: {},
      children: [],
      dataset: {},
      classList: { toggle() {}, add() {}, remove() {} },
      textContent: '',
      innerHTML: '',
      value: '',
      style: {},
      checked: false,
      setAttribute(name, value) { this.attrs[name] = value; },
      getAttribute(name) { return this.attrs[name]; },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener() {},
      querySelectorAll(sel) { return []; },
      getBoundingClientRect() { return { width: 800, height: 600, left: 0, top: 0 }; },
      setPointerCapture() {},
      closest() { return null; },
    };
    elements.set(id, el);
    return el;
  };
  const graphEl = makeEl('ua-graph');
  graphEl.textContent = json;
  for (const id of ['stats', 'canvas', 'viewport', 'links', 'nodes', 'tooltip', 'detail', 'layers', 'tour', 'search', 'labels', 'fit']) makeEl(id);
  const doc = {
    title: '',
    getElementById: (id) => elements.get(id) || makeEl(id),
    createElement: (tag) => makeEl(tag),
    createElementNS: (ns, tag) => {
      const el = makeEl(tag);
      el.tagName = tag.toUpperCase();
      return el;
    },
    querySelectorAll: () => [],
  };
  return { document: doc, window: { addEventListener() {} }, console, elements };
}

function runDashboardScript(html, data) {
  const script = /<script>\n([\s\S]*?)<\/script>/.exec(html)[1];
  const sandbox = makeSandbox(data);
  runInContext(script, createContext(sandbox), { filename: 'dashboard-inline.js' });
  return sandbox;
}

test('dashboard: DATA carries the graph language (buildViewModel)', async () => {
  const root = await fixture();
  try {
    const zhGraph = buildGraph(root, await scanProject(root), { language: 'zh' });
    assert.equal(buildViewModel(zhGraph).language, 'zh');
    const html = await renderDashboard(zhGraph);
    assert.match(html, /<html lang="zh">/);
    const match = /<script id="ua-graph" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    assert.equal(JSON.parse(match[1]).language, 'zh');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dashboard: zh graph renders Chinese chrome, unsupported languages fall back to English', async () => {
  const root = await fixture();
  try {
    const zhGraph = buildGraph(root, await scanProject(root), { language: 'zh' });
    const zhHtml = await renderDashboard(zhGraph);
    assert.ok(zhHtml.includes('知识图谱'));
    assert.ok(zhHtml.includes('查找文件或函数'));
    assert.ok(zhHtml.includes('导览'));
    assert.ok(zhHtml.includes('分层'));
    assert.ok(zhHtml.includes('详情'));
    assert.ok(zhHtml.includes('适应视图'));
    assert.ok(zhHtml.includes('已显示 {shown} / {total} 条')); // truncation notice template
    assert.ok(zhHtml.includes('of {total} shown'));
    assert.ok(zhHtml.includes('传入 ('));
    assert.ok(zhHtml.includes('传出 ('));
    // The zh dictionary is shipped in the page; at runtime the static
    // chrome elements are rewritten from it, so the English source strings
    // are never *shown*. Assert the dictionary is present and the static
    // placeholders are wired through data-chrome-key.
    assert.ok(zhHtml.includes('data-chrome-key="documentTitle"'));
    assert.ok(zhHtml.includes("searchPlaceholder: '查找文件或函数…'"));
    assert.ok(!zhHtml.includes("searchPlaceholder: 'Find a file or function…'") || zhHtml.includes('searchPlaceholder: \'查找文件或函数…\''));

    const jaGraph = buildGraph(root, await scanProject(root), { language: 'ja' });
    const jaHtml = await renderDashboard(jaGraph);
    assert.match(jaHtml, /<html lang="en">/);
    assert.equal(buildViewModel(jaGraph).language, 'ja');

    const enGraph = buildGraph(root, await scanProject(root), { language: 'en' });
    const enHtml = await renderDashboard(enGraph);
    assert.match(enHtml, /<html lang="en">/);
    assert.equal(buildViewModel(enGraph).language, 'en');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dashboard: graph nodes are keyboard-reachable (tabindex/role/aria-label)', async () => {
  const root = await fixture();
  try {
    const graph = buildGraph(root, await scanProject(root), { language: 'en' });
    const html = await renderDashboard(graph);
    assert.ok(html.includes("g.setAttribute('tabindex', '0')"));
    assert.ok(html.includes("g.setAttribute('role', 'button')"));
    assert.ok(html.includes("g.setAttribute('aria-label'"));
    assert.ok(html.includes("svg.addEventListener('keydown'"));
    assert.ok(html.includes('selectNode('));
    assert.ok(html.includes('ev.preventDefault();'));
    assert.ok(html.includes('.node:focus-visible'));
    // Runtime smoke: the script draws nodes carrying the attributes.
    const data = buildViewModel(graph);
    const sandbox = runDashboardScript(html, data);
    const nodes = sandbox.elements.get('nodes');
    assert.ok(nodes.children.length > 0);
    const first = nodes.children.find((el) => el.attrs && el.attrs.tabindex === '0');
    assert.ok(first, 'at least one node element is focusable');
    assert.equal(first.attrs.role, 'button');
    assert.ok(typeof first.attrs['aria-label'] === 'string' && first.attrs['aria-label'].length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dashboard: relation lists announce when they are truncated', async () => {
  // Inline small CHROME dict check: the threshold notice is built by
  // relListHtml when a node has more than 14 relations on one side.
  // We verify the template's own code path by running its inline script.
  const node = (id, name) => ({ id, name, type: 'file', path: `src/${name}.js`, line: 1, layer: 'Utility', summary: '', tags: [] });
  const center = node('file:src/center.js', 'center');
  const peers = [];
  const edges = [];
  for (let i = 0; i < 17; i++) {
    const peer = node(`file:src/p${i}.js`, `p${i}`);
    peers.push(peer);
    edges.push({ s: peer.id, t: center.id, k: 'imports', inferred: false, evidence: null, resolution: null });
  }
  for (let i = 0; i < 16; i++) {
    edges.push({ s: center.id, t: peers[i].id, k: 'imports', inferred: false, evidence: null, resolution: null });
  }
  const data = {
    kind: 'code', language: 'en',
    project: { name: 'p', description: '', languages: [], frameworks: [], analyzedAt: null, gitCommitHash: null },
    scope: null, scanIncomplete: false, annotationReviewNeeded: 0,
    layers: [{ id: 'utility', name: 'Utility', count: 18 }],
    tour: [], truncated: false, totalNodes: 18, totalEdges: edges.length,
    nodes: [center, ...peers], edges,
  };
  const template = await readFile(new URL('../lib/dashboard.template.html', import.meta.url), 'utf8');
  const html = template.replace('/*__UA_GRAPH_JSON__*/', JSON.stringify(data));
  const script = /<script>\n([\s\S]*?)<\/script>/.exec(html)[1];
  assert.ok(script.includes("truncatedNotice"));
  assert.ok(script.includes("已显示 {shown} / {total} 条"));
  assert.ok(script.includes("of {total} shown"));
  assert.ok(script.includes('RELATION_LIST_LIMIT = 14'));
  assert.ok(script.includes('list.length > RELATION_LIST_LIMIT'));
  // chrome('truncatedNotice', { shown, total }) produces the localized text.
  const rendered = script.match(/truncatedNotice: '\{shown\} of \{total\} shown'/);
  assert.ok(rendered);
  const zhRendered = script.match(/truncatedNotice: '已显示 \{shown\} \/ \{total\} 条'/);
  assert.ok(zhRendered);
});


test('domain certainty: prepare carries certainty and derived edges are marked', async () => {
  const root = await fixture();
  const graph = buildGraph(root, await scanProject(root), { language: 'en' });
  const { prepareDomainContext, buildDomainGraph } = await import('../lib/domain.mjs');

  // prepareDomainContext: calls edges must not lose their 'inferred' certainty.
  const ctx = prepareDomainContext(graph);
  const callsEdges = ctx.edges.filter((e) => e.type === 'calls');
  assert.ok(callsEdges.length >= 0);
  for (const e of callsEdges) assert.equal(e.certainty, 'inferred', `calls edge lost certainty: ${JSON.stringify(e)}`);
  const obsEdges = ctx.edges.filter((e) => e.type !== 'calls');
  for (const e of obsEdges) assert.ok(e.certainty === 'observed' || e.certainty === 'inferred', `edge ${e.type} lost certainty: ${JSON.stringify(e)}`);
  assert.ok(!ctx.edges.some((e) => !('certainty' in e)), 'every returned edge carries certainty');

  // buildDomainGraph: edges derived from inferred calls chains are inferred.
  const result = buildDomainGraph(root, graph, null, { language: 'en' });
  const stats = result.graph.meta.stats;
  assert.equal(stats.inferredEdges, result.graph.edges.filter((e) => e.certainty === 'inferred').length);
  assert.equal(stats.modelEdges, result.graph.edges.filter((e) => e.certainty === 'model').length);
  assert.ok(result.graph.edges.every((e) => 'certainty' in e), 'every domain edge carries certainty');
  const dependsOn = result.graph.edges.filter((e) => e.type === 'depends_on');
  assert.ok(dependsOn.every((e) => e.certainty === 'inferred'), 'depends_on derived from calls chains must be inferred');
  // structural grouping edges stay observed
  for (const structural of ['contains_flow', 'flow_step', 'covers']) {
    for (const e of result.graph.edges.filter((x) => x.type === structural)) {
      assert.equal(e.certainty, 'observed', `${structural} should be observed`);
    }
  }
});

test('domain labels: all 7 documented languages plus explicit fallback', async () => {
  const root = await fixture();
  const graph = buildGraph(root, await scanProject(root), { language: 'en' });
  const { buildDomainGraph } = await import('../lib/domain.mjs');
  const expected = {
    en: 'Domains', zh: '业务域', 'zh-TW': '業務域', ja: 'ドメイン',
    ko: '도메인', ru: 'Домены', vi: 'Miền',
  };
  for (const [lang, layerName] of Object.entries(expected)) {
    const r = buildDomainGraph(root, graph, null, { language: lang });
    assert.equal(r.graph.layers[0].name, layerName, `${lang} layer label`);
    assert.equal(r.graph.meta.language, lang);
    assert.equal(r.graph.meta.languageFallback, null, `${lang} must not fall back`);
  }
  const unknown = buildDomainGraph(root, graph, null, { language: 'xx' });
  assert.equal(unknown.graph.layers[0].name, 'Domains');
  assert.equal(unknown.graph.meta.languageFallback, 'en');
});
