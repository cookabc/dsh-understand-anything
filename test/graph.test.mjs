import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
