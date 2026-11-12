/**
 * Deterministic, dependency-free project scanner.
 *
 * Portable regular-expression extraction: the same bytes always produce the
 * same structural facts. Semantic fields (summary, tags, layer assignment)
 * are supplied by the model through `ua_annotate`.
 */

import { readdir, open, stat, realpath } from 'node:fs/promises';
import { join, posix as posixPath, relative, isAbsolute, resolve, sep } from 'node:path';
import {
  DEFAULTS, fingerprint, isIgnoredPath, languageOf, posix, positiveInt,
} from './util.mjs';

/** Recursively list graphable source files, deterministically ordered. */
export async function listSourceFiles(root, options = {}) {
  const maxFiles = positiveInt(options.maxFiles, DEFAULTS.maxFiles);
  const maxFileBytes = positiveInt(options.maxFileBytes, DEFAULTS.maxFileBytes);
  const maxTotalBytes = positiveInt(options.maxTotalBytes, DEFAULTS.maxTotalBytes, 512 * 1024 * 1024);
  const signal = options.signal;

  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error('SCAN_ROOT_NOT_DIRECTORY');
  const files = [];
  const skippedUnreadable = [];
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
      skippedUnreadable.push(current || '.');
      continue;
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
        skippedUnreadable.push(rel);
        continue;
      }
      if (size > maxFileBytes) {
        skippedOversize += 1;
        continue;
      }
      if (totalBytes + size > maxTotalBytes) {
        truncated = true; skippedByCap += 1; continue;
      }
      totalBytes += size;
      files.push({ path: posix(rel), abs, language, size });
    }
  }

  return { files, totalBytes, skippedOversize, skippedByCap, skippedUnreadable, truncated };
}

/** Read one source file's text, returning null when it is not decodable text. */
export async function readSource(abs, maxBytes) {
  const file = await open(abs, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) return null;
    const text = buffer.subarray(0, size).toString('utf8');
    return text.includes('\u0000') ? null : text;
  } finally { await file.close(); }
}

export const PARSER_VERSION = 3;

/** Lightweight lexical masking, preserving offsets and line breaks. Not an AST. */
export function maskSource(text, language, strings = true) {
  if (['markdown', 'json', 'yaml', 'toml', 'html'].includes(language)) return text;
  const hashComments = ['python', 'ruby', 'shell'].includes(language);
  const out = text.split('');
  const blank = (from, to) => { for (let n = from; n < to; n++) if (out[n] !== '\n' && out[n] !== '\r') out[n] = ' '; };
  for (let i = 0; i < text.length;) {
    const start = i;
    if ((hashComments && text[i] === '#') || (!hashComments && text.slice(i, i + 2) === '//')) {
      while (i < text.length && text[i] !== '\n') i++;
      blank(start, i);
    } else if (!hashComments && text.slice(i, i + 2) === '/*') {
      const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; blank(start, i);
    } else if (['javascript', 'typescript', 'vue', 'svelte'].includes(language) && text[i] === '/' && (() => {
      let prev = i - 1; while (prev >= 0 && /\s/.test(text[prev])) prev--;
      return prev < 0 || /[=(,:;!?{[|&]/.test(text[prev]) || /\b(return|case|yield)\s*$/.test(text.slice(Math.max(0, i - 24), i));
    })()) {
      // Quotes and comment delimiters inside regex literals are not strings/comments.
      let cursor = i + 1; let inClass = false; let end = -1;
      while (cursor < text.length && text[cursor] !== '\n') {
        if (text[cursor] === '\\') { cursor += 2; continue; }
        if (text[cursor] === '[') inClass = true;
        else if (text[cursor] === ']') inClass = false;
        else if (text[cursor] === '/' && !inClass) { end = cursor + 1; break; }
        cursor++;
      }
      if (end < 0) { i++; continue; }
      while (/[a-z]/i.test(text[end] ?? '') && end < text.length) end++;
      if (strings) blank(start, end);
      i = end;
    } else if (text[i] === '"' || text[i] === "'" || text[i] === '`') {
      const quote = text[i];
      const delimiter = language === 'python' && text.slice(i, i + 3) === quote.repeat(3) ? quote.repeat(3) : quote;
      i += delimiter.length;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text.slice(i, i + delimiter.length) === delimiter) { i += delimiter.length; break; }
        i++;
      }
      if (strings) blank(start, Math.min(i, text.length));
    } else i++;
  }
  return out.join('');
}

let locationText = null;
let lineStarts = [];
function sourceLocation(text, offset) {
  if (locationText !== text) {
    locationText = text; lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  }
  let lo = 0; let hi = lineStarts.length;
  while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid; }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}

export function extractCallSites(text, language) {
  if (['markdown', 'json', 'yaml', 'toml', 'html', 'css', 'sql'].includes(language)) return [];
  const masked = maskSource(text, language);
  const calls = [];
  for (const match of masked.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (['if', 'for', 'while', 'switch', 'catch', 'function', 'require', 'import', 'return'].includes(match[1])) continue;
    calls.push({ name: match[1], ...sourceLocation(text, match.index) });
  }
  return calls;
}

/* ------------------------------------------------------------------ *
 * Symbol extraction
 * ------------------------------------------------------------------ */

/** Collect `{name, kind}` definitions from source text. */
export function extractSymbols(text, language) {
  text = maskSource(text, language);
  // Keyed by name, not by (kind, name): heuristic regexes can match the same
  // definition twice, and a duplicated symbol would produce duplicate nodes.
  const found = new Map();
  const add = (name, kind, offset = 0) => {
    if (!name) return;
    const clean = String(name).trim().replace(/[^\w$.-]/g, '').slice(0, 120);
    if (!clean) return;
    const existing = found.get(clean);
    if (!existing) { found.set(clean, { name: clean, kind, ...sourceLocation(text, offset) }); return; }
    // An explicit `function` definition wins over a broader `class`-ish match.
    if (kind === 'function' && existing.kind === 'class') found.set(clean, { name: clean, kind, ...sourceLocation(text, offset) });
  };

  const run = (re, kind, group = 1) => {
    for (const m of text.matchAll(re)) add(m[group], kind, m.index + m[0].indexOf(m[group]));
  };

  switch (language) {
    case 'javascript':
    case 'typescript':
    case 'vue':
    case 'svelte':
      for (const m of text.matchAll(/\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|type|enum|function)\s+([A-Za-z_$][\w$]*)/g)) {
        add(m[2], m[1] === 'function' ? 'function' : 'class', m.index + m[0].lastIndexOf(m[2]));
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
export function extractImports(text, language, withLocations = false) {
  const masked = maskSource(text, language);
  text = maskSource(text, language, false);
  const locations = [];
  const specs = new Set();
  const add = (v) => {
    if (typeof v === 'string' && v.trim()) specs.add(v.trim());
  };
  const run = (re, group = 1) => {
    for (const m of text.matchAll(re)) {
      const offset = m.index + m[0].search(/\S/);
      if (language !== 'markdown' && !masked.slice(offset, offset + 1).trim()) continue;
      add(m[group]);
      locations.push({ spec: m[group], ...sourceLocation(text, offset) });
    }
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
    case 'go': {
      // Block form: `import` and its parentheses are code, so they survive
      // string masking, while the quoted paths only exist in `text`. Anchor
      // the block in `masked`, then harvest quoted paths from the same span
      // in `text`; alias/`_`/`.` prefixes are unquoted and comments are
      // already blanked there.
      for (const m of masked.matchAll(/^\s*import\s*\(/gm)) {
        const close = masked.indexOf(')', m.index);
        const body = text.slice(m.index, close < 0 ? text.length : close);
        for (const q of body.matchAll(/"([^"\n]+)"/g)) {
          const offset = m.index + q.index;
          add(q[1]);
          locations.push({ spec: q[1], ...sourceLocation(text, offset) });
        }
      }
      run(/^\s*import\s+["'`]([^"'`]+)["'`]/gm); // single-line form
      break;
    }
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
  return withLocations ? locations : [...specs];
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
  root = resolve(root);
  const walkRoot = options.scope ? resolve(root, options.scope) : root;
  const lexical = relative(root, walkRoot);
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw new Error('PATH_OUTSIDE_ROOT: scan scope');
  const actualRoot = await realpath(root);
  const actualWalk = await realpath(walkRoot);
  const check = relative(actualRoot, actualWalk);
  if (check === '..' || check.startsWith(`..${sep}`) || isAbsolute(check)) throw new Error('PATH_OUTSIDE_ROOT: scan scope');
  const scope = posix(relative(root, walkRoot));
  const listed = await listSourceFiles(walkRoot, options);
  listed.files = listed.files.map((f) => ({ ...f, path: scope ? `${scope}/${f.path}` : f.path }));
  listed.scope = scope || null;
  listed.parsedFiles = 0;
  listed.reusedFiles = 0;
  const cached = options.previous?.meta?.parserVersion === PARSER_VERSION ? options.previous.meta.fileStructure ?? {} : {};
  const maxFileBytes = positiveInt(options.maxFileBytes, DEFAULTS.maxFileBytes);
  const signal = options.signal;
  const parsed = [];
  for (const file of listed.files) {
    signal?.throwIfAborted();
    let text;
    try {
      text = await readSource(file.abs, maxFileBytes);
    } catch {
      listed.skippedUnreadable.push(file.path);
      continue;
    }
    if (text === null) {
      listed.skippedOversize += 1;
      continue;
    }
    const lines = text.split('\n').length;
    const hash = fingerprint(text);
    const prior = cached[file.path];
    const reusable = prior?.hash === hash && Array.isArray(prior.symbols) && Array.isArray(prior.imports) && Array.isArray(prior.callSites) && Array.isArray(prior.importSites);
    if (reusable) listed.reusedFiles++; else listed.parsedFiles++;
    parsed.push({
      path: file.path,
      language: file.language,
      size: Buffer.byteLength(text, 'utf8'),
      lines,
      hash,
      symbols: options.parse === false ? [] : reusable ? prior.symbols : extractSymbols(text, file.language),
      imports: options.parse === false ? [] : reusable ? prior.imports : extractImports(text, file.language),
      importSites: options.parse === false ? [] : reusable ? prior.importSites : extractImports(text, file.language, true),
      callSites: options.parse === false ? [] : reusable ? prior.callSites : extractCallSites(text, file.language),
      text,
    });
  }
  return { ...listed, files: parsed };
}
