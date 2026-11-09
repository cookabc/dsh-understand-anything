import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, name } from '../index.js';

function fakeCtx() {
  const tools = new Map();
  const skills = new Map();
  const disposers = [];
  const scope = {
    tools: {
      register(def) {
        assert.equal(typeof def.name, 'string');
        assert.equal(typeof def.description, 'string');
        assert.equal(typeof def.execute, 'function');
        assert.equal(typeof def.output.render, 'function');
        tools.set(def.name, def);
        const dispose = () => tools.delete(def.name);
        disposers.push(dispose);
        return dispose;
      },
    },
    skills: {
      register(skill) {
        assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        assert.ok(skill.description.length > 0);
        assert.ok(skill.content.length > 0);
        skills.set(skill.name, skill);
        const dispose = () => skills.delete(skill.name);
        disposers.push(dispose);
        return dispose;
      },
    },
  };
  const ctx = {
    inject(_deps, callback) {
      callback(scope);
      return () => {};
    },
  };
  return { ctx, tools, skills };
}

const call = async (tools, toolName, args = {}, exec = {}) => {
  const tool = tools.get(toolName);
  assert.ok(tool, `missing tool ${toolName}`);
  const rendered = await tool.execute(args, exec);
  assert.equal(typeof rendered, 'string');
  const content = tool.output.render(args, rendered);
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, rendered);
  return JSON.parse(rendered);
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ua-plugin-'));
  await mkdir(join(root, 'src/api'), { recursive: true });
  await mkdir(join(root, 'src/utils'), { recursive: true });
  await writeFile(join(root, 'src/index.js'), 'import { helper } from "./utils/helper.js";\nimport { auth } from "./api/auth.js";\nexport function main() { helper(); auth(); }\n');
  await writeFile(join(root, 'src/utils/helper.js'), 'export function helper() { return 1; }\n');
  await writeFile(join(root, 'src/api/auth.js'), 'export function authenticate(user) { return user; }\nexport function auth() {}\n');
  await writeFile(join(root, 'README.md'), '# Overview\n');
  return root;
}

test('apply(): registers 14 wire-level tools and 8 embedded skills', () => {
  assert.equal(name, 'dsh-understand-anything');
  const { ctx, tools, skills } = fakeCtx();
  apply(ctx, { language: 'zh', experimental: true });
  assert.deepEqual([...tools.keys()].sort(), [
    'ua_annotate', 'ua_auto_update', 'ua_config', 'ua_dashboard', 'ua_diff',
    'ua_domain', 'ua_explain', 'ua_figma', 'ua_hook', 'ua_knowledge',
    'ua_query', 'ua_scan', 'ua_status', 'ua_tour',
  ]);
  assert.deepEqual([...skills.keys()].sort(), [
    'understand-anything', 'understand-anything-auto-update',
    'understand-anything-chat', 'understand-anything-diff',
    'understand-anything-domain', 'understand-anything-figma',
    'understand-anything-knowledge', 'understand-anything-onboard',
  ]);
  for (const [toolName, def] of tools) {
    assert.equal(def.parameters.type, 'object', `${toolName} parameters must be object-rooted`);
    assert.ok(def.parameters.properties);
    assert.equal(def.parameters.additionalProperties, false);
    assert.equal(def.output.schema.type, 'string');
    assert.doesNotThrow(() => JSON.stringify(def.parameters), `${toolName} schema must be lossless JSON`);
  }
  for (const [skillName, skill] of skills) {
    assert.equal(skill.source, 'bundled');
    assert.equal(skill.invocation.modelInvocable, true);
    assert.equal(skill.invocation.userInvocable, true);
    assert.ok(!skill.content.startsWith('---'), `${skillName} frontmatter must be stripped`);
  }
});

test('end-to-end tool flow on a fixture project', async () => {
  const root = await fixture();
  try {
    const { ctx, tools } = fakeCtx();
    apply(ctx, {});

    const missing = await call(tools, 'ua_status', { root });
    assert.equal(missing.exists, false);

    const scanned = await call(tools, 'ua_scan', { root, language: 'zh' });
    assert.equal(scanned.ok, true);
    assert.equal(scanned.incremental, false);
    assert.ok(scanned.stats.nodes > 5);
    assert.ok(scanned.stats.edges > 3);
    assert.equal(scanned.language, 'zh');

    const status = await call(tools, 'ua_status', { root });
    assert.equal(status.exists, true);
    assert.equal(status.overview.generator, 'dsh-understand-anything');

    const hits = await call(tools, 'ua_query', { root, query: 'authenticate auth' });
    assert.ok(hits.matches.length > 0);
    const nodeId = hits.matches.find((m) => m.name === 'authenticate')?.id
      ?? hits.matches[0].id;
    const detail = await call(tools, 'ua_explain', { root, nodeId });
    assert.equal(detail.ok, true);
    assert.ok(detail.excerpt !== null);

    const annotated = await call(tools, 'ua_annotate', {
      root,
      annotations: [
        { nodeId: 'file:src/api/auth.js', summary: '认证入口', tags: ['auth', 'security'], layer: 'API' },
        { nodeId: 'bogus:id', summary: 'ignored' },
      ],
    });
    assert.equal(annotated.count, 1);
    assert.deepEqual(annotated.unknown, ['bogus:id']);

    const rescanned = await call(tools, 'ua_scan', { root });
    assert.equal(rescanned.incremental, true);
    assert.ok(rescanned.stats.reusedNodes > 0);
    const after = await call(tools, 'ua_query', { root, query: '认证入口' });
    assert.ok(after.matches.some((m) => m.summary === '认证入口'));

    const impact = await call(tools, 'ua_diff', { root });
    assert.equal(impact.ok, false);
    assert.equal(impact.error, 'GIT_UNAVAILABLE');

    const tour = await call(tools, 'ua_tour', { root, refresh: true });
    assert.equal(tour.ok, true);
    assert.ok(tour.steps.length > 0);
    // Small fixture: everything fits in the default page, so nothing is truncated.
    assert.equal(tour.totalSteps, tour.steps.length);
    assert.equal(tour.truncated, false);
    assert.equal(tour.returnedFrom, 1);
    assert.equal(tour.returnedTo, tour.steps.length);

    const dashboard = await call(tools, 'ua_dashboard', { root });
    assert.equal(dashboard.ok, true);
    assert.equal(dashboard.offline, true);
    assert.ok((await stat(dashboard.path)).size > 1000);

    const config = await call(tools, 'ua_config', { root, language: 'en' });
    assert.equal(config.config.language, 'en');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tool argument validation is reported as a normal result', async () => {
  const root = await fixture();
  try {
    const { ctx, tools } = fakeCtx();
    apply(ctx, {});
    const missing = await call(tools, 'ua_query', { root });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'INVALID_ARGUMENTS');
    const unknown = await call(tools, 'ua_status', { root, nope: 1 });
    assert.equal(unknown.error, 'INVALID_ARGUMENTS');
    assert.ok(unknown.violations.some((v) => v.includes('nope')));
    const noGraph = await call(tools, 'ua_query', { root, query: 'x' });
    assert.equal(noGraph.ok, false);
    assert.equal(noGraph.error, 'NO_GRAPH');
    assert.ok(typeof noGraph.hint === 'string' && noGraph.hint.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ua_scan honors scope and full rebuild', async () => {
  const root = await fixture();
  try {
    const { ctx, tools } = fakeCtx();
    apply(ctx, {});
    const scoped = await call(tools, 'ua_scan', { root, scope: 'src/api' });
    assert.equal(scoped.ok, true);
    assert.equal(scoped.scope, 'src/api');
    assert.ok(scoped.stats.files > 0);
    const full = await call(tools, 'ua_scan', { root, full: true });
    assert.equal(full.incremental, false);
    assert.ok(full.stats.files > scoped.stats.files);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ua_domain: prepare → analysis → domain dashboard', async () => {
  const root = await fixture();
  try {
    const { ctx, tools } = fakeCtx();
    apply(ctx, { experimental: true });
    await call(tools, 'ua_scan', { root });
    const prepared = await call(tools, 'ua_domain', { root, prepare: true });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.mode, 'prepare');
    assert.ok(prepared.context.analysisSchema);
    assert.ok(prepared.context.stats.files > 0);

    const saved = await call(tools, 'ua_domain', {
      root,
      analysis: {
        domains: [{ name: 'Authentication', description: 'Login and identity' }],
        flows: [{ name: 'Sign in', steps: [{ name: 'Validate credentials' }, { name: 'Issue session' }] }],
      },
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.kind, 'domain');
    assert.ok(saved.stats.domains >= 1);
    assert.ok(saved.stats.flows >= 1);
    assert.equal(saved.modelAdditions.domains, 1);

    const dash = await call(tools, 'ua_dashboard', { root, graph: 'domain' });
    assert.equal(dash.kind, 'domain');
    assert.match(dash.path, /dashboard-domain\.html$/);
    assert.ok((await stat(dash.path)).size > 1000);
    const auto = await call(tools, 'ua_dashboard', { root, graph: 'auto' });
    assert.equal(auto.kind, 'domain');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ua_knowledge: wiki detection, deterministic graph and enrichment', async () => {
  const wiki = await mkdtemp(join(tmpdir(), 'ua-wiki-'));
  try {
    await mkdir(join(wiki, 'raw'), { recursive: true });
    await writeFile(join(wiki, 'index.md'), '# Index\n## Concepts\n- [[Alpha]]\n- [[Beta]]\n');
    await writeFile(join(wiki, 'Alpha.md'), '# Alpha\nSee [[Beta]] and [[raw/paper.pdf]].\n');
    await writeFile(join(wiki, 'Beta.md'), '# Beta\nBack to [[Alpha]].\n');
    await writeFile(join(wiki, 'raw/paper.pdf'), 'binary');
    const { ctx, tools } = fakeCtx();
    apply(ctx, { experimental: true });
    const prepared = await call(tools, 'ua_knowledge', { root: wiki, prepare: true });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.kind, 'knowledge');
    assert.ok(prepared.stats.articles >= 2);
    // Prepare is a bounded context, not the whole graph: no nodes/edges dump.
    assert.equal(prepared.graph, undefined);
    assert.ok(prepared.sample.articles.length >= 2);
    assert.ok(prepared.sample.articles.every((a) => a.id.startsWith('article:')));
    assert.deepEqual(Object.keys(prepared.analysisSchema).sort(), ['claims', 'entities', 'relations']);

    const saved = await call(tools, 'ua_knowledge', {
      root: wiki,
      analysis: {
        entities: [{ name: 'Graph Theory', article: 'article:Alpha.md' }],
        claims: [{ text: 'Wikilinks form a graph', article: 'article:Beta.md' }],
        relations: [{ source: 'article:Alpha.md', target: 'article:Beta.md', type: 'implicit' }],
      },
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.kind, 'knowledge');
    assert.ok(saved.stats.edges > 0);
    assert.equal(saved.modelAdditions.entities, 1);
    const graph = JSON.parse(await readFile(saved.path, 'utf8'));
    assert.equal(graph.kind, 'knowledge');
    const ids = new Set(graph.nodes.map((n) => n.id));
    assert.ok(graph.edges.every((e) => ids.has(e.source) && ids.has(e.target)));
  } finally {
    await rm(wiki, { recursive: true, force: true });
  }
});

test('ua_figma: missing token, invalid key, and a mocked successful scan', async () => {
  const root = await fixture();
  const previousToken = process.env.FIGMA_TOKEN;
  const previousFetch = globalThis.fetch;
  try {
    const { ctx, tools } = fakeCtx();
    apply(ctx, { experimental: true });
    delete process.env.FIGMA_TOKEN;
    const missing = await call(tools, 'ua_figma', { root, urlOrKey: 'https://www.figma.com/file/abcdefghijkl/Title' });
    assert.equal(missing.error, 'FIGMA_TOKEN_MISSING');

    const invalid = await call(tools, 'ua_figma', { root, urlOrKey: '!!!' });
    assert.equal(invalid.ok, false);

    const figmaTestToken = 'ua-test-token';
    process.env.FIGMA_TOKEN = figmaTestToken;
    const doc = {
      name: 'Test Design', version: 'v1',
      styles: { S1: { name: 'Primary', styleType: 'FILL' } },
      document: {
        id: '0:0', name: 'Document', type: 'DOCUMENT',
        children: [{
          id: '1:1', name: 'Page 1', type: 'CANVAS',
          children: [{
            id: '2:1', name: 'Home', type: 'FRAME', styles: { fill: 'S1' },
            children: [
              { id: '3:1', name: 'Button', type: 'COMPONENT', children: [] },
              { id: '4:1', name: 'Btn Instance', type: 'INSTANCE', componentId: '3:1', children: [] },
            ],
          }],
        }],
      },
    };
    let requestHeaders = null;
    globalThis.fetch = async (_url, init) => {
      requestHeaders = init.headers;
      return { status: 200, json: async () => doc, text: async () => '' };
    };
    const scanned = await call(tools, 'ua_figma', { root, urlOrKey: 'https://www.figma.com/design/abcdefghijkl/Test' });
    assert.equal(scanned.ok, true);
    assert.equal(scanned.kind, 'design');
    assert.equal(scanned.version, 'v1');
    assert.ok(scanned.stats.pages >= 1);
    assert.equal(requestHeaders['X-Figma-Token'], figmaTestToken);
    assert.ok(!JSON.stringify(scanned).includes(figmaTestToken));

    const upToDate = await call(tools, 'ua_figma', { root, urlOrKey: 'https://www.figma.com/design/aaaaaaaaaaaa/Test' });
    assert.equal(upToDate.upToDate, true);
    const dash = await call(tools, 'ua_dashboard', { root, graph: 'design' });
    assert.equal(dash.kind, 'design');
    assert.match(dash.path, /dashboard-design\.html$/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.FIGMA_TOKEN;
    else process.env.FIGMA_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('ua_auto_update and ua_hook on a non-git directory', async () => {
  const root = await fixture();
  try {
    const { ctx, tools } = fakeCtx();
    apply(ctx, {});
    const status = await call(tools, 'ua_hook', { root, action: 'status' });
    assert.equal(status.gitRepository, false);
    assert.equal(status.installed, false);
    const install = await call(tools, 'ua_hook', { root, action: 'install' });
    assert.equal(install.ok, false);
    assert.equal(install.error, 'NOT_A_GIT_REPOSITORY');

    const config = await call(tools, 'ua_config', { root, autoUpdate: true });
    assert.equal(config.config.autoUpdate, true);
    await call(tools, 'ua_scan', { root });
    const check = await call(tools, 'ua_auto_update', { root, apply: false });
    assert.equal(check.ok, true);
    assert.equal(check.configAutoUpdate, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('code scans and auto-update preserve existing knowledge graphs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ua-protect-wiki-'));
  try {
    const { saveGraph } = await import('../lib/graph.mjs');
    await saveGraph(root, { kind: 'knowledge', project: {}, nodes: [], edges: [], layers: [], tour: [], meta: {} });
    const path = join(root, '.ua/knowledge-graph.json');
    const before = await readFile(path, 'utf8');
    const { ctx, tools } = fakeCtx(); apply(ctx);
    assert.equal((await call(tools, 'ua_scan', { root, full: true })).error, 'KNOWLEDGE_GRAPH_EXISTS');
    assert.equal((await call(tools, 'ua_auto_update', { root })).reason, 'NOT_CODE_GRAPH');
    assert.equal(await readFile(path, 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('normalized scan scopes produce canonical node paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ua-scope-normalize-'));
  try {
    await mkdir(join(root, 'src')); await writeFile(join(root, 'src/a.js'), 'export const a = 1');
    const { ctx, tools } = fakeCtx(); apply(ctx);
    for (const scope of ['.', 'src/../src', join(root, 'src')]) {
      const result = await call(tools, 'ua_scan', { root, scope });
      assert.equal(result.ok, true);
      const graph = JSON.parse(await readFile(result.path, 'utf8'));
      assert.ok(graph.nodes.some((n) => n.id === 'file:src/a.js'), scope);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ua_tour: bounded steps, truncation flags and from/limit pagination', async () => {
  // Many tiny files: buildTour chunks 6 files per step, so ~200 files => ~34 steps,
  // which is above the default page of 20 and below the limit cap of 100.
  const root = await mkdtemp(join(tmpdir(), 'ua-tour-bound-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    for (let i = 0; i < 200; i++) {
      await writeFile(join(root, 'src', `f${String(i).padStart(3, '0')}.js`), `export const v = ${i};\n`);
    }
    const { ctx, tools } = fakeCtx(); apply(ctx);
    const scanned = await call(tools, 'ua_scan', { root, full: true, language: 'en' });
    assert.equal(scanned.ok, true);
    assert.ok(scanned.tourSteps > 20, `fixture tour should exceed the default page, got ${scanned.tourSteps}`);

    // Default call: first 20 steps only, explicitly marked as truncated.
    const dflt = await call(tools, 'ua_tour', { root });
    assert.equal(dflt.ok, true);
    assert.equal(dflt.totalSteps, scanned.tourSteps);
    assert.equal(dflt.steps.length, 20);
    assert.equal(dflt.returnedFrom, 1);
    assert.equal(dflt.returnedTo, 20);
    assert.equal(dflt.truncated, true);
    assert.match(dflt.hint, /ua_dashboard/);

    // The default page is a legal prefix of the full tour, so old callers stay valid.
    const full = await call(tools, 'ua_tour', { root, limit: 100 });
    assert.equal(full.totalSteps, scanned.tourSteps);
    assert.equal(full.steps.length, scanned.tourSteps);
    assert.equal(full.truncated, false);
    assert.equal(full.returnedTo, scanned.tourSteps);
    assert.equal(full.hint, undefined);
    assert.deepEqual(dflt.steps, full.steps.slice(0, 20));

    // Second page continues where the first stopped, with no overlap.
    const page2 = await call(tools, 'ua_tour', { root, from: 21, limit: 20 });
    assert.equal(page2.returnedFrom, 21);
    assert.equal(page2.returnedTo, Math.min(40, scanned.tourSteps));
    assert.deepEqual(page2.steps, full.steps.slice(20, page2.returnedTo));
    const firstIds = new Set(dflt.steps.map((s) => s.order));
    assert.ok(page2.steps.every((s) => !firstIds.has(s.order)));

    // An explicit small limit also truncates.
    const small = await call(tools, 'ua_tour', { root, limit: 5 });
    assert.equal(small.steps.length, 5);
    assert.equal(small.returnedFrom, 1);
    assert.equal(small.returnedTo, 5);
    assert.equal(small.truncated, true);

    // Out-of-range limit is clamped to the cap, not an error: the whole 34-step
    // tour comes back and truncated is false because nothing was dropped.
    const greedy = await call(tools, 'ua_tour', { root, limit: 500 });
    assert.equal(greedy.ok, true);
    assert.equal(greedy.steps.length, scanned.tourSteps);
    assert.equal(greedy.truncated, false);
    assert.equal(greedy.returnedTo, scanned.tourSteps);

    // from past the end returns an empty page, still flagged as incomplete.
    const beyond = await call(tools, 'ua_tour', { root, from: scanned.tourSteps + 10 });
    assert.equal(beyond.ok, true);
    assert.deepEqual(beyond.steps, []);
    assert.equal(beyond.totalSteps, scanned.tourSteps);
    assert.equal(beyond.returnedFrom, 0);
    assert.equal(beyond.returnedTo, 0);
    assert.equal(beyond.truncated, true);
    assert.match(beyond.hint, /past the end/);

    // refresh rebuilds and persists in full, but the response stays bounded.
    const refreshed = await call(tools, 'ua_tour', { root, refresh: true, limit: 3 });
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.refreshed, true);
    assert.equal(refreshed.steps.length, 3);
    assert.equal(refreshed.totalSteps, scanned.tourSteps);
    assert.equal(refreshed.truncated, true);
    assert.match(refreshed.hint, /rebuilt/i);
    const stored = JSON.parse(await readFile(join(root, '.ua/knowledge-graph.json'), 'utf8'));
    assert.equal(stored.tour.length, scanned.tourSteps);

    // Non-positive integers are rejected by the shared integer() validation.
    const badLimit = await call(tools, 'ua_tour', { root, limit: 0 });
    assert.equal(badLimit.ok, false);
    assert.equal(badLimit.error, 'INVALID_ARGUMENTS');
    assert.ok(badLimit.violations.some((v) => v.includes('limit')));

    const badFrom = await call(tools, 'ua_tour', { root, from: 0 });
    assert.equal(badFrom.ok, false);
    assert.equal(badFrom.error, 'INVALID_ARGUMENTS');
    assert.ok(badFrom.violations.some((v) => v.includes('from')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ua_tour: an empty stored tour returns an empty page, not an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ua-tour-empty-'));
  try {
    const { saveGraph } = await import('../lib/graph.mjs');
    await saveGraph(root, { project: {}, nodes: [], edges: [], layers: [], tour: [], meta: {} });
    const { ctx, tools } = fakeCtx(); apply(ctx);
    const empty = await call(tools, 'ua_tour', { root });
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.steps, []);
    assert.equal(empty.totalSteps, 0);
    assert.equal(empty.returnedFrom, 0);
    assert.equal(empty.returnedTo, 0);
    assert.equal(empty.truncated, false);
    assert.equal(empty.hint, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('boundary: ua_tour from/limit are positive integers only, no string coercion', async () => {
  // checkArgs rejects floats/strings before the tool itself ever clamps,
  // so from:'21' or from:21.5 must be INVALID_ARGUMENTS, not a silent coerce.
  const root = await mkdtemp(join(tmpdir(), 'ua-tour-boundary-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.js'), 'export const a = 1;\n');
    const { ctx, tools } = fakeCtx(); apply(ctx);
    await call(tools, 'ua_scan', { root, full: true });
    for (const [args, key] of [
      [{ root, limit: '20' }, 'limit'],
      [{ root, limit: 5.5 }, 'limit'],
      [{ root, limit: true }, 'limit'],
      [{ root, from: '21' }, 'from'],
      [{ root, from: 21.5 }, 'from'],
      [{ root, from: -1 }, 'from'],
      [{ root, limit: -1 }, 'limit'],
    ]) {
      const out = await call(tools, 'ua_tour', args);
      assert.equal(out.ok, false, `should reject ${JSON.stringify(args)}`);
      assert.equal(out.error, 'INVALID_ARGUMENTS');
      assert.ok(out.violations.some((v) => v.includes(key)), `violation mentions ${key}: ${out.violations}`);
    }
    // boundary values pass
    const ok = await call(tools, 'ua_tour', { root, limit: 1, from: 1 });
    assert.equal(ok.ok, true);
    assert.equal(ok.steps.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('boundary: an aborted signal surfaces SCAN_CANCELLED with cancelled:true', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ua-abort-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.js'), 'export const a = 1;\n');
    const { ctx, tools } = fakeCtx(); apply(ctx);
    const cancelled = await call(tools, 'ua_scan', { root }, { signal: AbortSignal.abort() });
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error, 'SCAN_CANCELLED');
    assert.equal(cancelled.cancelled, true);
    // a non-scanning tool on the same aborted signal must NOT be SCAN_CANCELLED
    // (it is not a scan; it should not inherit scan-cancel semantics)
    await call(tools, 'ua_scan', { root, full: true });
    const tourCancelled = await call(tools, 'ua_tour', { root }, { signal: AbortSignal.abort() });
    assert.notEqual(tourCancelled.error, 'SCAN_CANCELLED', `read-only tour must not masquerade as a cancelled scan (got ${tourCancelled.error})`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
