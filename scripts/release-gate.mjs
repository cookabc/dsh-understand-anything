#!/usr/bin/env node
/**
 * Release gate: refuse to publish/repin the market index until the package is
 * green. Checks (any failure exits 1 with the offending line):
 *   1. `node --check` on every shipped .js/.mjs file
 *   2. Full test suite (`node --test test/*.test.mjs`)
 *   3. `npm pack --dry-run` ships exactly the declared files (real per-file
 *      diff, both directions, against the expanded `files` field)
 *   4. market.json pipeline: regenerate into /tmp — the generator validates it
 *      with DSH's own validator when one is reachable, and this gate also
 *      validates the committed market.json (the file users actually fetch)
 *      then; without a reachable dsh install it falls back to shape checks.
 *
 * This is the user-visible "release checklist" as an executable gate, from
 * docs/PUBLISHING.md. Run with `--strict` to also fail when the committed
 * market.json is stale (>1 version behind package.json version).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveValidator } from './market-validator.mjs';

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
    'scripts/market-validator.mjs',
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

// spawnSync wrapper for steps that need stdout AND stderr: execFileSync only
// returns stdout, and `npm pack` prints its file list on stderr (`npm notice`).
const execOut = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' | ')}`);
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// npm's own "Tarball Contents" listing -> Set of tarball-relative paths.
// Format verified against npm 11.x: file lines sit between the "Tarball
// Contents" and "Tarball Details" markers and read `npm notice 1.3kB LICENSE`
// (size glued to the unit, no column padding, no trailing spaces).
const parsePackFileList = (out) => {
  const shipped = new Set();
  let inContents = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('npm notice Tarball Contents')) inContents = true;
    else if (line.startsWith('npm notice Tarball Details')) break;
    else if (inContents) {
      const m = /^npm notice\s+\d[\d.]*\s*[kmgtp]?B\s+(.+?)\s*$/i.exec(line);
      if (m) shipped.add(m[1]);
    }
  }
  if (!shipped.size) throw new Error('no "npm notice <size> <path>" lines found — npm notice format changed?');
  return shipped;
};

// Names npm never packs wherever they appear (npm-packlist's built-in
// excludes plus the ignore files themselves — all confirmed by probe).
const NPM_ALWAYS_EXCLUDED = new Set([
  '.git', 'node_modules', 'CVS', '.svn', '.hg', '.DS_Store', '.npmrc',
  'npm-debug.log', 'config.gypi', 'package-lock.json', '.gitignore', '.npmignore',
]);

// Files in the git index (null outside a git checkout). npm packs everything
// that is not gitignored, so "tracked" is exactly what a directory entry in
// `files` means — and untracked strays inside a declared directory stay
// outside this list, which is what this check must refuse to ship.
const trackedFiles = () => {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', timeout: 120_000 });
  if (r.error || r.status !== 0) return null;
  return new Set((r.stdout ?? '').split('\0').filter(Boolean));
};

// package.json `files` -> Set of expected tarball paths. File entries just
// need to exist on disk; directory entries expand to the git-tracked files
// under them (minus npm's always-excluded names), falling back to a plain
// disk walk when git is unavailable.
const expandDeclaredFiles = (pkg) => {
  const tracked = trackedFiles();
  const expected = new Set();
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      if (NPM_ALWAYS_EXCLUDED.has(name)) continue;
      const st = statSync(join(dir, name), { throwIfNoEntry: false });
      if (!st) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) walk(join(dir, name), childRel);
      else if (st.isFile() && (!tracked || tracked.has(childRel))) expected.add(childRel);
    }
  };
  for (const entry of pkg.files ?? []) {
    const rel = relative(root, join(root, entry)).split(sep).join('/');
    const st = statSync(join(root, entry), { throwIfNoEntry: false });
    if (!st) throw new Error(`files field declares "${entry}" but it is not present in the repo`);
    if (st.isFile()) {
      expected.add(rel);
    } else if (st.isDirectory()) {
      if (tracked) {
        const prefix = rel === '.' ? '' : `${rel}/`;
        for (const f of tracked) {
          if (f.startsWith(prefix) && !NPM_ALWAYS_EXCLUDED.has(f.split('/').pop())) expected.add(f);
        }
      } else {
        walk(join(root, entry), rel === '.' ? '' : rel);
      }
    }
  }
  return expected;
};

const mainEntry = (pkg) => {
  if (typeof pkg.main !== 'string' || !pkg.main) return null;
  const rel = relative(root, join(root, pkg.main)).split(sep).join('/');
  return rel.startsWith('..') ? null : rel;
};

// npm packs these at the tarball root even when `files` omits them (verified
// by probe: package.json, any README*, any LICENSE/LICENCE variant, plus the
// `main` file), so they stay whitelisted instead of failing every run.
const isNpmBuiltin = (pkg) => (p) => p === 'package.json'
  || /^readme(\..+)?$/i.test(p)
  || /^licen[cs]e(\..+)?$/i.test(p)
  || p === mainEntry(pkg);

// 3. npm pack ships exactly the declared files — a real per-file diff in both
// directions, not a passthrough. `files` (directories expanded to their
// tracked files) must be what the tarball contains, modulo npm's own
// always-carried builtins above; anything extra or missing fails by path.
run('npm pack file list matches files field', () => {
  const r = execOut('npm', ['pack', '--dry-run', '--ignore-scripts'], { cwd: root });
  const shipped = parsePackFileList(`${r.stdout}${r.stderr}`);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const expected = expandDeclaredFiles(pkg);
  const builtin = isNpmBuiltin(pkg);
  const missing = [...expected].filter((p) => !shipped.has(p)).sort();
  const extra = [...shipped].filter((p) => !expected.has(p) && !builtin(p)).sort();
  if (missing.length || extra.length) {
    throw new Error([
      missing.length ? `declared by files but not shipped: ${missing.join(', ')}` : null,
      extra.length ? `shipped but not declared by files (and not an npm builtin): ${extra.join(', ')}` : null,
    ].filter(Boolean).join('\n'));
  }
});

// 4. market index pipeline validates (generates into /tmp, never overwrites).
// The generator itself requires npm-registry publish time (unavailable until
// you `npm publish`), so for the local gate we pin a synthetic timestamp —
// the pipeline shape is what's being validated here, not registry state.
// When DSH's own validator resolves (scripts/market-validator.mjs), the
// generator validates the regenerated document (exit 1 on INVALID) and the
// committed market.json is validated too; without a reachable dsh install the
// gate stays green and only checks the shape.
run('market index pipeline validates', () => {
  const { stderr } = execOut('node', [join(root, 'scripts', 'market-index.mjs'), '--timestamp', '9999999999', '--out', '/tmp/ua-market-check.json']);
  const validLine = stderr.split('\n').find((line) => line.includes('[market-index] valid; install target'));
  if (validLine) console.log(`   ${validLine}`);
  else console.log('   validator unavailable here; shape checks only');
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
  const validator = resolveValidator();
  if (!validator) return;
  try {
    validator.parseMarketIndex(committed, 'https://cookabc.github.io/dsh-understand-anything/market.json');
    console.log('   committed market.json passes the DSH validator');
  } catch (error) {
    throw new Error(`committed market.json INVALID at ${error?.path}: ${error?.reason ?? error?.message}`);
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
