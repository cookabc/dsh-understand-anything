/**
 * Git post-commit auto-update hook management.
 * The hook runs a deterministic incremental rescan with no LLM and no network.
 * `ua_auto_update` is the in-session equivalent.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readConfig, writeConfig } from './graph.mjs';

const run = promisify(execFile);
export const HOOK_MARKER = '# dsh-understand-anything post-commit hook (managed)';

async function git(root, args) {
  try {
    const { stdout } = await run('git', ['-C', root, ...args], { timeout: 10_000, encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Resolve the hooks directory through git, so worktrees are handled too. */
export async function resolveHooksDir(root) {
  const out = await git(root, ['rev-parse', '--git-path', 'hooks']);
  if (!out) return null;
  return resolve(root, out);
}

export async function hookStatus(root, pluginRoot = '') {
  const isRepo = (await git(root, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  const hooksDir = isRepo ? await resolveHooksDir(root) : null;
  const hookPath = hooksDir ? join(hooksDir, 'post-commit') : null;
  let installed = false;
  let originalBackedUp = false;
  if (hookPath) {
    try {
      installed = (await readFile(hookPath, 'utf8')).includes(HOOK_MARKER);
    } catch { /* absent */ }
    try {
      await readFile(`${hookPath}.ua-original`, 'utf8');
      originalBackedUp = true;
    } catch { /* absent */ }
  }
  const config = await readConfig(root);
  return {
    gitRepository: isRepo,
    hooksDir,
    hookPath,
    pluginRoot,
    originalBackedUp,
    installed,
    autoUpdate: config.autoUpdate === true,
  };
}

function hookScript(pluginRoot) {
  const cli = join(pluginRoot, 'bin', 'ua-post-commit.mjs');
  return `#!/bin/sh
${HOOK_MARKER}
# Reinstall with ua_hook({ action: "install" }) after moving the plugin source.
# A pre-existing hook is preserved as post-commit.ua-original and chained first.
HOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ORIGINAL="\${HOOK_DIR}/post-commit.ua-original"
STATUS=0
if [ -x "\${ORIGINAL}" ]; then
  "\${ORIGINAL}" "\$@" || STATUS=\$?
fi
if command -v node >/dev/null 2>&1; then
  node ${"'" + cli.replaceAll("'", "'\"'\"'") + "'"} >/dev/null 2>&1 || true
fi
exit \${STATUS}
`;
}

/** Install (or refresh) the hook. Never destroys a pre-existing hook. */
export async function installHook(root, pluginRoot) {
  const status = await hookStatus(root, pluginRoot);
  if (!status.gitRepository || !status.hookPath) {
    return { ok: false, error: 'NOT_A_GIT_REPOSITORY' };
  }
  await mkdir(status.hooksDir, { recursive: true });
  if (!status.installed && !status.originalBackedUp) {
    try {
      const existing = await readFile(status.hookPath, 'utf8');
      if (existing.trim()) {
        await writeFile(`${status.hookPath}.ua-original`, existing, 'utf8');
        await chmod(`${status.hookPath}.ua-original`, 0o755);
      }
    } catch { /* no existing hook */ }
  }
  const tmp = `${status.hookPath}.ua-${process.pid}.tmp`;
  await writeFile(tmp, hookScript(pluginRoot), 'utf8');
  await chmod(tmp, 0o755);
  await rename(tmp, status.hookPath);
  const config = await writeConfig(root, { autoUpdate: true });
  return {
    ok: true,
    hookPath: status.hookPath,
    pluginRoot,
    originalBackedUp: (await hookStatus(root, pluginRoot)).originalBackedUp,
    autoUpdate: config.autoUpdate,
  };
}

/** Remove the hook, restoring any pre-existing one. */
export async function uninstallHook(root) {
  const status = await hookStatus(root);
  if (!status.hookPath) return { ok: false, error: 'NOT_A_GIT_REPOSITORY' };
  if (!status.installed) return { ok: true, removed: false, reason: 'NOT_INSTALLED' };
  if (status.originalBackedUp) {
    await rename(`${status.hookPath}.ua-original`, status.hookPath);
    await chmod(status.hookPath, 0o755);
  } else {
    await unlink(status.hookPath);
  }
  await writeConfig(root, { autoUpdate: false });
  return { ok: true, removed: true, restoredOriginal: status.originalBackedUp };
}

/** Enable or disable auto-update without touching the hook file. */
export async function setAutoUpdate(root, enabled) {
  const config = await writeConfig(root, { autoUpdate: Boolean(enabled) });
  return { ok: true, autoUpdate: config.autoUpdate };
}
