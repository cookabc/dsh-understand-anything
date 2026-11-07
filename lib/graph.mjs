/**
 * Knowledge graph construction, persistence and queries.
 *
 * Output is deliberately compatible with Understand Anything's
 * `.ua/knowledge-graph.json` (project / nodes / edges / layers / tour), with an
 * extra `meta` block holding fingerprints for incremental rescans. The graph is
 * structural by default; `summary`, `tags` and `layer` are semantic fields the
 * model fills in through `ua_annotate`.
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { resolveImport } from './scanner.mjs';
import {
  classifyLayer, DOCUMENT_NODE_TYPE, inside, nowIso, posix, safeRoot,
} from './util.mjs';

export const GENERATOR = 'dsh-understand-anything';
export const GENERATOR_VERSION = '0.1.0';

const FRAMEWORK_FILES = {
  'package.json': 'Node.js', 'tsconfig.json': 'TypeScript',
  'pyproject.toml': 'Python', 'requirements.txt': 'Python',
  'go.mod': 'Go', 'Cargo.toml': 'Rust',
  'pom.xml': 'Maven', 'build.gradle': 'Gradle',
  'composer.json': 'PHP', 'Gemfile': 'Ruby',
  'Dockerfile': 'Docker', 'deno.json': 'Deno',
  'vite.config.ts': 'Vite', 'vite.config.js': 'Vite',
  'next.config.js': 'Next.js', 'next.config.mjs': 'Next.js',
};

const LAYER_LABELS = {
  en: { API: 'API', Service: 'Service', Data: 'Data', UI: 'UI', Utility: 'Utility', Test: 'Test', Other: 'Other' },
  zh: { API: '接口层', Service: '服务层', Data: '数据层', UI: '界面层', Utility: '工具层', Test: '测试', Other: '其它' },
};

/** Prefer a legacy `.understand-anything/` directory when one exists. */
export async function resolveDataDir(root) {
  const legacy = join(root, '.understand-anything');
  try {
    if ((await stat(legacy)).isDirectory()) return legacy;
  } catch { /* absent */ }
  return join(root, '.ua');
}

export const graphPath = (dir) => join(dir, 'knowledge-graph.json');
export const configPath = (dir) => join(dir, 'config.json');
export const dashboardPath = (dir) => join(dir, 'dashboard.html');
export const domainGraphPath = (dir) => join(dir, 'domain-graph.json');
export const designGraphPath = (dir) => join(dir, 'design-graph.json');
export const metaPath = (dir) => join(dir, 'meta.json');

/** Atomic JSON write so a interrupted scan never leaves a half graph. */
async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

/** Read any graph file in the project's data directory, or null. */
export async function loadGraphFile(root, filename) {
  const dir = await resolveDataDir(root);
  try {
    const parsed = JSON.parse(await readFile(join(dir, filename), 'utf8'));
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write any graph file into the project's data directory, atomically. */
export async function saveGraphFile(root, filename, graph) {
  const dir = await resolveDataDir(root);
  await writeJson(join(dir, filename), graph);
  return join(dir, filename);
}

/**
 * Upstream-compatible metadata consumed by the post-commit hook: a graph is
 * stale when meta.gitCommitHash differs from HEAD.
 */
export async function writeMeta(root, graph, extra = {}) {
  const dir = await resolveDataDir(root);
  const meta = {
    lastAnalyzedAt: nowIso(),
    gitCommitHash: graph?.project?.gitCommitHash ?? '',
    version: GENERATOR_VERSION,
    analyzedFiles: graph?.meta?.stats?.files ?? graph?.nodes?.length ?? 0,
    ...extra,
  };
  await writeJson(metaPath(dir), meta);
  return meta;
}

/** Read the graph, or null when absent or malformed. */
export async function loadGraph(root) {
  const dir = await resolveDataDir(root);
  try {
    const parsed = JSON.parse(await readFile(graphPath(dir), 'utf8'));
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveGraph(root, graph) {
  const path = await saveGraphFile(root, 'knowledge-graph.json', graph);
  await writeMeta(root, graph);
  return path;
}

export async function readConfig(root) {
  const dir = await resolveDataDir(root);
  try {
    return JSON.parse(await readFile(configPath(dir), 'utf8'));
  } catch {
    return {};
  }
}

export async function writeConfig(root, patch) {
  const dir = await resolveDataDir(root);
  const next = { ...(await readConfig(root)), ...patch };
  await writeJson(configPath(dir), next);
  return next;
}

/** Detect declared frameworks from manifest filenames, not file contents. */
export function detectFrameworks(paths) {
  const found = new Set();
  for (const p of paths) {
    const base = basename(p);
    if (FRAMEWORK_FILES[base]) found.add(FRAMEWORK_FILES[base]);
    if (/^vite\.config\./.test(base)) found.add('Vite');
    if (/^next\.config\./.test(base)) found.add('Next.js');
  }
  return [...found].sort();
}

const edgeKey = (e) => `${e.source}|${e.target}|${e.type}`;

/**
 * Build (or incrementally rebuild) a graph from a scan.
 * Unchanged files reuse their previous nodes verbatim, which preserves any
 * annotations the model has written since the last scan.
 */
export function buildGraph(root, scan, options = {}) {
  const previous = options.previous ?? null;
  const language = options.language ?? 'en';
  const prevById = new Map((previous?.nodes ?? []).map((n) => [n.id, n]));
  const prevFingerprints = previous?.meta?.fingerprints ?? {};
  const fileSet = new Set(scan.files.map((f) => f.path));
  const nodes = [];
  const edges = [];
  const seenEdges = new Set();
  const fingerprints = {};
  const functionIndex = new Map();
  let reused = 0;
  let rebuilt = 0;

  const addEdge = (source, target, type, weight = 1) => {
    const e = { source, target, type, direction: 'out', weight };
    const key = edgeKey(e);
    if (seenEdges.has(key) || source === target) return;
    seenEdges.add(key);
    edges.push(e);
  };

  const makeNode = (id, fallback) => {
    const changed = !previous || prevFingerprints[fallback.filePath] !== fingerprints[fallback.filePath];
    const old = prevById.get(id);
    if (!changed && old) {
      reused += 1;
      return { ...old };
    }
    rebuilt += 1;
    return { summary: '', tags: [], complexity: 1, ...fallback };
  };

  for (const file of scan.files) {
    fingerprints[file.path] = file.hash;
    const fileId = `file:${file.path}`;
    const type = DOCUMENT_NODE_TYPE[file.language] ?? 'file';
    const layer = classifyLayer(file.path);
    const fileNode = makeNode(fileId, {
      id: fileId, type, name: basename(file.path), filePath: file.path,
      layer, languageNotes: file.language,
      complexity: Math.max(1, Math.round(file.lines / 20)),
    });
    // A hand-assigned layer survives an unchanged-file rebuild.
    if (fileNode.layer === undefined) fileNode.layer = layer;
    nodes.push(fileNode);

    for (const sym of file.symbols) {
      const id = `${sym.kind}:${file.path}:${sym.name}`;
      const symNode = makeNode(id, {
        id, type: sym.kind, name: sym.name, filePath: file.path,
        layer: fileNode.layer ?? layer,
      });
      nodes.push(symNode);
      addEdge(fileId, id, 'contains');
      if (sym.kind === 'function' && sym.name.length >= 5) {
        if (!functionIndex.has(sym.name)) functionIndex.set(sym.name, []);
        functionIndex.get(sym.name).push({ id, path: file.path });
      }
    }
  }

  // Imports / wiki links. External packages become lightweight module nodes.
  const moduleNodes = new Map();
  const wikiTargets = new Map();
  for (const n of nodes) {
    if (n.type === 'document') {
      const key = n.name.replace(/\.(md|mdx)$/i, '').toLowerCase();
      wikiTargets.set(key, n.id);
      wikiTargets.set(key.replace(/[\s_-]+/g, ''), n.id);
    }
  }

  for (const file of scan.files) {
    const fileId = `file:${file.path}`;
    for (const spec of file.imports) {
      if (file.language === 'markdown') {
        const key = spec.toLowerCase().replace(/\.(md|mdx)$/i, '').trim();
        const target = wikiTargets.get(key) ?? wikiTargets.get(key.replace(/[\s_-]+/g, ''));
        if (target) addEdge(fileId, target, 'related');
        continue;
      }
      const resolved = resolveImport(spec, file.path, fileSet);
      if (resolved.kind === 'external' || resolved.kind === 'unresolved') {
        if (!moduleNodes.has(resolved.id)) {
          const m = { id: resolved.id, type: 'module', name: spec, summary: '', tags: [], complexity: 1, layer: 'External' };
          moduleNodes.set(resolved.id, m);
          nodes.push(m);
        }
      }
      addEdge(fileId, resolved.id, 'imports');
    }
  }

  // Conservative call edges: a name used as a call in another file.
  let callEdges = 0;
  for (const [name, defs] of functionIndex) {
    if (defs.length > 12 || callEdges > 3000) break;
    const re = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\s*\\(`, 'g');
    for (const file of scan.files) {
      if (defs.some((d) => d.path === file.path)) continue;
      re.lastIndex = 0;
      if (!re.test(file.text)) continue;
      for (const def of defs.slice(0, 3)) addEdge(`file:${file.path}`, def.id, 'calls', 0.5);
      callEdges += 1;
    }
  }

  const languages = [...new Set(scan.files.map((f) => f.language))].sort();
  const graph = {
    project: {
      name: basename(root) || 'project',
      description: previous?.project?.description ?? '',
      languages,
      frameworks: detectFrameworks(scan.files.map((f) => f.path)),
      analyzedAt: nowIso(),
      gitCommitHash: options.gitCommitHash ?? previous?.project?.gitCommitHash ?? null,
    },
    nodes,
    edges,
    layers: [],
    tour: [],
    meta: {
      generator: GENERATOR,
      version: GENERATOR_VERSION,
      language,
      root: posix(root),
      fingerprints,
      stats: {
        files: scan.files.length,
        nodes: nodes.length,
        edges: edges.length,
        symbols: nodes.filter((n) => n.type === 'function' || n.type === 'class').length,
        reusedNodes: reused,
        rebuiltNodes: rebuilt,
        skippedOversize: scan.skippedOversize,
        skippedByCap: scan.skippedByCap,
        truncated: Boolean(scan.truncated),
      },
    },
  };
  rebuildLayers(graph, language);
  graph.tour = buildTour(graph, language);
  return graph;
}

/** Regroup layer membership from current nodes. */
export function rebuildLayers(graph, language = 'en') {
  const labels = LAYER_LABELS[language] ?? LAYER_LABELS.en;
  const groups = new Map();
  for (const n of graph.nodes) {
    const key = n.layer || classifyLayer(n.filePath || '');
    if (!groups.has(key)) groups.set(key, { id: key.toLowerCase(), name: labels[key] ?? key, description: '', nodeIds: [] });
    groups.get(key).nodeIds.push(n.id);
  }
  graph.layers = [...groups.values()].sort((a, b) => b.nodeIds.length - a.nodeIds.length);
  return graph.layers;
}

/**
 * A dependency-ordered reading tour: files that import little come first,
 * chunked into small guided steps.
 */
export function buildTour(graph, language = 'en') {
  const zh = language === 'zh';
  const outgoing = new Map();
  for (const e of graph.edges) {
    if (e.type !== 'imports') continue;
    outgoing.set(e.source, (outgoing.get(e.source) ?? 0) + 1);
  }
  const files = graph.nodes
    .filter((n) => n.id.startsWith('file:'))
    .map((n) => ({ id: n.id, path: n.filePath, count: outgoing.get(n.id) ?? 0 }))
    .sort((a, b) => a.count - b.count || a.path.localeCompare(b.path));

  const steps = [];
  const size = 6;
  for (let i = 0; i < files.length; i += size) {
    const chunk = files.slice(i, i + size);
    steps.push({
      order: steps.length + 1,
      title: zh ? `第 ${steps.length + 1} 步：从基础模块开始` : `Step ${steps.length + 1}: start from the foundations`,
      description: zh
        ? `这些文件依赖较少，先读它们可以理解后面的模块建立在什么之上：${chunk.map((c) => c.path).join('、')}`
        : `These files depend on little else; read them first to see what later modules build on: ${chunk.map((c) => c.path).join(', ')}`,
      nodeIds: chunk.map((c) => c.id),
    });
  }
  return steps;
}

/** Score nodes against a free-text query and return a bounded 1-hop subgraph. */
export function queryGraph(graph, query, limit = 12) {
  const raw = String(query ?? '').trim().toLowerCase();
  const tokens = raw.split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return { matches: [], edges: [], neighbors: [], layers: [] };
  const scored = [];
  for (const n of graph.nodes) {
    const name = String(n.name ?? '').toLowerCase();
    const summary = String(n.summary ?? '').toLowerCase();
    const tags = (Array.isArray(n.tags) ? n.tags : []).join(' ').toLowerCase();
    const path = String(n.filePath ?? '').toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (name === t) score += 6;
      else if (name.includes(t)) score += 3;
      if (summary.includes(t)) score += 2;
      if (tags.includes(t)) score += 2;
      if (path.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ node: n, score });
  }
  scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  const matches = scored.slice(0, limit).map(({ node, score }) => ({ ...node, score }));
  const ids = new Set(matches.map((m) => m.id));
  const edges = graph.edges.filter((e) => ids.has(e.source) || ids.has(e.target)).slice(0, 200);
  const neighborIds = new Set(edges.flatMap((e) => [e.source, e.target]).filter((id) => !ids.has(id)));
  const neighbors = graph.nodes.filter((n) => neighborIds.has(n.id)).slice(0, 40);
  const layerIds = new Set(matches.map((m) => m.layer).filter(Boolean));
  return { matches, edges, neighbors, layers: graph.layers.filter((l) => layerIds.has(l.name) || layerIds.has(l.id)) };
}

/** One node with its relationships and a short source excerpt. */
export async function explainNode(graph, root, id) {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return null;
  const edges = graph.edges.filter((e) => e.source === id || e.target === id).slice(0, 80);
  const neighborIds = new Set(edges.flatMap((e) => [e.source, e.target]).filter((x) => x !== id));
  const neighbors = graph.nodes.filter((n) => neighborIds.has(n.id)).slice(0, 40);
  let excerpt = null;
  if (node.filePath) {
    try {
      const abs = inside(root, node.filePath);
      const text = await readFile(abs, 'utf8');
      excerpt = text.split('\n').slice(0, 60).join('\n').slice(0, 6000);
    } catch { excerpt = null; }
  }
  return { node, edges, neighbors, excerpt };
}

/** Apply model-authored semantic fields. Only known nodes are touched. */
export function annotateGraph(graph, annotations, language = 'en') {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const updated = [];
  const unknown = [];
  const list = Array.isArray(annotations) ? annotations.slice(0, 100) : [];
  for (const item of list) {
    const node = byId.get(String(item?.nodeId ?? ''));
    if (!node) { unknown.push(String(item?.nodeId ?? '')); continue; }
    if (typeof item.summary === 'string') node.summary = item.summary.slice(0, 2000);
    if (Array.isArray(item.tags)) node.tags = [...new Set(item.tags.map(String).slice(0, 24))];
    if (typeof item.layer === 'string' && item.layer.length <= 40) node.layer = item.layer;
    if (typeof item.description === 'string' && node.type === 'file') {
      graph.project.description = item.description.slice(0, 2000);
    }
    updated.push(node.id);
  }
  if (updated.some((id) => list.find((a) => a.nodeId === id)?.layer)) rebuildLayers(graph, language);
  return { updated, unknown, count: updated.length };
}

/** Which nodes a set of changed files touches, plus upstream dependents. */
export function diffImpact(graph, changedPaths, maxDepth = 3) {
  const changed = new Set((changedPaths ?? []).map((p) => posix(p)));
  const direct = graph.nodes.filter((n) => n.filePath && changed.has(posix(n.filePath)));
  const affected = new Set(direct.map((n) => n.id));
  const layersTouched = new Set(direct.map((n) => n.layer).filter(Boolean));
  let frontier = new Set(affected);
  const upstreamEdges = [];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next = new Set();
    for (const e of graph.edges) {
      if (!frontier.has(e.target) || affected.has(e.source)) continue;
      if (!['imports', 'calls', 'contains', 'related', 'depends_on'].includes(e.type)) continue;
      if (affected.size > 300) break;
      affected.add(e.source);
      next.add(e.source);
      upstreamEdges.push({ ...e, depth: depth + 1 });
    }
    if (next.size === 0) break;
    frontier = next;
  }
  const upstream = graph.nodes.filter((n) => affected.has(n.id) && !direct.some((d) => d.id === n.id)).slice(0, 120);
  return {
    changedFiles: [...changed],
    direct: direct.slice(0, 120),
    upstream,
    upstreamEdges: upstreamEdges.slice(0, 200),
    layersTouched: [...layersTouched],
    affectedCount: affected.size,
  };
}

/** Compact status object shared by `ua_status` and README examples. */
export function graphOverview(graph) {
  return {
    project: graph.project,
    stats: graph.meta?.stats ?? {
      files: graph.nodes.filter((n) => n.id.startsWith('file:')).length,
      nodes: graph.nodes.length, edges: graph.edges.length,
    },
    layers: graph.layers.map((l) => ({ id: l.id, name: l.name, nodeIds: l.nodeIds.length })),
    tourSteps: (graph.tour ?? []).length,
    annotated: graph.nodes.filter((n) => n.summary && n.summary.trim()).length,
    generator: graph.meta?.generator ?? null,
    language: graph.meta?.language ?? null,
  };
}

/** Guard used by every tool before touching a project directory. */
export function normalizeRoot(input) {
  return safeRoot(input);
}
