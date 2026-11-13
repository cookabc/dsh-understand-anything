import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject, extractSymbols, extractImports, parseGoModText, parseTsConfigPaths, resolveImport } from '../lib/scanner.mjs';
import { classifyLayer, fingerprint, inside, isIgnoredPath, languageOf, mergeConfig, safeRoot } from '../lib/util.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'ua-scanner-'));

test('config merge: per-project settings win over environment fallbacks', () => {
  /* 环境变量是"没有配置文件时的兜底"，不是覆盖项。反过来的话，一个 shell 里
     导出的 UA_MAX_FILES 会让项目自己写的设置静默失效，而 ua_config 存进去的值
     看起来像没生效。工具参数在任何情况下都最后应用，那一步不在这里。 */
  const defaults = { language: 'en', maxFiles: 4000, maxFileBytes: 524288 };
  const merged = mergeConfig(
    defaults,
    { language: 'zh', maxFiles: 10 },
    { UA_LANGUAGE: 'en', UA_MAX_FILES: '9999', UA_MAX_FILE_BYTES: '111' },
  );
  assert.equal(merged.language, 'zh', '配置文件覆盖环境变量');
  assert.equal(merged.maxFiles, 10, '配置文件覆盖环境变量');
  assert.equal(merged.maxFileBytes, 111, '配置文件没写的键由环境变量补上');
  assert.deepEqual(mergeConfig(defaults, null, {}), defaults, '两者都没有时保持默认值');
});

test('utility: ignore rules, language mapping, path safety', () => {
  assert.equal(isIgnoredPath('node_modules/pkg/index.js'), true);
  assert.equal(isIgnoredPath('dist/app.min.js'), true);
  assert.equal(isIgnoredPath('src/app.ts'), false);
  assert.equal(languageOf('src/app.tsx'), 'typescript');
  assert.equal(languageOf('a.bin'), null);
  assert.equal(classifyLayer('src/api/routes/user.ts'), 'API');
  assert.equal(classifyLayer('src/services/order.ts'), 'Service');
  assert.equal(classifyLayer('src/db/schema.sql'), 'Data');
  assert.equal(classifyLayer('src/ui/Button.tsx'), 'UI');
  assert.equal(classifyLayer('src/utils/format.ts'), 'Utility');
  assert.equal(fingerprint('abc'), fingerprint('abc'));
  assert.notEqual(fingerprint('abc'), fingerprint('abd'));
  assert.equal(inside('/p', 'src/a.ts'), '/p/src/a.ts');
  assert.throws(() => inside('/p', '../etc/passwd'), /PATH_OUTSIDE_ROOT/);
  assert.throws(() => safeRoot('/'), /UNSAFE_ROOT/);
});

test('symbols: JavaScript / TypeScript', () => {
  const src = `
import { helper } from './utils/helper.js';
export class App { run() {} }
export function main(a) { helper(a); }
const boot = async () => main(1);
export interface Options { verbose: boolean }
type Id = string;
`;
  const symbols = extractSymbols(src, 'javascript');
  const names = symbols.map((s) => s.name);
  assert.ok(names.includes('App'));
  assert.ok(names.includes('main'));
  assert.ok(names.includes('boot'));
  assert.ok(names.includes('Options'));
  assert.ok(names.includes('Id'));
  assert.ok(symbols.some((s) => s.name === 'App' && s.kind === 'class'));
  assert.ok(symbols.some((s) => s.name === 'main' && s.kind === 'function'));
});

test('symbols: Python, Go, Rust, Markdown', () => {
  assert.deepEqual(extractSymbols('class Repo:\n    def save(self):\n        pass\nasync def load(): pass', 'python').map((s) => s.name).sort(), ['Repo', 'load', 'save']);
  assert.ok(extractSymbols('func (s *Server) Serve() {}\ntype Config struct {}', 'go').some((s) => s.name === 'Serve'));
  assert.ok(extractSymbols('pub fn start() {}\nstruct Handler;', 'rust').some((s) => s.name === 'start'));
  assert.ok(extractSymbols('# Title\n## Subtitle', 'markdown').some((s) => s.name === 'Title'));
});

test('imports: specifiers and wiki links', () => {
  const js = `import x from './a.js';\nconst y = require('lodash');\nimport('dynamic');\nexport * from './b.ts';`;
  assert.deepEqual(new Set(extractImports(js, 'javascript')), new Set(['./a.js', 'lodash', 'dynamic', './b.ts']));
  const py = 'from pkg.mod import thing\nimport os.path';
  assert.deepEqual(new Set(extractImports(py, 'python')), new Set(['pkg.mod', 'os.path']));
  assert.deepEqual(extractImports('See [[Architecture Notes]] and [[Other]].', 'markdown'), ['Architecture Notes', 'Other']);
});

test('imports: Go block form, aliases and locations', () => {
  const src = 'package main\n\nimport (\n\t"fmt"\n\texe "os/exec"\n\t_ "embed" // fake "nope/leak"\n\t. "math"\n)\n\nfunc main() {}\n';
  assert.deepEqual(extractImports(src, 'go'), ['fmt', 'os/exec', 'embed', 'math']);
  assert.deepEqual(extractImports(src, 'go', true).map((s) => [s.spec, s.line, s.column]), [
    ['fmt', 4, 2], ['os/exec', 5, 6], ['embed', 6, 4], ['math', 7, 4],
  ]);
  // A raw-string doc example must not be read as real imports.
  assert.deepEqual(extractImports('package main\n\nconst help = `usage:\nimport (\n\t"fake/pkg"\n)`\n\nfunc main() {}\n', 'go'), []);
  // Single-line form is unchanged.
  assert.deepEqual(extractImports('package main\nimport "fmt"\nfunc main(){}\n', 'go'), ['fmt']);
  assert.deepEqual(extractImports('package main\nimport "fmt"\nfunc main(){}\n', 'go', true), [{ spec: 'fmt', line: 2, column: 1 }]);
});

test('imports: Rust use trees, aliases, globs and locations', () => {
  const repro = 'mod a;\nuse std::{\n    collections::HashMap,\n    fs,\n};\nuse serde::Serialize;\n';
  assert.deepEqual(extractImports(repro, 'rust'), ['std::collections::HashMap', 'std::fs', 'serde::Serialize']);
  // Nested groups join every leaf with its enclosing prefixes.
  assert.deepEqual(extractImports('use a::{b::{c, d}, e};', 'rust'), ['a::b::c', 'a::b::d', 'a::e']);
  // A bare `self` leaf collapses to the root prefix itself.
  assert.deepEqual(extractImports('use a::{self, b::c};', 'rust'), ['a', 'a::b::c']);
  // Aliases keep the pre-`as` real path, in trees and on plain lines.
  assert.deepEqual(extractImports('use a::{b as x, c::d as y};\nuse e::f as z;', 'rust'), ['a::b', 'a::c::d', 'e::f']);
  // Globs keep the `::*` suffix in the spec.
  assert.deepEqual(extractImports('use a::*;', 'rust'), ['a::*']);
  assert.deepEqual(extractImports('use a::{b::*, c};', 'rust'), ['a::b::*', 'a::c']);
  // Single-line brace trees expand the same way.
  assert.deepEqual(extractImports('use a::{b, c};', 'rust'), ['a::b', 'a::c']);
  // Single-line plain paths are unchanged.
  assert.deepEqual(extractImports('use std::io::Read;\n', 'rust'), ['std::io::Read']);
  // Comments inside the tree are masked before parsing and never leak into specs.
  assert.deepEqual(extractImports('use a::{ // note\n    b,\n    /* mid */ c,\n};', 'rust'), ['a::b', 'a::c']);
  // A `use` statement inside a multi-line string literal is not an import.
  assert.deepEqual(extractImports('const s = "\nuse fake::{a, b};\n";', 'rust'), []);
  // Each expanded leaf anchors at its own leading token, not at the `use` keyword.
  const tree = 'use a::{\n    b::{c, d},\n    self,\n    e as f,\n};\n';
  assert.deepEqual(extractImports(tree, 'rust', true), [
    { spec: 'a::b::c', line: 2, column: 9 },
    { spec: 'a::b::d', line: 2, column: 12 },
    { spec: 'a', line: 3, column: 5 },
    { spec: 'a::e', line: 4, column: 5 },
  ]);
  assert.deepEqual(extractImports('use a::*;\nuse b::c;\n', 'rust', true), [
    { spec: 'a::*', line: 1, column: 5 },
    { spec: 'b::c', line: 2, column: 5 },
  ]);
});

test('resolveImport: relative resolution and external modules', () => {
  const set = new Set(['src/utils/helper.js', 'src/index.ts', 'src/api/index.ts']);
  assert.deepEqual(resolveImport('./utils/helper.js', 'src/index.ts', set), { kind: 'internal', id: 'file:src/utils/helper.js' });
  assert.deepEqual(resolveImport('./utils/helper', 'src/index.ts', set), { kind: 'internal', id: 'file:src/utils/helper.js' });
  assert.deepEqual(resolveImport('./api', 'src/index.ts', set), { kind: 'internal', id: 'file:src/api/index.ts' });
  assert.deepEqual(resolveImport('lodash', 'src/index.ts', set), { kind: 'external', id: 'module:lodash' });
  assert.deepEqual(resolveImport('./missing', 'src/index.ts', set), { kind: 'unresolved', id: 'module:./missing' });
});

test('scanProject: walks a fixture, honors caps and is deterministic', async () => {
  const root = await tmp();
  try {
    await mkdir(join(root, 'src/utils'), { recursive: true });
    await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{}\n');
    await writeFile(join(root, 'src/index.js'), 'import { helper } from "./utils/helper.js";\nexport function main() { helper(); }\n');
    await writeFile(join(root, 'src/utils/helper.js'), 'export function helper() { return 1; }\n');
    await writeFile(join(root, 'src/model.py'), 'class Repo:\n    def save(self): pass\n');
    await writeFile(join(root, 'node_modules/pkg/index.js'), 'export const x = 1;\n');
    const first = await scanProject(root);
    const second = await scanProject(root);
    const paths = first.files.map((f) => f.path).sort();
    assert.ok(!paths.some((p) => p.startsWith('node_modules/')));
    assert.ok(!paths.includes('package-lock.json'));
    assert.ok(paths.includes('package.json'), 'manifests are graphed as config nodes and used for framework detection');
    assert.ok(paths.includes('src/index.js'));
    assert.ok(paths.includes('src/utils/helper.js'));
    assert.ok(paths.includes('src/model.py'));
    assert.deepEqual(first.files.map((f) => f.hash), second.files.map((f) => f.hash));
    assert.equal(first.truncated, false);

    const capped = await scanProject(root, { maxFiles: 1 });
    assert.equal(capped.truncated, true);
    assert.equal(capped.files.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parseTsConfigPaths: tolerates JSONC comments and trailing commas, keeps strings intact', () => {
  const text = `{
    // line comment with "quotes" and {braces}
    /* block
       comment */
    "compilerOptions": {
      "baseUrl": "src", // trailing comment
      "paths": {
        "@/*": ["./helpers/*",],
        "@app": ["../app/index.ts",],
        // the comment text below must not swallow the next entry
        "@note": ["./x,]"], /* "fake"//string */
      },
    },
    "include": ["src/**/*"],
  }`;
  assert.deepEqual(parseTsConfigPaths(text), {
    baseUrl: 'src',
    paths: {
      '@/*': ['./helpers/*'],
      '@app': ['../app/index.ts'],
      '@note': ['./x,]'],
    },
  });
  // Plain JSON without comments keeps working.
  assert.deepEqual(parseTsConfigPaths('{"compilerOptions":{"paths":{"a/*":["./a/*"]}}}'), { baseUrl: '.', paths: { 'a/*': ['./a/*'] } });
  // A `//` inside a string is not a comment.
  assert.deepEqual(parseTsConfigPaths('{"compilerOptions":{"paths":{"a//b":["./x"]}}}'), { baseUrl: '.', paths: { 'a//b': ['./x'] } });
  // Missing paths, malformed JSONC and wrong shapes all degrade to null.
  assert.equal(parseTsConfigPaths('{"compilerOptions":{"baseUrl":"."}}'), null);
  assert.equal(parseTsConfigPaths('{ "compilerOptions": {, }'), null);
  assert.equal(parseTsConfigPaths(''), null);
  assert.equal(parseTsConfigPaths('{"compilerOptions":{"paths":{"a":42}}}'), null);
});

test('resolveImport: tsconfig paths aliases (wildcard, exact, priority, fallback)', () => {
  const set = new Set(['src/utils/x.ts', 'src/utils/index.ts', 'packages/app/src/index.ts']);
  const aliases = { baseUrl: '.', paths: { '@/*': ['./src/*'], '@app': ['packages/app/src'], '~/utils/*': ['./src/utils/*'] } };
  // Wildcard pattern substitutes the matched segment into the target.
  assert.deepEqual(resolveImport('@/utils/x', 'src/main.ts', set, aliases), { kind: 'internal', id: 'file:src/utils/x.ts', via: 'alias' });
  // Extension and index-form candidates apply to alias targets too.
  assert.deepEqual(resolveImport('@/utils', 'src/main.ts', set, aliases), { kind: 'internal', id: 'file:src/utils/index.ts', via: 'alias' });
  // Exact pattern without `*` (monorepo package name to directory).
  assert.deepEqual(resolveImport('@app', 'src/main.ts', set, aliases), { kind: 'internal', id: 'file:packages/app/src/index.ts', via: 'alias' });
  // Non-star target under a wildcard pattern maps the whole spec there.
  assert.deepEqual(resolveImport('@/utils/index.ts', 'src/main.ts', set, { baseUrl: '.', paths: { '@/*': ['./src/utils'] } }), { kind: 'internal', id: 'file:src/utils/index.ts', via: 'alias' });
  // baseUrl joins before candidate expansion.
  assert.deepEqual(resolveImport('@/utils/x', 'src/main.ts', set, { baseUrl: 'src', paths: { '@/*': ['./*'] } }), { kind: 'internal', id: 'file:src/utils/x.ts', via: 'alias' });
  // First matching rule wins when several resolve.
  assert.deepEqual(resolveImport('@/utils/x', 'src/main.ts', set, { baseUrl: '.', paths: { '@/*': ['./src/*'], '*/utils/x': ['./other/*'] } }), { kind: 'internal', id: 'file:src/utils/x.ts', via: 'alias' });
  // A miss under one rule still lets a later rule resolve.
  assert.deepEqual(resolveImport('@/utils/x', 'src/main.ts', set, { baseUrl: '.', paths: { 'nomatch/*': ['./other/*'], '@/*': ['./src/*'] } }).id, 'file:src/utils/x.ts');
  // Alias miss and bare specifiers fall back to external, as before.
  assert.deepEqual(resolveImport('@/missing', 'src/main.ts', set, aliases), { kind: 'external', id: 'module:@/missing' });
  assert.deepEqual(resolveImport('react', 'src/main.ts', set, aliases), { kind: 'external', id: 'module:react' });
  assert.deepEqual(resolveImport('react', 'src/main.ts', set), { kind: 'external', id: 'module:react' });
  // Relative specifiers keep priority and behavior; aliases never intercept them.
  assert.deepEqual(resolveImport('./utils/index.ts', 'src/main.ts', set, aliases), { kind: 'internal', id: 'file:src/utils/index.ts' });
  assert.deepEqual(resolveImport('./missing', 'src/main.ts', set, aliases), { kind: 'unresolved', id: 'module:./missing' });
});

test('scanProject: auto-detects tsconfig aliases and fails safe', async () => {
  const root = await tmp();
  try {
    await mkdir(join(root, 'src/utils'), { recursive: true });
    await writeFile(join(root, 'tsconfig.json'), `{
      // alias map
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@/*": ["./src/*"], },
      },
    }\n`);
    await writeFile(join(root, 'src/index.ts'), "import { x } from '@/utils/x';\nimport dayjs from 'dayjs';\n");
    await writeFile(join(root, 'src/utils/x.ts'), 'export const x = 1;\n');
    const scan = await scanProject(root);
    assert.deepEqual(scan.aliases, { baseUrl: '.', paths: { '@/*': ['./src/*'] } });
    const fileSet = new Set(scan.files.map((f) => f.path));
    assert.deepEqual(resolveImport('@/utils/x', 'src/index.ts', fileSet, scan.aliases), { kind: 'internal', id: 'file:src/utils/x.ts', via: 'alias' });
    assert.deepEqual(resolveImport('dayjs', 'src/index.ts', fileSet, scan.aliases), { kind: 'external', id: 'module:dayjs' });

    // Unparsable tsconfig degrades to no aliases; the scan itself still succeeds.
    await writeFile(join(root, 'tsconfig.json'), '{ "compilerOptions": {,');
    assert.equal((await scanProject(root)).aliases, null);

    // A tsconfig without paths is also "no aliases".
    await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{"target":"es2022"}}');
    assert.equal((await scanProject(root)).aliases, null);

    // Absent tsconfig.
    await rm(join(root, 'tsconfig.json'));
    assert.equal((await scanProject(root)).aliases, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanProject: tsConfig override and scope-relative alias targets', async () => {
  const root = await tmp();
  try {
    await mkdir(join(root, 'packages/app/src/utils'), { recursive: true });
    await writeFile(join(root, 'packages/app/src/index.ts'), "import { x } from '@/utils/x';\n");
    await writeFile(join(root, 'packages/app/src/utils/x.ts'), 'export const x = 1;\n');
    const scan = await scanProject(root, { scope: 'packages/app', tsConfig: { paths: { '@/*': ['./src/*'] } } });
    assert.deepEqual(scan.aliases, { baseUrl: 'packages/app', paths: { '@/*': ['./src/*'] } });
    const fileSet = new Set(scan.files.map((f) => f.path));
    assert.deepEqual(resolveImport('@/utils/x', 'packages/app/src/index.ts', fileSet, scan.aliases), { kind: 'internal', id: 'file:packages/app/src/utils/x.ts', via: 'alias' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parseGoModText: module path, local replaces, comments and fail-safe', () => {
  const text = `module example.com/app

go 1.22

require (
\tgithub.com/dep v1.0.0
)

// swap a dependency for a local copy
replace example.com/x => ./local/x // trailing note
replace example.com/x/sub v1.2.3 => ../shared/sub

replace (
\texample.com/y => ./vendor/y
\texample.com/y/extra v0.1.0 => ./vendor/extra
\texample.com/net => github.com/other/net
)
`;
  // Network (module-path) replace targets are dropped; versioned old sides keep only the path.
  assert.deepEqual(parseGoModText(text), {
    module: 'example.com/app',
    replaces: {
      'example.com/x': './local/x',
      'example.com/x/sub': '../shared/sub',
      'example.com/y': './vendor/y',
      'example.com/y/extra': './vendor/extra',
    },
  });
  // No module directive, blank input and wrong types degrade to null.
  assert.equal(parseGoModText('go 1.22\n'), null);
  assert.equal(parseGoModText(''), null);
  assert.equal(parseGoModText(null), null);
});

test('resolveImport: go.mod module paths, local replaces and priority', () => {
  const set = new Set([
    'internal/store.go', 'internal/db/db.go',
    'local/x/x.go', 'local/x/adapter.go',
    'vendor/y/y.go', 'vendor/extra/x/x.go', 'ts/shim.ts',
  ]);
  const go = { module: 'example.com/app', scope: '', replaces: { 'example.com/x': 'local/x', 'example.com/y': 'vendor/y', 'example.com/y/extra': 'vendor/extra' } };
  // `<pkg>.go` next to the package directory.
  assert.deepEqual(resolveImport('example.com/app/internal/store', 'main.go', set, null, go), { kind: 'internal', id: 'file:internal/store.go', via: 'module' });
  // Package file named after the last directory segment (`db/db.go`).
  assert.deepEqual(resolveImport('example.com/app/internal/db', 'main.go', set, null, go), { kind: 'internal', id: 'file:internal/db/db.go', via: 'module' });
  // The module path itself has no file candidate and stays external.
  assert.deepEqual(resolveImport('example.com/app', 'main.go', set, null, go), { kind: 'external', id: 'module:example.com/app' });
  // Prefix miss and unmatched candidates stay external, never fabricated.
  assert.deepEqual(resolveImport('example.com/app/internal/missing', 'main.go', set, null, go), { kind: 'external', id: 'module:example.com/app/internal/missing' });
  // Replace targets root the resolved path, including the replace root itself.
  assert.deepEqual(resolveImport('example.com/x', 'main.go', set, null, go), { kind: 'internal', id: 'file:local/x/x.go', via: 'replace' });
  assert.deepEqual(resolveImport('example.com/x/adapter', 'main.go', set, null, go), { kind: 'internal', id: 'file:local/x/adapter.go', via: 'replace' });
  // A replace match that resolves to nothing stays external with the original spec.
  assert.deepEqual(resolveImport('example.com/x/nope', 'main.go', set, null, go), { kind: 'external', id: 'module:example.com/x/nope' });
  // The most specific replace prefix wins when several match.
  assert.deepEqual(resolveImport('example.com/y/extra/x', 'main.go', set, null, go), { kind: 'internal', id: 'file:vendor/extra/x/x.go', via: 'replace' });
  assert.deepEqual(resolveImport('example.com/y', 'main.go', set, null, go), { kind: 'internal', id: 'file:vendor/y/y.go', via: 'replace' });
  // tsconfig aliases keep priority over go.mod for matching specs.
  assert.deepEqual(resolveImport('example.com/app/internal/store', 'main.ts', set, { baseUrl: '.', paths: { 'example.com/app/internal/store': ['./ts/shim.ts'] } }, go), { kind: 'internal', id: 'file:ts/shim.ts', via: 'alias' });
  // Relative specifiers are never intercepted by go.mod.
  assert.deepEqual(resolveImport('./internal/store.go', 'main.go', set, null, go), { kind: 'internal', id: 'file:internal/store.go' });
  // Without module info the old external behavior is unchanged.
  assert.deepEqual(resolveImport('example.com/app/internal/store', 'main.go', set), { kind: 'external', id: 'module:example.com/app/internal/store' });
  assert.deepEqual(resolveImport('example.com/app/internal/store', 'main.go', set, null, null), { kind: 'external', id: 'module:example.com/app/internal/store' });
});

test('scanProject: auto-detects go.mod module paths and fails safe', async () => {
  const root = await tmp();
  try {
    await mkdir(join(root, 'internal/store'), { recursive: true });
    await mkdir(join(root, 'local/x'), { recursive: true });
    await writeFile(join(root, 'go.mod'), 'module example.com/app\n\nreplace example.com/x => ./local/x\nreplace example.com/net => github.com/other/net\n');
    await writeFile(join(root, 'main.go'), 'package main\n\nimport (\n\t"fmt"\n\t"example.com/app/internal/store"\n\t"example.com/x/adapter"\n\t"example.com/net/pkg"\n)\n\nfunc main() {}\n');
    await writeFile(join(root, 'internal/store/store.go'), 'package store\n\nfunc Save() {}\n');
    await writeFile(join(root, 'local/x/adapter.go'), 'package x\n\nfunc Adapter() {}\n');
    const scan = await scanProject(root);
    assert.deepEqual(scan.goModule, { module: 'example.com/app', scope: '', replaces: { 'example.com/x': 'local/x' } });
    const fileSet = new Set(scan.files.map((f) => f.path));
    assert.deepEqual(resolveImport('example.com/app/internal/store', 'main.go', fileSet, null, scan.goModule), { kind: 'internal', id: 'file:internal/store/store.go', via: 'module' });
    assert.deepEqual(resolveImport('example.com/x/adapter', 'main.go', fileSet, null, scan.goModule), { kind: 'internal', id: 'file:local/x/adapter.go', via: 'replace' });
    // Network replaces are ignored and stdlib imports stay external.
    assert.deepEqual(resolveImport('example.com/net/pkg', 'main.go', fileSet, null, scan.goModule), { kind: 'external', id: 'module:example.com/net/pkg' });
    assert.deepEqual(resolveImport('fmt', 'main.go', fileSet, null, scan.goModule), { kind: 'external', id: 'module:fmt' });

    // Unparsable go.mod (no module directive) degrades to no module info.
    await writeFile(join(root, 'go.mod'), 'go 1.22\n');
    assert.equal((await scanProject(root)).goModule, null);

    // Absent go.mod.
    await rm(join(root, 'go.mod'));
    assert.equal((await scanProject(root)).goModule, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanProject: goModule override and scope-relative replace targets', async () => {
  const root = await tmp();
  try {
    await mkdir(join(root, 'packages/app/internal/store'), { recursive: true });
    await mkdir(join(root, 'packages/app/local/x'), { recursive: true });
    await writeFile(join(root, 'packages/app/main.go'), 'package main\n\nimport (\n\t"example.com/app/internal/store"\n\t"example.com/x"\n)\n\nfunc main() {}\n');
    await writeFile(join(root, 'packages/app/internal/store/store.go'), 'package store\n\nfunc Save() {}\n');
    await writeFile(join(root, 'packages/app/local/x/x.go'), 'package x\n\nfunc Run() {}\n');
    const scan = await scanProject(root, { scope: 'packages/app', goModule: { module: 'example.com/app', replaces: { 'example.com/x': './local/x' } } });
    assert.deepEqual(scan.goModule, { module: 'example.com/app', scope: 'packages/app', replaces: { 'example.com/x': 'packages/app/local/x' } });
    const fileSet = new Set(scan.files.map((f) => f.path));
    assert.deepEqual(resolveImport('example.com/app/internal/store', 'packages/app/main.go', fileSet, null, scan.goModule), { kind: 'internal', id: 'file:packages/app/internal/store/store.go', via: 'module' });
    assert.deepEqual(resolveImport('example.com/x', 'packages/app/main.go', fileSet, null, scan.goModule), { kind: 'internal', id: 'file:packages/app/local/x/x.go', via: 'replace' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
