/**
 * Deterministic, dependency-free project scanner.
 *
 * This is the "tree-sitter half" of Understand Anything, reduced to portable
 * regular expressions: the same bytes always produce the same structural
 * facts. Semantic fields (summary, tags, layer assignment) are left for the
 * LLM half, which the model writes through `ua_annotate`.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, posix as posixPath, relative, sep } from 'node:path';
import {
  DEFAULTS, fingerprint, isIgnoredPath, languageOf, posix, positiveInt,
} from './util.mjs';

/** Recursively list graphable source files, deterministically ordered. */
export async function listSourceFiles(root, options = {}) {
  const maxFiles = positiveInt(options.maxFiles, DEFAULTS.maxFiles);
  const maxFileBytes = positiveInt(options.maxFileBytes, DEFAULTS.maxFileBytes);
  const maxTotalBytes = positiveInt(options.maxTotalBytes, DEFAULTS.maxTotalBytes, 512 * 1024 * 1024);
  const signal = options.signal;

  const files = [];
  let totalBytes = 0;
  let skippedOversize = 0;
  let skippedByCap = 0;
  let truncated = false;

  const queue = [''];
  while (queue.length > 0) {
    signal?.throwIfAborted();
    const current = queue.shift();
    const absDir = current ? join(root, current) : root;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: explicit gap, not an empty directory
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const rel = current ? `${current}/${entry.name}` : entry.name;
      if (isIgnoredPath(rel)) continue;
      if (entry.isSymbolicLink()) continue; // never follow links out of the tree
      const abs = join(root, rel);
      if (entry.isDirectory()) {
        queue.push(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const language = languageOf(rel);
      if (!language) continue;
      if (files.length >= maxFiles || totalBytes >= maxTotalBytes) {
        truncated = true;
        skippedByCap += 1;
        continue;
      }
      let size;
      try {
        size = (await stat(abs)).size;
      } catch {
        continue;
      }
      if (size > maxFileBytes) {
        skippedOversize += 1;
        continue;
      }
      totalBytes += size;
      files.push({ path: posix(rel), abs, language, size });
    }
  }

  return { files, totalBytes, skippedOversize, skippedByCap, truncated };
}

/** Read one source file's text, returning null when it is not decodable text. */
export async function readSource(abs, maxBytes) {
  const text = await readFile(abs, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return null;
  if (text.includes('\u0000')) return null;
  return text;
}

/* ------------------------------------------------------------------ *
 * Symbol extraction
 * ------------------------------------------------------------------ */

/** Collect `{name, kind}` definitions from source text. */
export function extractSymbols(text, language) {
  // Keyed by name, not by (kind, name): heuristic regexes can match the same
  // definition twice, and a duplicated symbol would produce duplicate nodes.
  const found = new Map();
  const add = (name, kind) => {
    if (!name) return;
    const clean = String(name).trim().replace(/[^\w$.-]/g, '').slice(0, 120);
    if (!clean || clean.length < 2) return;
    const existing = found.get(clean);
    if (!existing) { found.set(clean, { name: clean, kind }); return; }
    // An explicit `function` definition wins over a broader `class`-ish match.
    if (kind === 'function' && existing.kind === 'class') found.set(clean, { name: clean, kind });
  };

  const run = (re, kind, group = 1) => {
    for (const m of text.matchAll(re)) add(m[group], kind);
  };

  switch (language) {
    case 'javascript':
    case 'typescript':
    case 'vue':
    case 'svelte':
      for (const m of text.matchAll(/\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|type|enum|function)\s+([A-Za-z_$][\w$]*)/g)) {
        add(m[2], m[1] === 'function' ? 'function' : 'class');
      }
      run(/\bexport\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g, 'function');
      run(/\b(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, 'class');
      run(/\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g, 'class');
      run(/\b(?:export\s+)?(?:type|enum)\s+([A-Za-z_$][\w$]*)/g, 'class');
      run(/\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g, 'function');
      run(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g, 'function');
      run(/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/g, 'function');
      break;
    case 'python':
      run(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, 'function');
      run(/^\s*class\s+([A-Za-z_]\w*)/gm, 'class');
      break;
    case 'go':
      run(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, 'function');
      run(/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/gm, 'class');
      break;
    case 'java':
    case 'kotlin':
    case 'csharp':
    case 'swift':
      run(/\b(?:class|interface|enum|struct|object|protocol|extension|trait)\s+([A-Za-z_]\w*)/g, 'class');
      run(/\b(?:fun|func)\s+([A-Za-z_]\w*)\s*\(/g, 'function');
      run(/\b(?:public|private|protected|internal|static|final|override|open|suspend|\s)+(?:fun\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*(?::[^{]+)?\{/g, 'function');
      break;
    case 'rust':
      run(/\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/g, 'function');
      run(/\b(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/g, 'class');
      break;
    case 'ruby':
    case 'php':
      run(/^\s*(?:def|function)\s+([A-Za-z_]\w*)/gm, 'function');
      run(/^\s*(?:class|interface|trait)\s+([A-Za-z_]\w*)/gm, 'class');
      break;
    case 'c':
    case 'cpp':
      run(/^\s*(?:class|struct|enum)\s+([A-Za-z_]\w*)/gm, 'class');
      run(/^\s*[\w*&:<>]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gm, 'function');
      break;
    case 'sql':
      run(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z_][\w]*)/gi, 'class');
      run(/\bCREATE\s+(?:VIEW|INDEX|FUNCTION|PROCEDURE)\s+[`"[]?([A-Za-z_][\w]*)/gi, 'function');
      break;
    case 'shell':
      run(/^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/gm, 'function');
      run(/^\s*function\s+([A-Za-z_]\w*)/gm, 'function');
      break;
    case 'markdown':
      run(/^#{1,3}\s+(.+?)\s*#*\s*$/gm, 'function'); // headings act as sections
      break;
    default:
      break;
  }

  return [...found.values()];
}

/** Extract import/require/use specifiers from source text. */
export function extractImports(text, language) {
  const specs = new Set();
  const add = (v) => {
    if (typeof v === 'string' && v.trim()) specs.add(v.trim());
  };
  const run = (re, group = 1) => {
    for (const m of text.matchAll(re)) add(m[group]);
  };

  switch (language) {
    case 'javascript':
    case 'typescript':
    case 'vue':
    case 'svelte':
      run(/\bfrom\s*['"]([^'"]+)['"]/g);
      run(/\bimport\s*['"]([^'"]+)['"]/g);
      run(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g);
      run(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g);
      run(/\bexport\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g);
      break;
    case 'python':
      run(/^\s*from\s+([\w.]+)\s+import\b/gm);
      run(/^\s*import\s+([\w.]+)/gm);
      break;
    case 'go':
      run(/^\s*(?:import\s+)?["'`]([^"'`]+)["'`]/gm);
      break;
    case 'java':
    case 'kotlin':
      run(/^\s*import\s+([\w.]+)/gm);
      break;
    case 'rust':
      run(/^\s*use\s+([\w:]+)/gm);
      break;
    case 'c':
    case 'cpp':
      run(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm);
      break;
    case 'csharp':
      run(/^\s*using\s+([\w.]+)/gm);
      break;
    case 'css':
      run(/@import\s+['"]([^'"]+)['"]/g);
      break;
    case 'markdown':
      run(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g); // wikilinks → related edges
      break;
    default:
      break;
  }
  return [...specs];
}

/** Resolve a relative import specifier to a scanned file path, if it exists. */
export function resolveImport(spec, fromFile, fileSet) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return { kind: 'external', id: `module:${spec}` };
  const base = posixPath.normalize(posixPath.join(posixPath.dirname(fromFile), spec));
  const candidates = [
    base,
    `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, `${base}.tsx`,
    `${base}.jsx`, `${base}.py`, `${base}.go`, `${base}.vue`, `${base}.json`,
    `${base}/index.js`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.py`,
    `${base}.md`,
    `${base.replace(/\.js$/, '.ts')}`, `${base.replace(/\.ts$/, '.js')}`,
  ];
  for (const candidate of candidates) {
    const clean = candidate.replace(/^\.\//, '');
    if (fileSet.has(clean)) return { kind: 'internal', id: `file:${clean}` };
  }
  return { kind: 'unresolved', id: `module:${spec}` };
}

/** Full scan: files + parsed structure, honoring budgets and cancellation. */
export async function scanProject(root, options = {}) {
  const listed = await listSourceFiles(root, options);
  const maxFileBytes = positiveInt(options.maxFileBytes, DEFAULTS.maxFileBytes);
  const signal = options.signal;
  const parsed = [];
  for (const file of listed.files) {
    signal?.throwIfAborted();
    let text;
    try {
      text = await readSource(file.abs, maxFileBytes);
    } catch {
      continue;
    }
    if (text === null) {
      listed.skippedOversize += 1;
      continue;
    }
    const lines = text.split('\n').length;
    parsed.push({
      path: file.path,
      language: file.language,
      size: Buffer.byteLength(text, 'utf8'),
      lines,
      hash: fingerprint(text),
      symbols: extractSymbols(text, file.language),
      imports: extractImports(text, file.language),
      text,
    });
  }
  return { ...listed, files: parsed };
}
