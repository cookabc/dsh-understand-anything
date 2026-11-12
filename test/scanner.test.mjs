import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject, extractSymbols, extractImports, resolveImport } from '../lib/scanner.mjs';
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
