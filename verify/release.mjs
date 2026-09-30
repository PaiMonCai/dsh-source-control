/**
 * Pre-release gate: the package is coherent enough to install and publish.
 *
 * The other suites test behaviour. This one tests the PACKAGE, because the
 * failure modes here are the ones that make a bundle silently uninstallable: the
 * client bundle registering under an id the profile never asks for, a runtime
 * file the `files` list omits from the tarball, a patch row whose module name
 * does not resolve, or copy that only exists in one language.
 *
 * Run with:
 *
 *     node verify/release.mjs
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let failures = 0;
let checks = 0;

/**
 * Assert one condition.
 * @param {boolean} condition - the condition.
 * @param {string} label - what is asserted.
 * @param {unknown} [detail] - extra context on failure.
 */
function check(condition, label, detail = undefined) {
  checks += 1;
  if (condition) {
    console.log(`ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
}

/**
 * Read and parse a JSON file.
 * @param {string} relative - path relative to the package root.
 * @returns {Promise<any>} the parsed value.
 */
const json = async (relative) => JSON.parse(await readFile(join(root, relative), 'utf8'));

/**
 * Assert a path exists.
 * @param {string} relative - path relative to the package root.
 * @returns {Promise<boolean>} whether it exists.
 */
async function exists(relative) {
  try {
    await stat(join(root, relative));
    return true;
  } catch {
    return false;
  }
}

const pkg = await json('package.json');
console.log(`# ${pkg.name}@${pkg.version}\n`);

// ---------------------------------------------------------------------------
console.log('## manifest');
check(pkg.name === 'dsh-source-control', 'the package name is dsh-source-control', pkg.name);
check(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version), 'the version is semver', pkg.version);
check(pkg.type === 'module', 'the package is ESM', pkg.type);
check(pkg.license === 'MIT', 'the declared licence is MIT', pkg.license);
check(await exists('LICENSE'), 'the LICENSE file the declaration refers to exists');
check(await exists('README.md'), 'a README exists');
// The code uses AbortSignal.any, which arrived in Node 20.3.
check(
  typeof pkg.engines?.node === 'string' && pkg.engines.node.includes('20.3'),
  'engines.node states the real floor (AbortSignal.any needs 20.3)',
  pkg.engines,
);
check(pkg.private !== false, 'the package stays private: it is installed as a bundle, not published to npm');

console.log('\n## bundle wiring');
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'the bundle declares its patch file', pkg.dsh?.bundle);
check(pkg.dsh?.client?.platform === 'web', 'the client half targets the web platform', pkg.dsh?.client);
check(Array.isArray(pkg.dsh?.client?.inject), 'the client half declares its package ordering', pkg.dsh?.client?.inject);
for (const name of pkg.dsh?.client?.inject ?? []) {
  check(typeof name === 'string' && name.startsWith('@deepseek-ai/'), `client inject entry is a package name: ${name}`);
}

console.log('\n## the patch row resolves');
const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
check(/^-\s*insert:/m.test(patch), 'the patch inserts a row');
check(
  new RegExp(`name:\\s*${pkg.name.replace(/[/@.]/g, '\\$&')}\\b`).test(patch),
  'the inserted row names this package, so the loader can resolve it',
);
const rowId = /-\s*id:\s*(\S+)/.exec(patch)?.[1];
check(typeof rowId === 'string' && rowId.length > 0, 'the inserted row has an id', rowId);
// Every config field must be one the plugin accepts, or activation throws.
const configFields = [...patch.matchAll(/^\s{8}([a-zA-Z]+):/gm)].map((match) => match[1]);
const known = new Set(['timeoutMs', 'maxOutputBytes', 'maxDiffLines', 'maxLogEntries']);
for (const field of configFields) check(known.has(field), `patch config field is a known plugin field: ${field}`);

console.log('\n## exports and files');
for (const [key, target] of Object.entries(pkg.exports ?? {})) {
  const path = typeof target === 'string' ? target : target?.default;
  check(typeof path === 'string' && (path.includes('*') || (await exists(path))), `exports["${key}"] resolves`, path);
}
check(await exists(pkg.icon ?? ''), 'the declared icon exists', pkg.icon);
// Every runtime file must be matched by `files`, or the tarball ships broken.
const shipped = [
  'lib/index.js',
  'lib/tool.js',
  'lib/routes.js',
  'lib/service.js',
  'lib/git.js',
  'lib/repo.js',
  'lib/client.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
];
const covered = (file) =>
  (pkg.files ?? []).some((pattern) => {
    if (pattern === file) return true;
    if (!pattern.includes('*')) return false;
    return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(file);
  });
for (const file of shipped) check(covered(file), `files covers the shipped runtime file: ${file}`);
// Tests must NOT ship to consumers.
check(
  (pkg.files ?? []).every((pattern) => !pattern.startsWith('verify')),
  'the verification suites are not shipped in the tarball',
  pkg.files,
);

console.log('\n## the client bundle registers under the right id');
const client = await readFile(join(root, 'lib/client.js'), 'utf8');
const clientId = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(client)?.[1];
check(clientId === pkg.name, 'the client bundle id equals the package name (or the profile never loads it)', clientId);
check(/require\('react'\)/.test(client), 'the client half requires react');
const requires = [...client.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
check(
  requires.every((name) => name === 'react' || name.startsWith('react/')),
  'the client half requires nothing but react, so it cannot break a profile',
  requires,
);
check(!/dsh-client-ui-primitives/.test(client), 'the client half does not import a Harness Client package');
check(!/document\.body/.test(client), 'the client half writes nothing to document.body');

console.log('\n## locales cover the same keys');
const en = await json('locale/en.json');
const zh = await json('locale/zh.json');
for (const field of ['title', 'description']) {
  check(typeof en[field] === 'string' && en[field].length > 0, `en.json has a ${field}`);
  check(typeof zh[field] === 'string' && zh[field].length > 0, `zh.json has a ${field}`);
}

console.log('\n## the test entry point and the workflows');
check(typeof pkg.scripts?.test === 'string', 'package.json declares a test script', pkg.scripts);
const testTarget = /node\s+(\S+)/.exec(pkg.scripts?.test ?? '')?.[1];
check(typeof testTarget === 'string', 'the test script invokes a file', pkg.scripts?.test);
check(typeof testTarget === 'string' && (await exists(testTarget)), `the test script's target exists: ${testTarget}`);
// The workflow files are the release path; their absence is silent otherwise.
check(await exists('.github/workflows/ci.yml'), 'the CI workflow exists');
check(await exists('.github/workflows/release.yml'), 'the release workflow exists');
const release = await readFile(join(root, '.github/workflows/release.yml'), 'utf8');
check(/tags:\s*\['v\*'\]/.test(release), 'the release workflow triggers on a v* tag');
check(/contents:\s*write/.test(release), 'the release workflow may write release contents');
check(/gh release create/.test(release), 'the release workflow creates a GitHub Release');
const ci = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');
check(/npm test/.test(ci), 'CI runs the same npm test a human runs');
check(/engines\.node|AbortSignal\.any/.test(ci), 'CI states or asserts the runtime floor');

console.log('\n## the network-git boundary holds');
for (const file of ['lib/git.js', 'lib/routes.js', 'lib/tool.js']) {
  const source = await readFile(join(root, file), 'utf8');
  for (const verb of ['fetch', 'pull', 'push', 'remote', 'clone']) {
    const pattern = new RegExp(`['"\`]${verb}['"\`]`);
    check(!pattern.test(source), `${file} runs no \`git ${verb}\``);
  }
}

console.log('\n## discard stays human-only');
const { ACTIONS } = await import('../lib/tool.js');
check(!ACTIONS.includes('discard'), 'no whole-file discard action');
check(!ACTIONS.includes('discard-hunk'), 'no hunk discard action');
check(!ACTIONS.some((action) => action.includes('discard')), 'no discard action under any name', ACTIONS);

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
