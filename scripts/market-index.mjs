#!/usr/bin/env node
/**
 * Generate a plugin market index (format 1) entry for this bundle.
 *
 * DSH discovers plugins ONLY through the index URLs a user configures in the
 * plugin market (`pluginMarket.indexes`). There is no built-in public market,
 * so publishing to npm is not enough: the package must also appear in an index
 * document that users can add.
 *
 * This script validates the produced document with the same validator DSH
 * itself uses (`@deepseek-ai/dsh-plugin-market-index`), so a passing run means
 * the market will accept it.
 *
 * Usage:
 *   node scripts/market-index.mjs                 # npm source, default registry
 *   node scripts/market-index.mjs --registry https://registry.npmjs.org
 *   node scripts/market-index.mjs --git <url> <commit> [--path <dir>]
 *   node scripts/market-index.mjs --out market.json
 *
 * The publish timestamp is read through `npm view <name> <version>.time` when
 * npm is available; pass --timestamp <unix-seconds> to pin it instead.
 */

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const { values } = parseArgs({
  options: {
    registry: { type: 'string' },
    git: { type: 'string' },
    commit: { type: 'string' },
    path: { type: 'string' },
    timestamp: { type: 'string' },
    out: { type: 'string' },
    title: { type: 'string' },
  },
  allowPositionals: true,
});

function publishTimestamp() {
  if (values.timestamp) {
    const n = Number(values.timestamp);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('--timestamp must be Unix seconds');
    return n;
  }
  try {
    const out = execFileSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'time', '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
    });
    const parsed = JSON.parse(out);
    const iso = typeof parsed === 'string' ? parsed : parsed?.[pkg.version];
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  } catch { /* fall through */ }
  throw new Error(`cannot determine the publish time of ${pkg.name}@${pkg.version}; pass --timestamp <unix-seconds>`);
}

const source = values.git
  ? {
    type: 'git',
    url: values.git,
    commit: (values.commit ?? '').toLowerCase(),
    ...(values.path ? { path: values.path } : {}),
  }
  : { type: 'npm', ...(values.registry ? { registry: values.registry } : {}) };

if (source.type === 'git' && !/^[0-9a-f]{40}$/.test(source.commit)) {
  throw new Error('--git requires --commit <lowercase 40-hex sha>');
}

const index = {
  format: 1,
  title: { en: values.title ?? 'Understand Anything', zh: 'Understand Anything' },
  description: {
    en: 'Codebase knowledge graphs for DSH: scan, query, impact analysis, domain flows, wikis, Figma and an offline dashboard.',
    zh: '把代码库变成可查询的知识图谱：建图、按图问答、影响面分析、业务域流程、知识库、Figma 与离线图谱页。',
  },
  metadata: {
    categories: {
      'code-analysis': { title: { en: 'Code analysis', zh: '代码分析' } },
    },
    labels: {
      'knowledge-graph': { title: { en: 'Knowledge graph', zh: '知识图谱' } },
      offline: { title: { en: 'Works offline', zh: '可离线' } },
    },
    sortKeys: {},
  },
  plugins: [{
    name: pkg.name,
    title: { en: 'Understand Anything', zh: 'Understand Anything' },
    description: {
      en: 'Native DSH port of Understand Anything: deterministic knowledge graph, impact-aware queries, business-domain flows, wiki and Figma graphs, and a self-contained dashboard.',
      zh: 'Understand Anything 的 dsh 原生移植：确定性知识图谱、影响面分析、业务域流程、知识库与 Figma 图谱，以及单文件离线界面。',
    },
    author: pkg.repository?.url?.match(/github\.com\/([^/]+)\//)?.[1] ?? undefined,
    homepage: 'https://github.com/Egonex-AI/Understand-Anything',
    repository: { url: 'https://github.com/Egonex-AI/Understand-Anything' },
    metadata: {
      category: 'code-analysis',
      keywords: pkg.keywords ?? [],
      labels: ['knowledge-graph', 'offline'],
      sortKeys: {},
    },
    versions: [{
      version: pkg.version,
      publishTimestamp: publishTimestamp(),
      source,
      engines: { dsh: pkg.engines.dsh },
    }],
  }],
};

// Validate with DSH's own validator (no dependency: resolved from the running installation).
let parsed;
try {
  const { parseMarketIndex, marketInstallTarget } = require('@deepseek-ai/dsh-plugin-market-index');
  parsed = parseMarketIndex(index, 'https://example.invalid/index.json');
  const target = marketInstallTarget(pkg.name, parsed.plugins[0].versions[0]);
  process.stderr.write(`[market-index] valid; install target: ${target.spec}\n`);
} catch (error) {
  if (error?.path) {
    process.stderr.write(`[market-index] INVALID at ${error.path}: ${error.reason}\n`);
    process.exit(1);
  }
  process.stderr.write(`[market-index] validator unavailable (${error.message}); document written unvalidated\n`);
}

const json = `${JSON.stringify(index, null, 2)}\n`;
if (values.out) {
  writeFileSync(values.out, json, 'utf8');
  process.stderr.write(`[market-index] wrote ${values.out}\n`);
} else {
  process.stdout.write(json);
}
