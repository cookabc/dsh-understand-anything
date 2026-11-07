/** Read-only git helpers. Never uses a shell; every call is bounded. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function git(root, args) {
  try {
    const { stdout } = await run('git', ['-C', root, ...args], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error) {
    // A missing git binary or a non-repository is a normal, reportable state.
    if (error?.code === 'ENOENT' || error?.code === 128 || error?.code === 129) return null;
    return null;
  }
}

/** Resolve the current HEAD hash, or null outside a repository. */
export async function gitHead(root) {
  const out = await git(root, ['rev-parse', 'HEAD']);
  return out ? out.trim() || null : null;
}

/** Resolve a graph-recorded commit or a caller-supplied git ref, without assuming it is HEAD. */
export async function resolveCommit(root, ref) {
  if (!ref || typeof ref !== 'string' || ref.startsWith('-') || ref.includes('\u0000')) return null;
  if (!/^[0-9a-f]{7,40}$/i.test(ref) && !/^[A-Za-z0-9_./~^@-]+$/.test(ref)) return null;
  const out = await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  return out ? out.trim() || null : null;
}

/**
 * Collect project-scoped changes since the graph's commit plus all working-tree
 * drift. The `-- .` pathspec keeps sibling monorepo projects out of the result.
 */
export async function changedFiles(root, graphCommit) {
  const committed = [];
  if (graphCommit) {
    const resolved = await resolveCommit(root, graphCommit);
    if (resolved) {
      const out = await git(root, ['diff', '--name-only', resolved, 'HEAD', '--', '.']);
      if (out) committed.push(...out.split('\n').map((s) => s.trim()).filter(Boolean));
    }
  }
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const [bucket, args] of [
    [staged, ['diff', '--cached', '--name-only', '--', '.']],
    [unstaged, ['diff', '--name-only', '--', '.']],
    [untracked, ['ls-files', '--others', '--exclude-standard', '--', '.']],
  ]) {
    const out = await git(root, args);
    if (out) bucket.push(...out.split('\n').map((s) => s.trim()).filter(Boolean));
  }
  const isGenerated = (p) => p === '.ua' || p.startsWith('.ua/') || p === '.understand-anything' || p.startsWith('.understand-anything/');
  const clean = (list) => [...new Set(list.filter((p) => !isGenerated(p)))];
  return {
    committed: clean(committed),
    staged: clean(staged),
    unstaged: clean(unstaged),
    untracked: clean(untracked),
    all: clean([...committed, ...staged, ...unstaged, ...untracked]),
    gitAvailable: committed.length > 0 || staged.length > 0 || unstaged.length > 0 || untracked.length > 0 || (await gitHead(root)) !== null,
    graphCommitResolved: graphCommit ? (await resolveCommit(root, graphCommit)) !== null : false,
  };
}
