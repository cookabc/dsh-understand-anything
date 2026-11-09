import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { apply } from '../index.js';
import { scanProject, extractSymbols, extractImports, extractCallSites } from '../lib/scanner.mjs';
import { buildGraph, annotateGraph, explainNode, diffImpact, saveGraph } from '../lib/graph.mjs';
import { refreshCodeGraph, sourceFreshness } from '../lib/lifecycle.mjs';
import { changedFiles } from '../lib/git.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ua-core-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/helper.js'), '\nexport function helper() { return 1; }\n');
  await writeFile(join(root, 'src/main.js'), "import { helper } from './helper.js';\nexport function main() { return helper(); }\n");
  return root;
}
function toolsFor(config = {}) {
  const tools = new Map(); const skills = new Map();
  apply({ inject(_deps, cb) { cb({ tools: { register: (d) => tools.set(d.name, d) }, skills: { register: (d) => skills.set(d.name, d) } }); } }, config);
  return { tools, skills, call: async (name, args, exec = {}) => JSON.parse(await tools.get(name).execute(args, exec)) };
}
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('default catalog contains only core tools; experiments require explicit config', () => {
  const normal = toolsFor(); const experimental = toolsFor({ experimental: true });
  assert.equal(normal.tools.size, 11); assert.equal(normal.skills.size, 5);
  for (const name of ['ua_domain', 'ua_knowledge', 'ua_figma']) { assert.ok(!normal.tools.has(name)); assert.ok(experimental.tools.has(name)); }
});

test('scanner ignores comment/string decoys and records exact declaration lines', () => {
  const text = '// function ghost() {}\nconst text = "function fake() {} import x from \'./bad.js\'";\nexport function real() { return helper(); }\n';
  const symbols = extractSymbols(text, 'javascript');
  assert.deepEqual(symbols.map((s) => [s.name, s.line]), [['real', 3]]);
  assert.deepEqual(extractImports(text, 'javascript'), []);
  assert.ok(!extractCallSites(text, 'javascript').some((c) => c.name === 'ghost' || c.name === 'fake'));
  assert.equal(extractCallSites(text, 'javascript').find((c) => c.name === 'helper').line, 3);
});

test('total byte budgets never admit a file larger than the remaining budget', async (t) => {
  const root = await fixture(t);
  const scan = await scanProject(root, { maxTotalBytes: 10 });
  assert.equal(scan.files.length, 0); assert.equal(scan.totalBytes, 0); assert.equal(scan.skippedByCap, 2);
  assert.equal(scan.truncated, true);
});

test('scope cannot follow a symbolic link outside the project', async (t) => {
  const root = await fixture(t); const outside = await fixture(t);
  await symlink(outside, join(root, 'escape'));
  await assert.rejects(scanProject(root, { scope: 'escape' }), /PATH_OUTSIDE_ROOT/);
  await assert.rejects(scanProject(join(root, 'absent')), { code: 'ENOENT' });
});

test('warm scans reuse parsing and changed annotations survive with a review marker', async (t) => {
  const root = await fixture(t);
  const first = buildGraph(root, await scanProject(root));
  annotateGraph(first, [{ nodeId: 'function:src/helper.js:helper', summary: 'Returns the helper value', tags: ['helper'], layer: 'Service' }]);
  const warm = await scanProject(root, { previous: first });
  assert.equal(warm.reusedFiles, 2); assert.equal(warm.parsedFiles, 0);
  await writeFile(join(root, 'src/helper.js'), '\n\nexport function helper() { return 2; }\n');
  const scan = await scanProject(root, { previous: first });
  assert.equal(scan.reusedFiles, 1); assert.equal(scan.parsedFiles, 1);
  const second = buildGraph(root, scan, { previous: first });
  const node = second.nodes.find((n) => n.name === 'helper' && n.type === 'function');
  assert.equal(node.summary, 'Returns the helper value'); assert.equal(node.annotation.stale, true); assert.equal(node.line, 3);
  annotateGraph(second, [{ nodeId: node.id, summary: 'Returns two' }]);
  assert.equal(node.annotation.stale, false);
});

test('annotations survive switching scan scope and back', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'docs')); await writeFile(join(root, 'docs/readme.md'), '# Notes');
  const first = buildGraph(root, await scanProject(root));
  annotateGraph(first, [{ nodeId: 'file:src/main.js', summary: 'Entry point' }]);
  const scoped = buildGraph(root, await scanProject(root, { scope: 'docs' }), { previous: first });
  assert.ok(!scoped.nodes.find((n) => n.id === 'file:src/main.js'));
  const full = buildGraph(root, await scanProject(root), { previous: scoped });
  assert.equal(full.nodes.find((n) => n.id === 'file:src/main.js').summary, 'Entry point');
});

test('failed, cancelled and limited refreshes leave the last graph intact', async (t) => {
  const root = await fixture(t); const api = toolsFor();
  const first = await api.call('ua_scan', { root });
  const before = await readFile(first.path, 'utf8');
  for (const full of [false, true]) {
    const limited = await api.call('ua_scan', { root, maxFiles: 1, full });
    assert.equal(limited.error, 'INCOMPLETE_SCAN'); assert.equal(limited.previousPreserved, true);
  }
  const cancelled = await api.call('ua_scan', { root }, { signal: AbortSignal.abort() });
  assert.equal(cancelled.error, 'SCAN_CANCELLED');
  assert.equal(await readFile(first.path, 'utf8'), before);
});

test('freshness follows scanned bytes even without Git and ignores pre-scan dirty files', async (t) => {
  const root = await fixture(t); const api = toolsFor();
  await api.call('ua_scan', { root });
  assert.equal((await api.call('ua_status', { root })).stale.changedCount, 0);
  await writeFile(join(root, 'src/helper.js'), 'export function helper() { return 9; }');
  assert.deepEqual((await api.call('ua_status', { root })).stale.changedFiles, ['src/helper.js']);
  assert.equal((await api.call('ua_auto_update', { root })).updated, true);
  assert.equal((await api.call('ua_status', { root })).stale.changedCount, 0);
});

test('scoped auto-update stays scoped and does not include sibling sources', async (t) => {
  const root = await fixture(t); const api = toolsFor();
  await writeFile(join(root, 'outside.js'), 'export function outside() {}');
  await api.call('ua_scan', { root, scope: 'src' });
  await writeFile(join(root, 'src/helper.js'), 'export function helper() { return 3; }');
  const updated = await api.call('ua_auto_update', { root });
  assert.equal(updated.updated, true);
  const graph = JSON.parse(await readFile(updated.path));
  assert.equal(graph.meta.scope, 'src');
  assert.ok(!graph.nodes.some((n) => n.filePath === 'outside.js'));
});

test('source excerpts target the definition and disclose stale relationships', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'src/late.js'), '\n'.repeat(100) + 'export function later() { return 1; }\n');
  const graph = buildGraph(root, await scanProject(root));
  const detail = await explainNode(graph, root, 'function:src/late.js:later');
  assert.equal(detail.source.line, 101); assert.match(detail.source.citation, /late\.js:101$/); assert.match(detail.excerpt, /function later/);
  await writeFile(join(root, 'src/late.js'), '\n'.repeat(120) + 'export function later() { return 2; }\n');
  const changed = await explainNode(graph, root, 'function:src/late.js:later');
  assert.equal(changed.source.stale, true); assert.equal(changed.source.line, 121); assert.equal(changed.source.anchorVerified, true);
});

test('impact separates import evidence from inferred calls and reports unmapped files', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'src/guess.js'), 'export function guess() { helper(); }');
  const graph = buildGraph(root, await scanProject(root));
  const edge = graph.edges.find((e) => e.type === 'imports' && e.source === 'file:src/main.js');
  assert.equal(edge.certainty, 'observed'); assert.equal(edge.evidence.line, 1);
  const impact = diffImpact(graph, ['src/helper.js', 'src/new.js']);
  assert.ok(impact.upstream.some((n) => n.id === 'file:src/main.js'));
  assert.ok(!impact.upstream.some((n) => n.id === 'file:src/guess.js'));
  const inferred = impact.inferredUpstream.find((n) => n.id === 'file:src/guess.js');
  assert.ok(inferred.via.some((e) => e.certainty === 'inferred'));
  assert.deepEqual(impact.unmappedFiles, ['src/new.js']);
});

test('ambiguous function names do not create arbitrary call targets', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'src/other.js'), 'export function helper() {}');
  const graph = buildGraph(root, await scanProject(root));
  assert.ok(!graph.edges.some((e) => e.type === 'calls' && e.source === 'file:src/main.js'));
  assert.ok(graph.meta.stats.ambiguousCalls > 0);
});

test('Git changes preserve spaces, unicode, rename endpoints and nested project roots', async (t) => {
  const root = await fixture(t);
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.test');
  await writeFile(join(root, 'src/中文 file.js'), 'export const value = 1;');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'initial'); const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'mv', 'src/中文 file.js', 'src/ renamed file.js');
  const changes = await changedFiles(join(root, 'src'), head);
  assert.ok(changes.all.includes('中文 file.js')); assert.ok(changes.all.includes(' renamed file.js'));
  assert.ok(!changes.all.some((p) => p.startsWith('src/')));
  const api = toolsFor(); await api.call('ua_scan', { root });
  assert.equal((await api.call('ua_diff', { root, base: 'not-a-real-ref' })).error, 'INVALID_BASE');
});

test('parallel graph writes remain complete JSON and tool annotations serialize', async (t) => {
  const root = await fixture(t); const api = toolsFor();
  const first = await api.call('ua_scan', { root });
  await Promise.all([
    api.call('ua_annotate', { root, annotations: [{ nodeId: 'file:src/helper.js', summary: 'helper' }] }),
    api.call('ua_annotate', { root, annotations: [{ nodeId: 'file:src/main.js', summary: 'main' }] }),
  ]);
  const graph = JSON.parse(await readFile(first.path));
  assert.equal(graph.nodes.find((n) => n.id === 'file:src/main.js').summary, 'main');
  assert.equal(graph.nodes.find((n) => n.id === 'file:src/helper.js').summary, 'helper');
  await Promise.all([saveGraph(root, graph), saveGraph(root, graph)]);
  assert.ok(JSON.parse(await readFile(first.path)).nodes.length > 0);
});

test('regex literals do not hide declarations after quoted character classes', () => {
  const source = String.raw`const regex = /['"/]/g;
export function afterRegex() { return 1; }
const division = 4 / 2;
export function afterDivision() { return division; }`;
  assert.deepEqual(extractSymbols(source, 'javascript').map((s) => s.name), ['afterRegex', 'afterDivision']);
});

test('a local declaration suppresses same-name inferred calls into another file', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'src/local.js'), 'export function helper() {}\nhelper();');
  const graph = buildGraph(root, await scanProject(root));
  assert.ok(!graph.edges.some((e) => e.type === 'calls' && e.source === 'file:src/local.js' && e.target === 'function:src/helper.js:helper'));
});
