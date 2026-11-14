/** Spawned by scanner.test.mjs with a JSON job list on stdin. Runs
 *  pathological extractor inputs and hostile meta-file shapes in an isolated
 *  process: a quadratic-backtracking regression dies via the parent's timeout
 *  instead of hanging the whole suite, and FIFO opens cannot poison the
 *  runner's threadpool. Prints one JSON line of `{ case: ms | "THROW:..." }`;
 *  scan cases add a `<case>|aliasesNull` boolean companion key.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractCallSites, extractImports, extractSymbols, scanProject } from '../lib/scanner.mjs';

const jobs = JSON.parse(readFileSync(0, 'utf8'));
const out = {};
for (const job of jobs) {
  const t = performance.now();
  try {
    if (job.kind === 'extract') {
      extractSymbols(job.text, job.lang);
      extractImports(job.text, job.lang);
      extractImports(job.text, job.lang, true);
      extractCallSites(job.text, job.lang);
      out[job.name] = Math.round(performance.now() - t);
    } else {
      const dir = mkdtempSync(join(tmpdir(), 'ua-patho-'));
      try {
        writeFileSync(join(dir, job.file === 'go.mod' ? 'a.go' : 'a.ts'), 'x\n');
        if (job.kind === 'fifo') {
          execFileSync('mkfifo', [join(dir, job.file)]);
        } else {
          execFileSync('mkfifo', [join(dir, 'real.fifo')]);
          symlinkSync(join(dir, 'real.fifo'), join(dir, job.file));
        }
        const scan = await scanProject(dir);
        out[job.name] = Math.round(performance.now() - t);
        out[`${job.name}|aliasesNull`] = scan.aliases === null;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } catch (e) {
    out[job.name] = 'THROW:' + e.constructor.name;
  }
}
console.log(JSON.stringify(out));
