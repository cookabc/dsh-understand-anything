/**
 * Knowledge graph construction, persistence and queries.
 *
 * Graph shape: project / nodes / edges / layers / tour, plus a `meta` block
 * with fingerprints for incremental rescans. The graph is structural by
 * default; `summary`, `tags` and `layer` are semantic fields the model fills
 * in through `ua_annotate`.
 */

import { mkdir, readFile, rename, stat, writeFile, rm, realpath } from 'node:fs/promises';
import { basename, join, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveImport, PARSER_VERSION, readSource, extractSymbols } from './scanner.mjs';
import {
  classifyLayer, DOCUMENT_NODE_TYPE, inside, nowIso, posix, safeRoot, fingerprint, DEFAULTS,
} from './util.mjs';

export const GENERATOR = 'dsh-understand-anything';
export const GENERATOR_VERSION = '0.2.0';

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
  'zh-TW': { API: 'API 層', Service: '服務層', Data: '資料層', UI: '介面層', Utility: '工具層', Test: '測試', Other: '其它' },
  ja: { API: 'API層', Service: 'サービス層', Data: 'データ層', UI: 'UI層', Utility: 'ユーティリティ層', Test: 'テスト', Other: 'その他' },
  ko: { API: 'API 계층', Service: '서비스 계층', Data: '데이터 계층', UI: 'UI 계층', Utility: '유틸리티 계층', Test: '테스트', Other: '기타' },
  ru: { API: 'API-слой', Service: 'Сервисный слой', Data: 'Слой данных', UI: 'UI-слой', Utility: 'Слой утилит', Test: 'Тесты', Other: 'Прочее' },
  vi: { API: 'Tầng API', Service: 'Tầng dịch vụ', Data: 'Tầng dữ liệu', UI: 'Tầng giao diện', Utility: 'Tầng tiện ích', Test: 'Kiểm thử', Other: 'Khác' },
};

/** Localized tour step templates keyed by content language. */
const TOUR_TEXT = {
  en: (n, paths) => ({ title: `Step ${n}: start from the foundations`, description: `These files depend on little else; read them first to see what later modules build on: ${paths}` }),
  zh: (n, paths) => ({ title: `第 ${n} 步：从基础模块开始`, description: `这些文件依赖较少，先读它们可以理解后面的模块建立在什么之上：${paths}` }),
  'zh-TW': (n, paths) => ({ title: `第 ${n} 步：從基礎模組開始`, description: `這些檔案依賴較少，先讀它們可以理解後面的模組建立在什麼之上：${paths}` }),
  ja: (n, paths) => ({ title: `ステップ ${n}: 基盤モジュールから`, description: `依存が少ないファイルから読むと、後続のモジュールが何の上に築かれているかがわかります: ${paths}` }),
  ko: (n, paths) => ({ title: `${n}단계: 기반 모듈부터`, description: `의존성이 적은 파일부터 읽으면 이후 모듈이 무엇 위에 세워졌는지 이해할 수 있습니다: ${paths}` }),
  ru: (n, paths) => ({ title: `Шаг ${n}: начните с фундамента`, description: `Эти файлы почти ни от чего не зависят; читайте их первыми, чтобы понять, на чём строятся остальные модули: ${paths}` }),
  vi: (n, paths) => ({ title: `Bước ${n}: bắt đầu từ nền móng`, description: `Những tệp này gần như không phụ thuộc gì; đọc chúng trước để hiểu các mô-đun sau xây trên cái gì: ${paths}` }),
};

/** All generated data lives in `<root>/.ua`. */
export async function resolveDataDir(root) {
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
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); }
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
 * Metadata consumed by the post-commit hook: a graph is stale when
 * meta.gitCommitHash differs from HEAD.
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
    const config = JSON.parse(await readFile(configPath(dir), 'utf8'));
    return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
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
  const annotations = { ...(previous?.meta?.annotations ?? {}) };
  for (const node of previous?.nodes ?? []) {
    if (node.annotation || node.summary || node.tags?.length) {
      annotations[node.id] = { summary: node.summary, tags: node.tags, layer: node.layer, hash: node.annotation?.sourceHash ?? prevFingerprints[node.filePath], at: node.annotation?.at ?? null };
    }
  }
  let reused = 0;
  let rebuilt = 0;

  const addEdge = (source, target, type, weight = 1, evidence = {}) => {
    const e = { source, target, type, direction: 'out', weight, certainty: type === 'calls' ? 'inferred' : 'observed', ...evidence };
    const key = edgeKey(e);
    if (seenEdges.has(key) || source === target) return;
    seenEdges.add(key);
    edges.push(e);
  };

  const makeNode = (id, fallback) => {
    const changed = !previous || prevFingerprints[fallback.filePath] !== fingerprints[fallback.filePath];
    const old = prevById.get(id);
    if (!changed && old) reused += 1; else rebuilt += 1;
    const node = { summary: '', tags: [], complexity: 1, ...fallback };
    const annotation = annotations[id];
    if (annotation) {
      for (const key of ['summary', 'tags', 'layer']) if (annotation[key] !== undefined) node[key] = annotation[key];
      node.annotation = { sourceHash: annotation.hash ?? null, at: annotation.at, stale: annotation.hash !== fingerprints[fallback.filePath] };
    }
    return node;
  };

  for (const file of scan.files) {
    fingerprints[file.path] = file.hash;
    const fileId = `file:${file.path}`;
    const type = DOCUMENT_NODE_TYPE[file.language] ?? 'file';
    const layer = classifyLayer(file.path);
    const fileNode = makeNode(fileId, {
      id: fileId, type, name: basename(file.path), filePath: file.path,
      layer, languageNotes: file.language, line: 1, column: 1,
      complexity: Math.max(1, Math.round(file.lines / 20)),
    });
    // A hand-assigned layer survives an unchanged-file rebuild.
    if (fileNode.layer === undefined) fileNode.layer = layer;
    nodes.push(fileNode);

    for (const sym of file.symbols) {
      const id = `${sym.kind}:${file.path}:${sym.name}`;
      const symNode = makeNode(id, {
        id, type: sym.kind, name: sym.name, filePath: file.path,
        layer: fileNode.layer ?? layer, line: sym.line ?? 1, column: sym.column ?? 1,
      });
      nodes.push(symNode);
      addEdge(fileId, id, 'contains', 1, { evidence: { path: file.path, line: sym.line ?? 1, basis: 'lexical-definition' } });
      if (sym.kind === 'function') {
        if (!functionIndex.has(sym.name)) functionIndex.set(sym.name, []);
        functionIndex.get(sym.name).push({ id, path: file.path });
      }
    }
  }

  // Imports / wiki links. External packages become lightweight module nodes.
  const aliases = scan.aliases ?? null;
  const goModule = scan.goModule ?? null;
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
      const resolved = resolveImport(spec, file.path, fileSet, aliases, goModule);
      if (resolved.kind === 'unresolved') resolved.id = `unresolved:${file.path}:${spec}`;
      const site = file.importSites?.find((site) => site.spec === spec);
      if (resolved.kind === 'external' || resolved.kind === 'unresolved') {
        if (!moduleNodes.has(resolved.id)) {
          const m = { id: resolved.id, type: 'module', name: spec, summary: '', tags: [], complexity: 1, layer: resolved.kind === 'unresolved' ? 'Unresolved' : 'External', resolution: resolved.kind };
          moduleNodes.set(resolved.id, m);
          nodes.push(m);
        }
      }
      const basis = resolved.kind === 'internal'
        ? (resolved.via === 'alias' ? 'tsconfig-paths-alias'
          : resolved.via === 'module' ? 'go-mod-module'
          : resolved.via === 'replace' ? 'go-mod-replace'
          : 'relative-path-resolution')
        : resolved.kind;
      addEdge(fileId, resolved.id, 'imports', 1, { resolution: resolved.kind, evidence: { path: file.path, line: site?.line ?? null, specifier: spec, basis } });
    }
  }

  // Name matching is only a candidate relationship, never a verified call graph.
  let callEdges = 0; let ambiguousCalls = 0; let callsTruncated = false;
  for (const file of scan.files) {
    for (const site of file.callSites ?? []) {
      const defs = functionIndex.get(site.name) ?? [];
      if (defs.some((d) => d.path === file.path)) continue;
      if (!defs.length) continue;
      if (defs.length !== 1) { ambiguousCalls++; continue; }
      if (callEdges >= 3000) { callsTruncated = true; break; }
      const before = edges.length;
      addEdge(`file:${file.path}`, defs[0].id, 'calls', 0.5, {
        evidence: { path: file.path, line: site.line, basis: 'unique-name-match', warning: 'Lexical name match; binding and runtime dispatch are not verified.' },
      });
      if (edges.length > before) callEdges++;
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
      scope: scan.scope ?? null,
      limits: options.limits ?? {},
      annotations,
      parserVersion: PARSER_VERSION,
      fileStructure: Object.fromEntries(scan.files.map((f) => [f.path, { hash: f.hash, symbols: f.symbols, imports: f.imports, importSites: f.importSites ?? [], callSites: f.callSites ?? [] }])),
      stats: {
        files: scan.files.length,
        nodes: nodes.length,
        edges: edges.length,
        symbols: nodes.filter((n) => n.type === 'function' || n.type === 'class').length,
        parsedFiles: scan.parsedFiles ?? scan.files.length,
        reusedFiles: scan.reusedFiles ?? 0,
        inferredEdges: callEdges,
        ambiguousCalls,
        callsTruncated,
        annotationReviewNeeded: nodes.filter((n) => n.annotation?.stale).length,
        skippedUnreadable: scan.skippedUnreadable ?? [],
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
  const template = TOUR_TEXT[language] ?? TOUR_TEXT.en;
  const separator = language === 'zh' || language === 'zh-TW' || language === 'ja' ? '、' : ', ';
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
    const { title, description } = template(steps.length + 1, chunk.map((c) => c.path).join(separator));
    steps.push({
      order: steps.length + 1,
      title,
      description,
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
  // Compact layer notices: nodeIds can enumerate the whole graph (6000 ids on
  // a 3000-file project ≈ 164 KB), which turns one query into a context bomb.
  // Matches already carry their layer, so a name + total is all the caller needs.
  const layers = graph.layers
    .filter((l) => layerIds.has(l.name) || layerIds.has(l.id))
    .map((l) => ({ id: l.id, name: l.name, nodeCount: (l.nodeIds ?? []).length }));
  return { matches, edges, neighbors, layers };
}

/** One node with its relationships and a short source excerpt. */
export async function explainNode(graph, root, id) {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return null;
  const edges = graph.edges.filter((e) => e.source === id || e.target === id).slice(0, 80);
  const neighborIds = new Set(edges.flatMap((e) => [e.source, e.target]).filter((x) => x !== id));
  const neighbors = graph.nodes.filter((n) => neighborIds.has(n.id)).slice(0, 40);
  let excerpt = null;
  let source = null;
  if (node.filePath) {
    try {
      const abs = inside(root, node.filePath);
      const check = relative(await realpath(root), await realpath(abs));
      if (check === '..' || check.startsWith(`..${sep}`) || isAbsolute(check)) throw new Error('source resolves outside project');
      const text = await readSource(abs, DEFAULTS.maxFileBytes);
      if (text === null) throw new Error('source exceeds excerpt read limit or is binary');
      const currentHash = fingerprint(text);
      const stale = graph.meta?.fingerprints?.[node.filePath] !== currentHash;
      const currentSymbol = stale && ['class', 'function'].includes(node.type)
        ? extractSymbols(text, node.languageNotes ?? graph.nodes.find((n) => n.id === `file:${node.filePath}`)?.languageNotes).find((sym) => sym.name === node.name && sym.kind === node.type) : null;
      const line = currentSymbol?.line ?? node.line ?? 1;
      const startLine = Math.max(1, line - 5);
      const lines = text.split('\n');
      const endLine = Math.min(lines.length, startLine + 59);
      excerpt = lines.slice(startLine - 1, endLine).join('\n').slice(0, 6000);
      source = { path: abs, line, startLine, endLine, citation: `${abs}:${line}`, stale, anchorVerified: !stale || !!currentSymbol || node.id.startsWith('file:'), warning: stale ? 'Source changed since scanning; relationships and annotations may be out of date.' : null };
    } catch (error) { source = { path: node.filePath, available: false, warning: error.message }; }
  }
  return { node, edges, neighbors, excerpt, source, inferredEdges: edges.filter((e) => e.certainty === 'inferred' || e.type === 'calls'), truncated: graph.edges.filter((e) => e.source === id || e.target === id).length > edges.length || neighborIds.size > neighbors.length };
}

/** Apply model-authored semantic fields. Only known nodes are touched. */
export function annotateGraph(graph, annotations, language = 'en') {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const updated = [];
  const unknown = [];
  const totalInput = Array.isArray(annotations) ? annotations.length : 0;
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
    node.annotation = { sourceHash: graph.meta?.fingerprints?.[node.filePath] ?? null, at: nowIso(), stale: false };
    if (graph.meta) {
      graph.meta.annotations ??= {};
      graph.meta.annotations[node.id] = { summary: node.summary, tags: node.tags, layer: node.layer, hash: node.annotation.sourceHash, at: node.annotation.at };
    }
    updated.push(node.id);
  }
  // A hand-assigned layer changes group membership, so rebuild once when any
  // applied annotation carried one. String() keeps numeric nodeIds working.
  if (updated.some((id) => list.find((a) => String(a?.nodeId ?? '') === id)?.layer)) rebuildLayers(graph, language);
  if (graph.meta?.stats) graph.meta.stats.annotationReviewNeeded = graph.nodes.filter((n) => n.annotation?.stale).length;
  const truncatedGroups = totalInput > 100 ? ['annotations'] : [];
  return { updated, unknown, count: updated.length, truncatedGroups, totalInput };
}

/** Which nodes a set of changed files touches, plus upstream dependents. */
export function diffImpact(graph, changedPaths, maxDepth = 3) {
  const changed = new Set((changedPaths ?? []).map((p) => posix(p)));
  const direct = graph.nodes.filter((n) => n.filePath && changed.has(posix(n.filePath)));
  const directIds = new Set(direct.map((n) => n.id));
  const knownPaths = new Set(graph.nodes.map((n) => n.filePath));
  const reverse = new Map();
  for (const edge of graph.edges) {
    if (!['imports', 'calls', 'contains', 'related', 'depends_on'].includes(edge.type)) continue;
    if (!reverse.has(edge.target)) reverse.set(edge.target, []);
    reverse.get(edge.target).push(edge);
  }
  const walk = (allowInferred) => {
    const visited = new Set(directIds); const via = new Map(); const edges = [];
    let frontier = [...directIds]; let truncated = false;
    for (let depth = 1; depth <= maxDepth; depth++) {
      const next = [];
      for (const target of frontier) for (const edge of reverse.get(target) ?? []) {
        if (!allowInferred && (edge.certainty === 'inferred' || edge.type === 'calls')) continue;
        if (visited.has(edge.source)) continue;
        if (visited.size >= Math.max(300, directIds.size)) { truncated = true; continue; }
        visited.add(edge.source); next.push(edge.source);
        const step = { ...edge, depth };
        edges.push(step); via.set(edge.source, [step, ...(via.get(target) ?? [])]);
      }
      frontier = next;
      if (!next.length) break;
    }
    if (frontier.some((id) => (reverse.get(id) ?? []).some((e) => !visited.has(e.source) && (allowInferred || (e.certainty !== 'inferred' && e.type !== 'calls'))))) truncated = true;
    return { visited, via, edges, truncated };
  };
  const observed = walk(false); const all = walk(true);
  const upstream = graph.nodes.filter((n) => observed.visited.has(n.id) && !directIds.has(n.id));
  const inferred = graph.nodes.filter((n) => all.visited.has(n.id) && !observed.visited.has(n.id));
  const annotate = (list, traversal) => list.slice(0, 120).map((n) => ({ ...n, via: traversal.via.get(n.id) ?? [] }));
  return {
    changedFiles: [...changed].slice(0, 100),
    changedCount: changed.size,
    unmappedFiles: [...changed].filter((path) => !knownPaths.has(path)).slice(0, 100),
    direct: direct.slice(0, 120),
    upstream: annotate(upstream, observed),
    inferredUpstream: annotate(inferred, all),
    upstreamEdges: observed.edges.slice(0, 200),
    inferredEdges: all.edges.filter((e) => !observed.visited.has(e.source)).slice(0, 200),
    layersTouched: [...new Set(graph.nodes.filter((n) => all.visited.has(n.id)).map((n) => n.layer).filter(Boolean))],
    affectedCount: observed.visited.size,
    possibleAffectedCount: all.visited.size,
    truncated: observed.truncated || all.truncated || direct.length > 120 || upstream.length > 120 || inferred.length > 120 || all.edges.length > 200 || changed.size > 100,
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
