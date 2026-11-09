/**
 * Shared, dependency-free helpers for the plugin.
 *
 * Everything in this package is plain Node ESM with zero runtime imports: a
 * third-party DSH bundle is installed into a profile and cannot reliably
 * resolve `@deepseek-ai/*` packages from its own directory, so we deliberately
 * use only Node built-ins and register wire-level tool/skill objects.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { stat } from 'node:fs/promises';

/** Directories that never contain first-party source worth graphing. */
export const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit',
  '.cache', '.parcel-cache', '.turbo', 'target', 'bin', 'obj',
  '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache',
  '.idea', '.vscode', '.dsh', '.ua', '.understand-anything',
  'Pods', 'DerivedData', '.gradle', 'tmp', 'temp', 'logs',
]);

/** Basenames that are generated, binary-adjacent, or pure lock data. */
export const IGNORED_BASENAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock',
  'poetry.lock', 'Pipfile.lock', 'composer.lock', 'Gemfile.lock',
  'go.sum', 'bun.lockb', 'bun.lock', '.DS_Store', 'Thumbs.db',
]);

/** Extensions we graph, mapped to a normalized language name. */
export const LANGUAGE_BY_EXT = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
  '.mts': 'typescript', '.cts': 'typescript',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.vue': 'vue', '.svelte': 'svelte',
  '.sql': 'sql',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.md': 'markdown', '.mdx': 'markdown',
  '.json': 'json',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.toml': 'toml',
  '.html': 'html', '.css': 'css', '.scss': 'css',
};

/** Node kinds for non-source files. */
export const DOCUMENT_NODE_TYPE = {
  markdown: 'document',
  json: 'config',
  yaml: 'config',
  toml: 'config',
  sql: 'table',
  html: 'resource',
  css: 'resource',
};

/** Hard caps; a scan refuses to silently eat a whole disk. */
export const DEFAULTS = {
  maxFiles: 4000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  language: 'en',
};

/** True when a relative POSIX-style path should be skipped. */
export function isIgnoredPath(relPath) {
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;
    if (IGNORED_DIRS.has(part)) return true;
    // Hidden directories are configuration/build noise, not first-party source.
    if (i < parts.length - 1 && part.startsWith('.') && part !== '.' && part !== '..') return true;
  }
  const base = parts[parts.length - 1] ?? '';
  if (IGNORED_BASENAMES.has(base)) return true;
  if (/\.(min|bundle)\.(js|css)$/i.test(base)) return true;
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|gz|tgz|jar|class|wasm|so|dylib|dll|exe|bin|woff2?|ttf|eot|mp4|mp3|wav)$/i.test(base)) return true;
  return false;
}

/** Language for a path, or null when the extension is not graphed. */
export function languageOf(relPath) {
  const dot = relPath.lastIndexOf('.');
  if (dot < 0) return null;
  return LANGUAGE_BY_EXT[relPath.slice(dot).toLowerCase()] ?? null;
}

/** Resolve `rel` inside `root`, refusing traversal and absolute escapes. */
export function inside(root, rel) {
  const target = resolve(root, rel);
  const relCheck = relative(root, target);
  if (relCheck === '..' || relCheck.startsWith(`..${sep}`) || isAbsolute(relCheck)) {
    throw new Error(`PATH_OUTSIDE_ROOT: ${rel}`);
  }
  return target;
}

/** Normalize a user-supplied project root and reject unsafe roots. */
export function safeRoot(input, cwd = process.cwd()) {
  const root = resolve(input || cwd);
  if (root === resolve('/') || root === resolve(homedir())) {
    throw new Error('UNSAFE_ROOT: pass a project directory, not / or the home directory');
  }
  return root;
}

/** SHA-256 hex prefix used as a deterministic file fingerprint. */
export function fingerprint(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** ISO timestamp. */
export function nowIso() {
  return new Date().toISOString();
}

/** POSIX-style relative path (graph IDs are portable across hosts). */
export function posix(rel) {
  return rel.split(sep).join('/');
}

/** True when `root` is an existing directory. */
export async function isDirectory(root) {
  try {
    return (await stat(root)).isDirectory();
  } catch {
    return false;
  }
}

/** Architectural layer derived from path conventions. */
export function classifyLayer(relPath) {
  const p = relPath.toLowerCase();
  const has = (re) => re.test(p);
  if (has(/(^|\/)(api|routes?|controllers?|handlers?|endpoints?|views?\.py|urls\.py)(\/|$)/)) return 'API';
  if (has(/(^|\/)(services?|usecases?|use-cases|domain|business|logic)(\/|$)/)) return 'Service';
  if (has(/(^|\/)(models?|db|database|data|repositor(y|ies)|dao|entities|migrations?|schemas?)(\/|$)/)) return 'Data';
  if (has(/(^|\/)(ui|components?|pages?|views?|frontend|client|screens?|widgets?)(\/|$)/)) return 'UI';
  if (has(/(^|\/)(utils?|helpers?|lib|libs|common|shared|constants?|types?)(\/|$)/)) return 'Utility';
  if (has(/(^|\/)(tests?|specs?|__tests__|e2e)(\/|$)/)) return 'Test';
  return 'Other';
}

/** Merge defaults < environment < per-project settings; callers apply tool args last. */
export function mergeConfig(defaults, configFile, env = process.env) {
  return {
    ...defaults,
    ...(env.UA_LANGUAGE ? { language: env.UA_LANGUAGE } : {}),
    ...(env.UA_MAX_FILES ? { maxFiles: Number(env.UA_MAX_FILES) } : {}),
    ...(env.UA_MAX_FILE_BYTES ? { maxFileBytes: Number(env.UA_MAX_FILE_BYTES) } : {}),
    ...(configFile && typeof configFile === 'object' ? configFile : {}),
  };
}

/** Clamp a positive integer option, falling back on invalid input. */
export function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** Join a root with a generated data directory name. */
export function dataDirName(root) {
  return join(root, '.ua');
}

