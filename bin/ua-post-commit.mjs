#!/usr/bin/env node
/**
 * Standalone post-commit incremental rescan.
 *
 * Invoked by the git hook installed through `ua_hook({ action: "install" })`.
 * Pure Node, no LLM, no network. It must NEVER fail a commit: every error is
 * swallowed and the process always exits 0.
 *
 * Only runs when `<root>/.ua/config.json` has `autoUpdate: true` and a graph
 * already exists. Otherwise it is a no-op.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildGraph, loadGraph, readConfig, saveGraph } from '../lib/graph.mjs';
import { gitHead } from '../lib/git.mjs';
import { scanProject } from '../lib/scanner.mjs';
import { DEFAULTS } from '../lib/util.mjs';

function findGitRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const root = resolve(process.env.UA_PROJECT_ROOT || findGitRoot() || process.cwd());
  const config = await readConfig(root);
  if (config.autoUpdate !== true) return;
  const previous = await loadGraph(root);
  if (!previous) return;

  const head = await gitHead(root);
  // A graph recorded against this exact HEAD needs no structural refresh.
  if (head && previous.project?.gitCommitHash === head) return;

  const scan = await scanProject(root, {
    maxFiles: Number(config.maxFiles) || DEFAULTS.maxFiles,
    maxFileBytes: Number(config.maxFileBytes) || DEFAULTS.maxFileBytes,
  });
  const graph = buildGraph(root, scan, {
    previous,
    language: config.language ?? DEFAULTS.language,
    gitCommitHash: head,
  });
  await saveGraph(root, graph);
  process.stderr.write(
    `[dsh-understand-anything] graph refreshed: ${graph.meta.stats.files} files, ` +
    `${graph.meta.stats.rebuiltNodes} rebuilt\n`,
  );
}

main().catch(() => {
  // A stale graph is never a reason to reject a commit.
});
