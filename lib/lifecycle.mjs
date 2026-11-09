/** Core scan lifecycle shared by tools and the post-commit runner. */
import { realpath } from 'node:fs/promises';
import { scanProject } from './scanner.mjs';
import { buildGraph, saveGraph } from './graph.mjs';
import { gitHead } from './git.mjs';
import { DEFAULTS, positiveInt } from './util.mjs';

const pending = new Map();
export async function withProjectLock(root, work) {
  const key = await realpath(root);
  const previous = pending.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  pending.set(key, current);
  try { return await current; }
  finally { if (pending.get(key) === current) pending.delete(key); }
}

export function scanLimits(config = {}) {
  return {
    maxFiles: positiveInt(config.maxFiles, DEFAULTS.maxFiles, 50000),
    maxFileBytes: positiveInt(config.maxFileBytes, DEFAULTS.maxFileBytes, 16 * 1024 * 1024),
    maxTotalBytes: positiveInt(config.maxTotalBytes, DEFAULTS.maxTotalBytes, 512 * 1024 * 1024),
  };
}

export async function sourceFreshness(root, graph, signal) {
  const scan = await scanProject(root, { ...scanLimits(graph.meta?.limits), scope: graph.meta?.scope, signal, previous: graph, parse: false });
  const old = graph.meta?.fingerprints ?? {};
  const current = Object.fromEntries(scan.files.map((f) => [f.path, f.hash]));
  const changedFiles = [...new Set([...Object.keys(old), ...Object.keys(current)])].filter((p) => old[p] !== current[p]).sort();
  const incomplete = scan.truncated || scan.skippedUnreadable.length > 0 || scan.skippedOversize > 0;
  return { changedFiles, changedCount: changedFiles.length, incomplete, stale: changedFiles.length > 0, scope: scan.scope };
}

export async function refreshCodeGraph(root, { previous, protectExisting = previous, config = {}, scope, signal } = {}) {
  const limits = scanLimits(config);
  const scan = await scanProject(root, { ...limits, scope: scope ?? previous?.meta?.scope, previous, signal });
  const incomplete = scan.truncated || scan.skippedUnreadable.length > 0 || scan.skippedOversize > 0;
  // Failed/limited refreshes must not destroy the existing graph.
  if (protectExisting && incomplete) {
    return { ok: false, error: 'INCOMPLETE_SCAN', previousPreserved: true, coverage: { scope: scan.scope, truncated: scan.truncated, skippedByCap: scan.skippedByCap, skippedOversize: scan.skippedOversize, skippedUnreadable: scan.skippedUnreadable }, hint: 'Increase the scan budgets or resolve unreadable files, then retry. The existing graph was kept.' };
  }
  const head = await gitHead(root);
  const graph = buildGraph(root, scan, { previous, language: config.language ?? 'en', gitCommitHash: head, limits });
  graph.meta.stats.incomplete = incomplete;
  signal?.throwIfAborted();
  const path = await saveGraph(root, graph);
  return { ok: true, graph, path, head, scope: scan.scope };
}
