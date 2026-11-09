/** Render a self-contained, offline HTML dashboard for a knowledge graph. */

import { readFile } from 'node:fs/promises';

const MAX_VIEW_NODES = 1200;
const MAX_VIEW_EDGES = 4000;

/** JSON that is safe to embed inside a <script type="application/json"> block. */
function embedSafe(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Build a compact view model: the dashboard gets only the fields it draws, so
 * a large graph still produces a reasonably sized, double-clickable HTML file.
 */
export function buildViewModel(graph) {
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const fileNodes = nodes.filter((n) => n.id.startsWith('file:'));
  const others = nodes.filter((n) => !n.id.startsWith('file:'));
  const picked = [...fileNodes, ...others].slice(0, MAX_VIEW_NODES);
  const ids = new Set(picked.map((n) => n.id));
  const viewNodes = picked.map((n) => ({
    id: n.id,
    name: String(n.name ?? n.id).slice(0, 120),
    type: n.type ?? 'unknown',
    path: n.filePath ?? null,
    line: n.line ?? null,
    annotationStale: n.annotation?.stale === true,
    layer: n.layer ?? 'Other',
    summary: String(n.summary ?? '').slice(0, 400),
    tags: (Array.isArray(n.tags) ? n.tags : []).slice(0, 8).map(String),
  }));
  const viewEdges = edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .slice(0, MAX_VIEW_EDGES)
    .map((e) => ({ s: e.source, t: e.target, k: e.type, inferred: e.certainty === 'inferred' || e.certainty === 'model' || e.type === 'calls', evidence: e.evidence ?? null, resolution: e.resolution ?? null }));
  return {
    kind: graph.kind ?? 'code',
    scope: graph.meta?.scope ?? null,
    scanIncomplete: Boolean(graph.meta?.stats?.incomplete || graph.meta?.stats?.truncated),
    annotationReviewNeeded: nodes.filter((n) => n.annotation?.stale).length,
    project: {
      name: graph.project?.name ?? 'project',
      description: graph.project?.description ?? '',
      languages: graph.project?.languages ?? [],
      frameworks: graph.project?.frameworks ?? [],
      analyzedAt: graph.project?.analyzedAt ?? null,
      gitCommitHash: graph.project?.gitCommitHash ?? null,
    },
    layers: (graph.layers ?? []).map((l) => ({ id: l.id, name: l.name, count: (l.nodeIds ?? []).length })),
    tour: (graph.tour ?? []).map((t) => ({ order: t.order, title: t.title, description: t.description })),
    nodes: viewNodes,
    edges: viewEdges,
    truncated: nodes.length > picked.length || edges.length > viewEdges.length,
    totalNodes: nodes.length,
    totalEdges: edges.length,
    language: String(graph.meta?.language ?? 'en'),
  };
}

/** Read the HTML template and inject the graph as inert JSON data. */
export async function renderDashboard(graph) {
  const template = await readFile(new URL('./dashboard.template.html', import.meta.url), 'utf8');
  const model = buildViewModel(graph);
  const htmlLang = String(model.language).toLowerCase().split(/[-_]/)[0] === 'zh' ? 'zh' : 'en';
  return template
    .replace('/*__UA_GRAPH_JSON__*/', embedSafe(model))
    .replace('<html lang="en">', `<html lang="${htmlLang}">`);
}
