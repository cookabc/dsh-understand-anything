/**
 * Resolve DSH's own market-index validator (`@deepseek-ai/dsh-plugin-market-index`)
 * without depending on it. The chain looks wherever DSH actually runs:
 *   1. a plain `require` from this script's location (a local dev tree),
 *   2. the `dsh` executable on PATH — its bin is a symlink into the dsh
 *      package, so the target is realpathed to the package root and the
 *      validator nested in dsh's own dependency tree is required,
 *   3. the global node_modules implied by the running node executable.
 * `resolveValidator` returns null when every link misses; callers keep their
 * "validator unavailable" behavior then.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DSH_PACKAGE = '@deepseek-ai/dsh';
export const VALIDATOR_PACKAGE = '@deepseek-ai/dsh-plugin-market-index';

function packageNameOf(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return typeof pkg?.name === 'string' ? pkg.name : null;
  } catch { return null; }
}

/**
 * dsh bin path -> validator candidate inside dsh's own dependency tree
 * (`…/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index`),
 * or null when the bin cannot be resolved to the dsh package root.
 */
export function validatorPathFromDshBin(binPath, realpath = realpathSync, packageName = packageNameOf) {
  if (typeof binPath !== 'string' || !binPath) return null;
  let real;
  try { real = realpath(binPath); } catch { return null; }
  let dir = dirname(real);
  for (let i = 0; i < 64 && dir !== dirname(dir); i += 1) {
    if (packageName(dir) === DSH_PACKAGE) return join(dir, 'node_modules', VALIDATOR_PACKAGE);
    dir = dirname(dir);
  }
  return null;
}

/**
 * Global node_modules implied by the node executable itself
 * (`<prefix>/bin/node` -> `<prefix>/lib/node_modules`; Windows keeps it adjacent).
 */
export function globalNodeModulesFromExecPath(execPath = process.execPath, platform = process.platform) {
  const binDir = dirname(execPath);
  return platform === 'win32' ? join(binDir, 'node_modules') : join(binDir, '..', 'lib', 'node_modules');
}

function dshBinOnPath() {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    return out.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
  } catch { return null; }
}

const requireOrNull = (requireFn, id) => {
  if (id == null) return null;
  try { return requireFn(id); } catch { return null; }
};

const hasValidatorApi = (mod) => typeof mod?.parseMarketIndex === 'function' && typeof mod?.marketInstallTarget === 'function';

/**
 * The validator module, or null when every link of the chain misses. Never
 * throws, so callers can treat null as "validator unavailable".
 */
export function resolveValidator(requireFn = createRequire(import.meta.url), dshBin = dshBinOnPath, dshTreePath = validatorPathFromDshBin) {
  const direct = requireOrNull(requireFn, VALIDATOR_PACKAGE);
  if (hasValidatorApi(direct)) return direct;
  const fromDsh = requireOrNull(requireFn, dshTreePath(dshBin()));
  if (hasValidatorApi(fromDsh)) return fromDsh;
  const globalRoot = globalNodeModulesFromExecPath();
  try {
    const resolved = requireFn.resolve(VALIDATOR_PACKAGE, { paths: [join(globalRoot, DSH_PACKAGE), globalRoot] });
    const viaGlobal = requireOrNull(requireFn, resolved);
    if (hasValidatorApi(viaGlobal)) return viaGlobal;
  } catch { /* no dsh in the global tree either */ }
  return null;
}
