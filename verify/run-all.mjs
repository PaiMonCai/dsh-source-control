/**
 * Run every verification suite and report one combined result.
 *
 * `npm test` and the release workflow both call this, so CI and a human run the
 * same checks rather than two drifting approximations of them.
 *
 * Each suite is a standalone script that prints `ok`/`FAIL` per assertion and
 * exits non-zero on failure. Suites run in order, and the first failure does NOT
 * stop the rest: a contributor wants the whole picture, not the first problem.
 *
 * Run with:
 *
 *     npm test
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Every suite, in the order a reader should see them: behaviour first, packaging last. */
const SUITES = [
  'git-layer',
  'repository-operations',
  'github-remote',
  'github-api',
  'routes',
  'repository-routes',
  'apply',
  'client-bundle',
  'client-render',
  'hardening',
  'tools',
  'hunks',
  'release',
];

/**
 * Run one suite and collect its tail.
 * @param {string} name - the suite file stem.
 * @returns {Promise<{name: string, code: number, tail: string}>} the outcome.
 */
function run(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, `${name}.mjs`)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (code) => {
      const lines = out.trimEnd().split('\n');
      const failures = lines.filter((line) => line.startsWith('FAIL'));
      // A pass reports its own count line. A failure keeps its FAIL lines, and a
      // suite that died without printing one (an assertion helper throwing, a
      // timeout) shows its tail instead of a bare count with no reason.
      const last = lines.filter((line) => line.trim() !== '').at(-1) ?? '(no output)';
      const tail = (code ?? 1) === 0 ? last : (failures.length > 0 ? failures.join('\n') : lines.slice(-6).join('\n'));
      resolve({ name, code: code ?? 1, tail });
    });
  });
}

let failed = 0;
let total = 0;

for (const name of SUITES) {
  const result = await run(name);
  total += 1;
  if (result.code !== 0) failed += 1;
  const mark = result.code === 0 ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${result.name.padEnd(14)} ${result.tail.split('\n')[0]}`);
  if (result.code !== 0) {
    for (const line of result.tail.split('\n').slice(1)) console.log(`         ${line}`);
  }
}

console.log(`\n${total - failed}/${total} suites passed`);
process.exit(failed === 0 ? 0 : 1);
