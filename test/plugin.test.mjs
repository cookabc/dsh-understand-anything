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

const call = async (tools, toolName, args = {}) => {
  const tool = tools.get(toolName);
  assert.ok(tool, `missing tool ${toolName}`);
  const rendered = await tool.execute(args, { signal: undefined });
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
  apply(ctx, { language: 'zh' });
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
    assert.equal(impact.ok, true);
    assert.ok(Array.isArray(impact.upstreamEdges));

    const tour = await call(tools, 'ua_tour', { root, refresh: true });
    assert.equal(tour.ok, true);
    assert.ok(tour.steps.length > 0);

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
    assert.match(noGraph.error, /NO_GRAPH/);
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
    apply(ctx, {});
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
    apply(ctx, {});
    const prepared = await call(tools, 'ua_knowledge', { root: wiki, prepare: true });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.kind, 'knowledge');
    assert.ok(prepared.stats.articles >= 2);

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
    apply(ctx, {});
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
