/** Pure remote parser tests; GitHub network and host credentials are never used. */
import { githubRemote } from '../lib/github-remote.js';

const accepted = [
  ['git@github.com:PaiMonCai/dsh-source-control.git', 'PaiMonCai/dsh-source-control'],
  ['ssh://git@github.com/PaiMonCai/dsh-source-control.git', 'PaiMonCai/dsh-source-control'],
  ['https://github.com/PaiMonCai/dsh-source-control.git', 'PaiMonCai/dsh-source-control'],
  ['https://github.com/PaiMonCai/dsh-source-control', 'PaiMonCai/dsh-source-control'],
];
const rejected = [
  'https://secret:token@github.com/owner/repo.git',
  'https://token@github.com/owner/repo.git',
  'https://github.com.evil.invalid/owner/repo',
  'https://github.com/owner/repo?access_token=secret',
  'https://github.com/owner/repo#token',
  'http://github.com/owner/repo',
  'git://github.com/owner/repo',
  'ssh://root@github.com/owner/repo',
  'ssh://git@github.com:2222/owner/repo',
  'git@github.com:owner/../repo',
  'git@github.com:owner/repo/extra',
  'git@github.com:owner/%2e%2e',
  'git@github.com:owner/repo\\bad',
  'git@github.com:owner/repo\n',
  'git@gitlab.com:owner/repo',
  '/tmp/remote.git',
  '',
  null,
];
let checks = 0;
for (const [value, slug] of accepted) {
  const result = githubRemote(value);
  if (result?.url !== `https://github.com/${slug}` || result.pullsUrl !== `https://github.com/${slug}/pulls` || result.issuesUrl !== `https://github.com/${slug}/issues`) {
    throw new Error(`expected GitHub navigation for ${value}: ${JSON.stringify(result)}`);
  }
  checks++;
}
for (const value of rejected) {
  if (githubRemote(value) !== null) throw new Error(`unsafe remote accepted: ${String(value)}`);
  checks++;
}
console.log(`ok   ${checks} GitHub remote navigation cases`);
