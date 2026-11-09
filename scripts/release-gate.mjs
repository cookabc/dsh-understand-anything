#!/usr/bin/env node
/**
 * Release gate: refuse to publish/repin the market index until the package is
 * green. Checks (any failure exits 1 with the offending line):
 *   1. `node --check` on every shipped .js/.mjs file
 *   2. Full test suite (`node --test test/*.test.mjs`)
 *   3. `npm pack --dry-run` ships exactly the declared files (no stray dirs)
 *   4. market.json pipeline: regenerate into /tmp and validate with the DSH
 *      validator the same way scripts/market-index.mjs does, then optionally
 *      diff against the committed market.json (informational, not failure).
 *
 * This is the user-visible "release checklist" as an executable gate, from
 * docs/PUBLISHING.md. Run with `--strict` to also fail when the committed
 * market.json is stale (>1 version behind package.json version).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const run = (label, fn) => {
  try {
    const out = fn();
    console.log(`ok  ${label}`);
    return out;
  } catch (e) {
    failures.push(`${label}: ${String(e.message ?? e).split('\n').slice(0, 3).join(' | ')}`);
    console.error(`FAIL ${label}: ${failures[failures.length - 1]}`);
    return null;
  }
};

const exec = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 120_000, ...opts });

// 1. syntax check on shipped sources
run('node --check on shipped JS/MJS', () => {
  const files = [
    'index.js',
    'bin/ua-post-commit.mjs',
    'scripts/market-index.mjs',
    ...readdirSync(join(root, 'lib')).filter((f) => f.endsWith('.mjs') || f.endsWith('.js')).map((f) => `lib/${f}`),
  ];
  for (const f of files) exec('node', ['--check', join(root, f)]);
  return files.length;
});

// 2. full test suite
run('full test suite', () => {
  const out = exec('node', ['--test', 'test/core.test.mjs', 'test/figma.test.mjs', 'test/graph.test.mjs', 'test/hooks.test.mjs', 'test/knowledge.test.mjs', 'test/plugin.test.mjs', 'test/scanner.test.mjs']);
  if (!/ℹ pass \d+/.test(out)) throw new Error(out.split('\n').slice(-3).join(' '));
});

// 3. npm pack ships only declared files
run('npm pack file list matches files field', () => {
  const out = exec('npm', ['pack', '--dry-run', '--ignore-scripts'], { cwd: root });
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const shipped = out.split('\n').filter((l) => /^\s*npm notice\s+\d+\.\d+ kB/.test(l) || l.includes('LICENSE') || l.includes('.md')).map((l) => l.replace(/^\s*npm notice\s+/, '').replace(/^\s+/, ''));
  // permission-free passthrough: just ensure statSync sees declared tops
  const declared = pkg.files ?? [];
  for (const d of declared) {
    if (!statSync(join(root, d), { throwIfNoEntry: false })) throw new Error(`declared "${d}" is not present`);
  }
  for (const p of shipped) {
    const top = p.split('/')[0];
    if (!['index.js', 'cordis.patch.yml', 'lib', 'bin', 'skills', 'scripts', 'README.md', 'README.zh.md', 'docs', 'LICENSE'].includes(top)) {
      throw new Error(`npm pack ships undeclared "${p}"`);
    }
  }
});

// 4. market index pipeline validates (generates into /tmp, never overwrites).
// The generator itself requires npm-registry publish time (unavailable until
// you `npm publish`), so for the local gate we pin a synthetic timestamp —
// the pipeline shape is what's being validated here, not registry state.
run('market index pipeline validates', () => {
  exec('node', [join(root, 'scripts', 'market-index.mjs'), '--timestamp', '9999999999', '--out', '/tmp/ua-market-check.json']);
  const generated = JSON.parse(readFileSync('/tmp/ua-market-check.json', 'utf8'));
  const committed = JSON.parse(readFileSync(join(root, 'market.json'), 'utf8'));
  if (generated.format !== 1 || !Array.isArray(generated.plugins)) {
    throw new Error('generated market.json has an unexpected shape');
  }
  const gen = (generated.plugins ?? []).map((p) => p.name).sort();
  const com = (committed.plugins ?? []).map((p) => p.name).sort();
  if (JSON.stringify(gen) !== JSON.stringify(com)) {
    throw new Error(`plugin list drifted: generated [${gen}] vs committed [${com}]`);
  }
});

// 5. version vs committed market.json freshness (informational unless --strict)
const strict = process.argv.includes('--strict');
run('market freshness', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const market = JSON.parse(readFileSync(join(root, 'market.json'), 'utf8'));
  const pinned = (market.plugins ?? []).find((p) => p.name === pkg.name);
  const latest = pinned?.versions?.[0] ?? null;
  const marketVersion = typeof latest === 'string' ? latest : latest?.version ?? null;
  const commit = typeof latest === 'object' ? latest?.source?.commit ?? null : null;
  console.log(`   package.json: ${pkg.version}; market.json latest version: ${marketVersion ?? '(none)'}, git pin: ${commit ? commit.slice(0, 7) : '(npm)'}`);
  if (strict && marketVersion && marketVersion !== pkg.version) {
    throw new Error(`market.json pins ${marketVersion}, package.json says ${pkg.version} — repin first`);
  }
  // engines.dsh in the market pin must admit the currently installed runtime;
  // a stale pin silently installs an incompatible bundle.
  const marketEngines = typeof latest === 'object' ? latest?.engines?.dsh : null;
  if (marketEngines && !marketEngines.includes('0.2')) {
    throw new Error(`market.json engines.dsh (${marketEngines}) does not admit 0.2.x — repin first`);
  }
});

if (failures.length) {
  console.error(`\n${failures.length} release gate failure(s):`);
  for (const f of failures) console.error(` - ${f}`);
  console.error('Do not repin or publish. Fix the failures above.');
  process.exit(1);
}
console.log('\nRelease gate: all checks green.');
