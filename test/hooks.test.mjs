import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { hookStatus, installHook, uninstallHook, HOOK_MARKER } from '../lib/hooks.mjs';

function fakeCtx() {
  const tools = new Map();
  const ctx = {
    inject(_deps, cb) {
      cb({ tools: { register: (def) => { tools.set(def.name, def); return () => {}; } }, skills: { register: () => () => {} } });
    },
  };
  apply(ctx, {});
  return tools;
}

const call = async (tools, toolName, args = {}) =>
  JSON.parse(await tools.get(toolName).execute(args, {}));

const git = (root, args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'ua-hooks-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/a.js'), 'export function alpha() { return 1; }\n');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'ua@example.test']);
  git(root, ['config', 'user.name', 'UA Test']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial']);
  return root;
}

test('ua_hook: status, install, chaining an existing hook, uninstall', async () => {
  const root = await repo();
  try {
    const original = '#!/bin/sh\necho pre-existing-hook\n';
    await writeFile(join(root, '.git/hooks/post-commit'), original, { mode: 0o755 });

    const before = await hookStatus(root, '/tmp/ua-plugin');
    assert.equal(before.gitRepository, true);
    assert.equal(before.installed, false);

    const installed = await installHook(root, '/tmp/ua-plugin');
    assert.equal(installed.ok, true);
    assert.equal(installed.autoUpdate, true);
    assert.equal(installed.originalBackedUp, true);
    const hook = await readFile(installed.hookPath, 'utf8');
    assert.ok(hook.includes(HOOK_MARKER));
    assert.ok(hook.includes('post-commit.ua-original'));
    assert.equal(await readFile(`${installed.hookPath}.ua-original`, 'utf8'), original);

    const status = await hookStatus(root, '/tmp/ua-plugin');
    assert.equal(status.installed, true);
    assert.equal(status.autoUpdate, true);

    const removed = await uninstallHook(root);
    assert.equal(removed.ok, true);
    assert.equal(removed.restoredOriginal, true);
    assert.equal(await readFile(join(root, '.git/hooks/post-commit'), 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('post-commit hook refreshes the graph and never fails a commit', async () => {
  const root = await repo();
  try {
    const tools = fakeCtx();
    const scanned = await call(tools, 'ua_scan', { root });
    assert.equal(scanned.ok, true);
    const firstCommit = git(root, ['rev-parse', 'HEAD']).trim();

    const install = await call(tools, 'ua_hook', { root, action: 'install' });
    assert.equal(install.ok, true);

    const graphPath = join(root, '.ua/knowledge-graph.json');
    assert.equal(JSON.parse(await readFile(graphPath, 'utf8')).project.gitCommitHash, firstCommit);
    assert.ok(await readFile(join(root, '.ua/meta.json'), 'utf8'));

    // A second commit must trigger the installed hook and refresh the graph.
    await writeFile(join(root, 'src/b.js'), 'export function beta() { return 2; }\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'add beta']);
    const secondCommit = git(root, ['rev-parse', 'HEAD']).trim();
    assert.notEqual(secondCommit, firstCommit);

    const refreshed = JSON.parse(await readFile(graphPath, 'utf8'));
    assert.equal(refreshed.project.gitCommitHash, secondCommit);
    assert.ok(refreshed.nodes.some((n) => n.id === 'file:src/b.js'));
    assert.ok(refreshed.meta.stats.rebuiltNodes >= 1);

    const check = await call(tools, 'ua_auto_update', { root, apply: false });
    assert.equal(check.stale, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ua_hook refuses non-repositories and unknown actions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ua-no-git-'));
  try {
    const tools = fakeCtx();
    const status = await call(tools, 'ua_hook', { root, action: 'status' });
    assert.equal(status.gitRepository, false);
    const install = await call(tools, 'ua_hook', { root, action: 'install' });
    assert.equal(install.error, 'NOT_A_GIT_REPOSITORY');
    const bad = await call(tools, 'ua_hook', { root, action: 'explode' });
    assert.equal(bad.error, 'UNKNOWN_HOOK_ACTION');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('hook quotes plugin paths literally instead of evaluating shell substitutions', async () => {
  const root = await repo();
  try {
    const pluginRoot = join(root, "plugin ' $(touch INJECTED)");
    await mkdir(join(pluginRoot, 'bin'), { recursive: true });
    await writeFile(join(pluginRoot, 'bin/ua-post-commit.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('HOOK_RAN', 'yes');");
    const installed = await installHook(root, pluginRoot);
    execFileSync('sh', [installed.hookPath], { cwd: root });
    assert.equal(await readFile(join(root, 'HOOK_RAN'), 'utf8'), 'yes');
    await assert.rejects(readFile(join(root, 'INJECTED')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
